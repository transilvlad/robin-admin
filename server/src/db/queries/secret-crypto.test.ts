import { afterEach, describe, expect, it } from 'vitest';
import { decryptStoredSecret, encryptStoredSecret } from './secret-crypto.js';

const originalKey = process.env.ROBIN_ADMIN_ENCRYPTION_KEY;

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.ROBIN_ADMIN_ENCRYPTION_KEY;
  } else {
    process.env.ROBIN_ADMIN_ENCRYPTION_KEY = originalKey;
  }
});

describe('secret encryption', () => {
  it('round-trips secrets with the configured encryption key', () => {
    process.env.ROBIN_ADMIN_ENCRYPTION_KEY = 'a'.repeat(64);
    const encrypted = encryptStoredSecret('https://hooks.example.test/private');
    expect(encrypted).not.toContain('hooks.example.test');
    expect(decryptStoredSecret(encrypted)).toBe('https://hooks.example.test/private');
  });

  it('refuses to encrypt or decrypt without a strong enough key', () => {
    process.env.ROBIN_ADMIN_ENCRYPTION_KEY = 'a'.repeat(64);
    const encrypted = encryptStoredSecret('fleet-agent-credential');

    delete process.env.ROBIN_ADMIN_ENCRYPTION_KEY;
    expect(() => encryptStoredSecret('fleet-agent-credential')).toThrow('ROBIN_ADMIN_ENCRYPTION_KEY');
    expect(() => decryptStoredSecret(encrypted)).toThrow('ROBIN_ADMIN_ENCRYPTION_KEY');

    process.env.ROBIN_ADMIN_ENCRYPTION_KEY = 'too-short';
    expect(() => encryptStoredSecret('fleet-agent-credential')).toThrow('at least 32 characters');
  });

  it('never hands back a stored value it cannot decrypt', () => {
    process.env.ROBIN_ADMIN_ENCRYPTION_KEY = 'a'.repeat(64);
    const encrypted = encryptStoredSecret('fleet-agent-credential');

    expect(() => decryptStoredSecret('plaintext-credential')).toThrow('not a valid encrypted envelope');
    expect(() => decryptStoredSecret('{"version":1}')).toThrow('incomplete');

    process.env.ROBIN_ADMIN_ENCRYPTION_KEY = 'b'.repeat(64);
    expect(() => decryptStoredSecret(encrypted)).toThrow('could not be decrypted');
  });
});
