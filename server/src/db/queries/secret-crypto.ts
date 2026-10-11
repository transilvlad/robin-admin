import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'crypto';

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
export const ENCRYPTION_KEY_VERSION = 'v1';

interface SecretEnvelopeV1 {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

// Every persisted secret — fleet agent credentials, fleet service secrets,
// alert webhook URLs, email relay passwords — is encrypted with this one key.
// Losing or changing it makes stored secrets unreadable, so back it up.
function getEncryptionKey(): Buffer {
  const source = process.env.ROBIN_ADMIN_ENCRYPTION_KEY;
  if (!source || source.trim().length < 32) {
    throw new Error('ROBIN_ADMIN_ENCRYPTION_KEY must be set to at least 32 characters to store secrets');
  }
  return createHash('sha256').update(source).digest();
}

export function encryptStoredSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const envelope: SecretEnvelopeV1 = {
    version: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
  return JSON.stringify(envelope);
}

/**
 * Decrypt a v1 envelope. Throws when the value isn't a complete envelope or
 * doesn't decrypt with `key`: a secret is never handed back undecrypted.
 */
function decryptEnvelope(encryptedSecret: string, key: Buffer): string {
  let parsed: Partial<SecretEnvelopeV1>;
  try {
    parsed = JSON.parse(encryptedSecret) as Partial<SecretEnvelopeV1>;
  } catch {
    throw new Error('Stored secret is not a valid encrypted envelope');
  }

  if (parsed.version !== 1 || !parsed.iv || !parsed.tag || !parsed.ciphertext) {
    throw new Error('Stored secret envelope is incomplete');
  }

  const iv = Buffer.from(parsed.iv, 'base64url');
  const tag = Buffer.from(parsed.tag, 'base64url');
  const ciphertext = Buffer.from(parsed.ciphertext, 'base64url');

  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error('Stored secret envelope has invalid cryptographic fields');
  }

  try {
    const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('Stored secret could not be decrypted with ROBIN_ADMIN_ENCRYPTION_KEY');
  }
}

export function decryptStoredSecret(encryptedSecret: string): string {
  return decryptEnvelope(encryptedSecret, getEncryptionKey());
}

export function storedSecretMatches(expectedSecret: string, candidateSecret: string): boolean {
  const expected = Buffer.from(expectedSecret);
  const provided = Buffer.from(candidateSecret);
  return expected.length === provided.length && expected.length > 0 && timingSafeEqual(expected, provided);
}
