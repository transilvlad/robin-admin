/**
 * Unit tests for password hashing services.
 */

import { describe, it, expect } from 'vitest';
import {
  hashAdminPassword,
  verifyAdminPassword,
  hashMailUserPassword,
  validatePasswordStrength,
} from './password.js';

describe('password service', () => {
  describe('hashAdminPassword', () => {
    it('should hash a password', async () => {
      const hash = await hashAdminPassword('testPassword123');
      expect(hash).toMatch(/^\$2[aby]\$\d{2}\$.{53}$/);
    });

    it('should produce different hashes for same password', async () => {
      const hash1 = await hashAdminPassword('testPassword123');
      const hash2 = await hashAdminPassword('testPassword123');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyAdminPassword', () => {
    it('should verify correct password', async () => {
      const password = 'testPassword123';
      const hash = await hashAdminPassword(password);
      const result = await verifyAdminPassword(password, hash);
      expect(result).toBe(true);
    });

    it('should reject incorrect password', async () => {
      const hash = await hashAdminPassword('correctPassword');
      const result = await verifyAdminPassword('wrongPassword', hash);
      expect(result).toBe(false);
    });
  });

  describe('hashMailUserPassword', () => {
    it('should produce SHA512-CRYPT format', () => {
      const hash = hashMailUserPassword('testPassword123');
      expect(hash).toMatch(/^\{SHA512-CRYPT\}\$6\$.{16}\$.+$/);
    });

    it('should produce different hashes for same password', () => {
      const hash1 = hashMailUserPassword('testPassword123');
      const hash2 = hashMailUserPassword('testPassword123');
      expect(hash1).not.toBe(hash2);
    });

    it('should handle special characters', () => {
      const hash = hashMailUserPassword('p@$$w0rd!#%&*()');
      expect(hash).toMatch(/^\{SHA512-CRYPT\}\$6\$/);
    });

    it('should handle unicode characters', () => {
      const hash = hashMailUserPassword('pässwörd123');
      expect(hash).toMatch(/^\{SHA512-CRYPT\}\$6\$/);
    });

    it('should handle empty password', () => {
      const hash = hashMailUserPassword('');
      expect(hash).toMatch(/^\{SHA512-CRYPT\}\$6\$/);
    });
  });

  describe('validatePasswordStrength', () => {
    it('should accept strong password', () => {
      const result = validatePasswordStrength('StrongP@ss1');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject short password', () => {
      const result = validatePasswordStrength('Short1');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must be at least 8 characters long');
    });

    it('should reject password without lowercase', () => {
      const result = validatePasswordStrength('ALLUPPERCASE1');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one lowercase letter');
    });

    it('should reject password without uppercase', () => {
      const result = validatePasswordStrength('alllowercase1');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one uppercase letter');
    });

    it('should reject password without number', () => {
      const result = validatePasswordStrength('NoNumberHere');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one number');
    });

    it('should return multiple errors for weak password', () => {
      const result = validatePasswordStrength('weak');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
    });
  });
});
