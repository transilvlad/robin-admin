import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';
import { createIdentityVerifier, bodyDigest, identityHeadersDigest, IDENTITY_TYPE } from './module-identity-protocol.js';

const pair = generateKeyPairSync('ed25519');
const trust = JSON.stringify({ issuer: 'urn:robin-admin:test', keys: [{ ...await exportJWK(pair.publicKey), kid: 'test', alg: 'EdDSA' }] });
const body = Buffer.from('{"a":1}');
async function token(changes: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key = pair.privateKey) {
  const issuedAtMs = Date.now();
  const iat = Math.floor(issuedAtMs / 1000);
  return new SignJWT({
    sub: 'aee695ef-d8d7-4e15-a27e-e47e9b2b0ce4', principal: 'admin', adminId: 7,
    role: 'admin', name: 'Admin', email: 'admin@example.test', iss: 'urn:robin-admin:test',
    aud: 'example', iat, exp: iat + 30, jti: randomUUID(), issuedAtMs,
    method: 'POST', target: '/import?a=1', digest: bodyDigest(body), headersDigest: identityHeadersDigest(), ...changes,
  }).setProtectedHeader({ alg: 'EdDSA', typ: IDENTITY_TYPE, kid: 'test', ...header }).sign(key);
}
test('verified claims are authoritative and assertions are single use', async () => {
  const verify = createIdentityVerifier(trust, 'example', 0);
  const assertion = await token();
  const identity = await verify(assertion, 'POST', '/import?a=1', body);
  assert.equal(identity.uid, 'aee695ef-d8d7-4e15-a27e-e47e9b2b0ce4');
  assert.equal(identity.role, 'admin');
  await assert.rejects(verify(assertion, 'POST', '/import?a=1', body), /replay/);
});
for (const [label, changes] of Object.entries({
  audience: { aud: 'another-module' }, audienceArray: { aud: ['example', 'another-module'] }, issuer: { iss: 'another-host' },
  expired: { exp: 1 }, lifetime: { exp: Math.floor(Date.now() / 1000) + 120 },
  uid: { sub: '7' }, role: { role: 'superuser' }, method: { method: 'DELETE' },
  target: { target: '/another' }, digest: { digest: bodyDigest(Buffer.from('other')) },
  future: { issuedAtMs: Date.now() + 60000 }, missingNonce: { jti: '' }, headerBinding: { headersDigest: 'changed' },
})) test(`rejects invalid ${label}`, async () => {
  await assert.rejects(createIdentityVerifier(trust, 'example', 0)(await token(changes), 'POST', '/import?a=1', body));
});
test('rejects another key, unknown kid, wrong token type and unsigned input', async () => {
  const verify = createIdentityVerifier(trust, 'example', 0);
  await assert.rejects(verify(await token({}, {}, generateKeyPairSync('ed25519').privateKey), 'POST', '/import?a=1', body));
  await assert.rejects(verify(await token({}, { kid: 'unknown' }), 'POST', '/import?a=1', body));
  await assert.rejects(verify(await token({}, { typ: 'JWT' }), 'POST', '/import?a=1', body));
  await assert.rejects(verify('unsigned', 'POST', '/import?a=1', body));
});
test('restart rejects previously minted assertions', async () => {
  const assertion = await token();
  await assert.rejects(createIdentityVerifier(trust, 'example', Date.now() + 1)(assertion, 'POST', '/import?a=1', body));
});
test('API keys have independent identities without administrator UUIDs', async () => {
  const identity = await createIdentityVerifier(trust, 'example', 0)(await token({ principal: 'api-key', sub: 'api-key:3', adminId: 0 }), 'POST', '/import?a=1', body);
  assert.equal(identity.uid, undefined); assert.equal(identity.principal, 'api-key');
});
test('rejects private key material in a trust document', () => {
  assert.throws(() => createIdentityVerifier(JSON.stringify({ issuer: 'host', keys: [{ kty: 'OKP', crv: 'Ed25519', kid: 'key', x: 'x', d: 'secret' }] }), 'example'));
});
