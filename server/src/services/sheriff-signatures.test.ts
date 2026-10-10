import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractSheriffPublicKeys, unwrapSignedSheriffPayload, verifySignedSheriffToken } from './sheriff-signatures.js';

describe('Sheriff signed payload verification', () => {
  it('verifies Ed25519 signed base64url payload envelopes', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const catalog = {
      success: true,
      data: {
        modules: [
          {
            slug: 'robin-tools',
            displayName: 'Robin Tools',
            remoteScope: 'robinTools',
          },
        ],
      },
    };
    const signedPayload = Buffer.from(JSON.stringify(catalog)).toString('base64url');
    const signature = sign(null, Buffer.from(signedPayload, 'utf8'), privateKey).toString('base64url');

    const result = unwrapSignedSheriffPayload<typeof catalog>({
      signedPayload,
      signature,
      keyId: 'catalog-key-1',
      alg: 'Ed25519',
    }, [{ keyId: 'catalog-key-1', alg: 'Ed25519', publicKeyPem: publicKey, status: 'active' }], {
      purpose: 'catalog',
    });

    expect(result.keyId).toBe('catalog-key-1');
    expect(result.payload.data.modules[0].slug).toBe('robin-tools');
  });

  it('rejects unsigned payloads when keys are published', () => {
    expect(() => unwrapSignedSheriffPayload({ success: true }, [{
      keyId: 'catalog-key-1',
      alg: 'Ed25519',
      publicKeyPem: 'not-used',
      status: 'active',
    }], {
      purpose: 'catalog',
    })).toThrow(/unsigned/);
  });

  it('filters inactive and expired discovery keys', () => {
    const keys = extractSheriffPublicKeys([
      { keyId: 'active', alg: 'Ed25519', publicKeyPem: 'pem', status: 'active' },
      { keyId: 'disabled', alg: 'Ed25519', publicKeyPem: 'pem', status: 'disabled' },
      { keyId: 'expired', alg: 'Ed25519', publicKeyPem: 'pem', status: 'active', notAfter: '2020-01-01T00:00:00.000Z' },
    ]);

    expect(keys.map((key) => key.keyId)).toEqual(['active']);
  });

  it('accepts only online keys certified by the pinned root', () => {
    const root = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const online = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const certificatePayload = {
      keyId: 'online-1',
      alg: 'Ed25519',
      publicKeyPem: online.publicKey,
      notBefore: '2020-01-01T00:00:00.000Z',
      notAfter: '2099-01-01T00:00:00.000Z',
      purposes: ['catalog', 'lease', 'registry'],
    };
    const signedPayload = Buffer.from(JSON.stringify(certificatePayload)).toString('base64url');
    const certifiedKey = {
      keyId: 'online-1',
      alg: 'Ed25519',
      status: 'active',
      publicKeyPem: online.publicKey,
      notBefore: certificatePayload.notBefore,
      notAfter: certificatePayload.notAfter,
      certificate: {
        signedPayload,
        signature: sign(null, Buffer.from(signedPayload), root.privateKey).toString('base64url'),
        keyId: 'root-1',
        alg: 'Ed25519',
      },
    };

    expect(extractSheriffPublicKeys([certifiedKey], root.publicKey)).toHaveLength(1);
    expect(extractSheriffPublicKeys([{
      ...certifiedKey,
      certificate: {
        ...certifiedKey.certificate,
        signature: Buffer.from('invalid').toString('base64url'),
      },
    }], root.publicKey)).toHaveLength(0);
  });

  it('accepts a direct signer only when its key exactly matches the configured pin', () => {
    const trusted = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const untrusted = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const keys = [{ keyId: 'signer', alg: 'Ed25519', status: 'active', publicKeyPem: trusted.publicKey }];

    expect(extractSheriffPublicKeys(keys, trusted.publicKey)).toHaveLength(1);
    expect(extractSheriffPublicKeys(keys, untrusted.publicKey)).toHaveLength(0);
  });

  it('verifies rbsh1 signed lease tokens', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const payload = {
      moduleSlug: 'robin-qa',
      instanceFingerprint: 'f'.repeat(64),
      issuedAt: '2026-08-19T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const payloadSegment = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = sign(null, Buffer.from(payloadSegment, 'utf8'), privateKey).toString('base64url');
    const keyId = Buffer.from('lease-key-1').toString('base64url');

    const result = verifySignedSheriffToken<typeof payload>(
      `rbsh1.${payloadSegment}.${signature}.${keyId}`,
      [{ keyId: 'lease-key-1', alg: 'Ed25519', publicKeyPem: publicKey, status: 'active' }],
      { purpose: 'lease' },
    );

    expect(result.payload.moduleSlug).toBe('robin-qa');
    expect(result.keyId).toBe('lease-key-1');
    expect(() => verifySignedSheriffToken(
      `rbsh1.${payloadSegment}.${signature}`,
      [{ keyId: 'lease-key-1', alg: 'Ed25519', publicKeyPem: publicKey, status: 'active' }],
      { purpose: 'lease' },
    )).toThrow(/format is invalid/);
  });
});
