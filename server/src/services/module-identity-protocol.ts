import { createHash, timingSafeEqual } from 'node:crypto';
import type { JWK, JWTPayload } from 'jose' with { 'resolution-mode': 'import' };
import { readFileSync } from 'node:fs';

const processStartedAt = Date.now();
const requestBodies = new WeakMap<object, Buffer>();
export function captureIdentityBody(req: object, _res: object, body: Buffer): void { requestBodies.set(req, body); }
export function identityRequestBody(req: object): Buffer { return requestBodies.get(req) ?? Buffer.alloc(0); }

export const IDENTITY_TYPE = 'robin-module-identity+jwt';
export function pinnedIdentityTrust(inline: string): string {
  const file = process.env.ROBIN_ADMIN_IDENTITY_TRUST_FILE;
  return file ? readFileSync(file, 'utf8') : inline;
}
export interface IdentityTrust { issuer: string; keys: JWK[] }
export interface ModuleIdentity {
  principal: 'admin' | 'api-key';
  sub: string;
  adminId: number;
  uid?: string;
  role: 'viewer' | 'editor' | 'admin';
  name: string;
  email: string;
}
export function bodyDigest(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('base64url');
}
export function identityHeadersDigest(get: (name: string) => string | null | undefined = () => ''): string {
  return bodyDigest(Buffer.from(JSON.stringify(
    ['content-type', 'if-match', 'if-modified-since', 'if-none-match', 'if-unmodified-since', 'range', 'x-robin-instance-fingerprint']
      .map(name => [name, get(name) ?? '']),
  )));
}
export function sameSecret(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

/**
 * One verifier per backend process. Atomic consumption has no await between
 * lookup and insert. Restart rejects assertions minted before this process;
 * multi-replica backends must replace this cache with shared atomic storage.
 */
export function createIdentityVerifier(trustJson: string, audience: string, startedAt = processStartedAt) {
  const trust: IdentityTrust = JSON.parse(trustJson);
  if (!trust.issuer || !Array.isArray(trust.keys) || trust.keys.length < 1 || trust.keys.length > 3
      || trust.keys.some(key => key.kty !== 'OKP' || key.crv !== 'Ed25519' || !key.kid || !key.x || key.d)) {
    throw new Error('Invalid pinned module identity trust');
  }
  const verification = import('jose').then(jose => ({ jwtVerify: jose.jwtVerify, keySet: jose.createLocalJWKSet({ keys: trust.keys }) }));
  const consumed = new Map<string, number>();
  let sweptAt = 0;
  return async (token: string, method: string, target: string, body: Uint8Array, getHeader?: (name: string) => string | null | undefined): Promise<ModuleIdentity> => {
    if (!token || token.length > 8192) throw new Error('Missing module identity assertion');
    const { jwtVerify, keySet } = await verification;
    const { payload } = await jwtVerify(token, keySet, {
      algorithms: ['EdDSA'], issuer: trust.issuer, audience, typ: IDENTITY_TYPE,
      requiredClaims: ['sub', 'iat', 'exp', 'jti', 'principal', 'adminId', 'role', 'name', 'email', 'method', 'target', 'digest', 'headersDigest', 'issuedAtMs'],
      clockTolerance: 0,
    });
    validateIdentity(payload);
    const now = Date.now();
    if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp! - payload.iat! > 60
        || payload.exp! <= payload.iat! || payload.iat! > Math.floor(now / 1000)
        || typeof payload.issuedAtMs !== 'number' || !Number.isInteger(payload.issuedAtMs)
        || payload.issuedAtMs < startedAt || payload.issuedAtMs > now
        || Math.floor(payload.issuedAtMs / 1000) !== payload.iat
        || typeof payload.jti !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.jti)
        || payload.aud !== audience || payload.method !== method.toUpperCase() || payload.target !== target
        || payload.digest !== bodyDigest(body) || payload.headersDigest !== identityHeadersDigest(getHeader)) {
      throw new Error('Invalid module identity binding');
    }
    if (now - sweptAt >= 1000) {
      for (const [id, expiresAt] of consumed) if (expiresAt <= now) consumed.delete(id);
      sweptAt = now;
    }
    if (consumed.has(payload.jti) || consumed.size >= 50_000) throw new Error('Module identity replay or capacity exceeded');
    consumed.set(payload.jti, payload.exp! * 1000);
    return {
      principal: payload.principal as ModuleIdentity['principal'], sub: payload.sub!,
      adminId: payload.adminId as number,
      ...(payload.principal === 'admin' ? { uid: payload.sub! } : {}),
      role: payload.role as ModuleIdentity['role'], name: payload.name as string, email: payload.email as string,
    };
  };
}
function validateIdentity(payload: JWTPayload): void {
  if (!['admin', 'api-key'].includes(String(payload.principal))
      || typeof payload.sub !== 'string' || !payload.sub
      || (payload.principal === 'admin' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.sub))
      || !Number.isInteger(payload.adminId) || (payload.adminId as number) < (payload.principal === 'admin' ? 1 : 0)
      || !['viewer', 'editor', 'admin'].includes(String(payload.role))
      || typeof payload.name !== 'string' || typeof payload.email !== 'string') {
    throw new Error('Invalid module identity claims');
  }
}
