import { createPublicKey, verify as verifySignature } from 'node:crypto';

// Sheriff signs catalog and lease responses as { signedPayload, signature,
// keyId, alg } (signedPayload is base64url JSON) and publishes its signing keys
// in discovery as { success, data: { publicKeys } }. Lease tokens are
// rbsh1.<payload>.<signature>.<keyId>.

export interface SheriffPublicKey {
  keyId?: string;
  alg?: string;
  publicKeyPem?: string;
  status?: string;
  notBefore?: string;
  notAfter?: string;
  certificate?: SheriffKeyCertificate;
}

export interface SheriffKeyCertificate {
  signedPayload?: string;
  signature?: string;
  keyId?: string;
  alg?: string;
}

export interface SheriffDiscoveryDocument {
  data?: {
    publicKeys?: SheriffPublicKey[];
  };
}

interface SheriffSignedEnvelope {
  signedPayload: string;
  signature: string;
  keyId: string;
  alg?: string;
}

export interface UnwrappedSheriffPayload<T> {
  payload: T;
  keyId: string;
}

function parseDate(value?: string): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function base64UrlToBuffer(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    throw new Error('Signature is not valid base64url.');
  }

  return Buffer.from(value, 'base64url');
}

function base64UrlToString(value: string): string {
  return base64UrlToBuffer(value).toString('utf8');
}

function isUsableKey(key: SheriffPublicKey, now: Date): boolean {
  const status = key.status ?? 'active';
  const notBefore = parseDate(key.notBefore);
  const notAfter = parseDate(key.notAfter);

  return status === 'active'
    && (key.alg ?? 'Ed25519') === 'Ed25519'
    && Boolean(key.keyId && key.publicKeyPem)
    && (!notBefore || notBefore.getTime() <= now.getTime())
    && (!notAfter || notAfter.getTime() > now.getTime());
}

function asEnvelope(payload: unknown): SheriffSignedEnvelope | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as Record<string, unknown>;
  return typeof record.signedPayload === 'string'
    && typeof record.signature === 'string'
    && typeof record.keyId === 'string'
    ? record as unknown as SheriffSignedEnvelope
    : null;
}

function verifyKeyCertificate(key: SheriffPublicKey, trustedRootPublicKeyPem: string): boolean {
  const certificate = key.certificate;
  if (!certificate?.signedPayload || !certificate.signature || (certificate.alg ?? 'Ed25519') !== 'Ed25519') {
    return false;
  }

  try {
    const payload = JSON.parse(base64UrlToString(certificate.signedPayload)) as {
      keyId?: string;
      alg?: string;
      publicKeyPem?: string;
      notBefore?: string;
      notAfter?: string;
      purposes?: string[];
    };
    if (
      payload.keyId !== key.keyId
      || payload.alg !== 'Ed25519'
      || payload.publicKeyPem !== key.publicKeyPem
      || payload.notBefore !== key.notBefore
      || payload.notAfter !== key.notAfter
      || !Array.isArray(payload.purposes)
      || !payload.purposes.includes('catalog')
      || !payload.purposes.includes('lease')
    ) {
      return false;
    }

    return verifySignature(
      null,
      Buffer.from(certificate.signedPayload, 'utf8'),
      createPublicKey(trustedRootPublicKeyPem),
      base64UrlToBuffer(certificate.signature),
    );
  } catch {
    return false;
  }
}

function matchesTrustedRootKey(key: SheriffPublicKey, trustedRootPublicKeyPem: string): boolean {
  if (!key.publicKeyPem) {
    return false;
  }

  try {
    const trustedKey = createPublicKey(trustedRootPublicKeyPem).export({ type: 'spki', format: 'der' });
    const discoveredKey = createPublicKey(key.publicKeyPem).export({ type: 'spki', format: 'der' });
    return Buffer.from(trustedKey).equals(Buffer.from(discoveredKey));
  } catch {
    return false;
  }
}

/**
 * The usable keys from a published list (discovery's data.publicKeys, or a
 * cached copy of it). With a trusted root configured, a key must be the root
 * itself or carry a certificate the root signed.
 */
export function extractSheriffPublicKeys(
  keys: SheriffPublicKey[] | null | undefined,
  trustedRootPublicKeyPem = '',
): SheriffPublicKey[] {
  if (!Array.isArray(keys)) {
    return [];
  }

  const now = new Date();
  return keys.filter((key) => (
    isUsableKey(key, now)
    && (!trustedRootPublicKeyPem
      || matchesTrustedRootKey(key, trustedRootPublicKeyPem)
      || verifyKeyCertificate(key, trustedRootPublicKeyPem))
  ));
}

/** Verify a signed Sheriff response and return its decoded payload. */
export function unwrapSignedSheriffPayload<T>(
  responsePayload: unknown,
  publicKeys: SheriffPublicKey[],
  options: {
    purpose: string;
  },
): UnwrappedSheriffPayload<T> {
  const envelope = asEnvelope(responsePayload);
  if (!envelope) {
    throw new Error(`Sheriff ${options.purpose} response is unsigned.`);
  }

  const key = publicKeys.find((candidate) => candidate.keyId === envelope.keyId);
  if (!key?.publicKeyPem) {
    throw new Error(`Sheriff ${options.purpose} response was signed by an unknown key.`);
  }

  let verified = false;
  try {
    verified = verifySignature(
      null,
      Buffer.from(envelope.signedPayload, 'utf8'),
      createPublicKey(key.publicKeyPem),
      base64UrlToBuffer(envelope.signature),
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new Error(`Sheriff ${options.purpose} response signature is invalid.`);
  }

  return {
    payload: JSON.parse(base64UrlToString(envelope.signedPayload)) as T,
    keyId: envelope.keyId,
  };
}

export function verifySignedSheriffToken<T>(
  token: string,
  publicKeys: SheriffPublicKey[],
  options: {
    purpose: string;
  },
): UnwrappedSheriffPayload<T> {
  const [version, payloadSegment, signatureSegment, keyIdSegment, extra] = token.split('.');
  if (version !== 'rbsh1' || !payloadSegment || !signatureSegment || !keyIdSegment || extra !== undefined) {
    throw new Error(`Sheriff ${options.purpose} token format is invalid.`);
  }

  return unwrapSignedSheriffPayload<T>({
    signedPayload: payloadSegment,
    signature: signatureSegment,
    keyId: base64UrlToString(keyIdSegment),
  }, publicKeys, options);
}
