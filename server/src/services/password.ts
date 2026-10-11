/**
 * Password hashing services.
 * - bcrypt for admin passwords
 * - SHA512-CRYPT for mail users (Dovecot compatible)
 */

import bcrypt from 'bcrypt';
import crypto from 'crypto';

const BCRYPT_ROUNDS = 12;

/**
 * Hash an admin password using bcrypt.
 */
export async function hashAdminPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Verify an admin password against a bcrypt hash.
 */
export async function verifyAdminPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Generate a SHA512-CRYPT hash for Dovecot mail users.
 * Format: {SHA512-CRYPT}$6$salt$hash
 */
export function hashMailUserPassword(password: string): string {
  // Generate a random 16-character salt
  const saltBytes = crypto.randomBytes(12);
  const salt = saltBytes.toString('base64').replace(/[+/=]/g, '.').substring(0, 16);
  
  // SHA512-CRYPT uses $6$ prefix
  const fullSalt = `$6$${salt}$`;
  
  // Use Node.js crypto to create SHA512-CRYPT compatible hash
  // Note: This is a simplified implementation. For production, use crypt(3) or passlib
  const hash = sha512Crypt(password, salt);
  
  return `{SHA512-CRYPT}${hash}`;
}

/**
 * SHA512-CRYPT implementation compatible with glibc crypt().
 * Based on the specification from https://www.akkadia.org/drepper/SHA-crypt.txt
 */
function sha512Crypt(password: string, salt: string): string {
  const passwordBytes = Buffer.from(password, 'utf8');
  const saltBytes = Buffer.from(salt, 'utf8');
  
  // Step 1-8: Compute digest B
  let digestB = crypto.createHash('sha512');
  digestB.update(passwordBytes);
  digestB.update(saltBytes);
  digestB.update(passwordBytes);
  const hashB = digestB.digest();
  
  // Step 9-12: Compute digest A
  let digestA = crypto.createHash('sha512');
  digestA.update(passwordBytes);
  digestA.update(saltBytes);
  
  // Add bytes from B based on password length
  let remaining = passwordBytes.length;
  while (remaining > 64) {
    digestA.update(hashB);
    remaining -= 64;
  }
  digestA.update(hashB.subarray(0, remaining));
  
  // Step 11: Process password length bits
  for (let i = passwordBytes.length; i > 0; i >>= 1) {
    if (i & 1) {
      digestA.update(hashB);
    } else {
      digestA.update(passwordBytes);
    }
  }
  const hashA = digestA.digest();
  
  // Step 12-14: Compute digest P
  let digestP = crypto.createHash('sha512');
  for (let i = 0; i < passwordBytes.length; i++) {
    digestP.update(passwordBytes);
  }
  const hashP = digestP.digest();
  
  // Create P string
  const P = Buffer.alloc(passwordBytes.length);
  for (let i = 0; i < passwordBytes.length; i += 64) {
    const len = Math.min(64, passwordBytes.length - i);
    hashP.copy(P, i, 0, len);
  }
  
  // Step 15-17: Compute digest S
  let digestS = crypto.createHash('sha512');
  for (let i = 0; i < 16 + hashA[0]; i++) {
    digestS.update(saltBytes);
  }
  const hashS = digestS.digest();
  
  // Create S string
  const S = Buffer.alloc(saltBytes.length);
  for (let i = 0; i < saltBytes.length; i += 64) {
    const len = Math.min(64, saltBytes.length - i);
    hashS.copy(S, i, 0, len);
  }
  
  // Step 18-20: 5000 rounds
  let hashC = hashA;
  for (let round = 0; round < 5000; round++) {
    const digestC = crypto.createHash('sha512');
    
    if (round & 1) {
      digestC.update(P);
    } else {
      digestC.update(hashC);
    }
    
    if (round % 3 !== 0) {
      digestC.update(S);
    }
    
    if (round % 7 !== 0) {
      digestC.update(P);
    }
    
    if (round & 1) {
      digestC.update(hashC);
    } else {
      digestC.update(P);
    }
    
    hashC = digestC.digest();
  }
  
  // Step 21: Encode to base64
  const encoded = encodeBase64Crypt(hashC);
  
  return `$6$${salt}$${encoded}`;
}

/**
 * Custom base64 encoding for crypt().
 */
function encodeBase64Crypt(hash: Buffer): string {
  const b64chars = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  
  // SHA512 specific byte ordering
  const order = [
    0, 21, 42, 22, 43, 1, 44, 2, 23, 3, 24, 45,
    25, 46, 4, 47, 5, 26, 6, 27, 48, 28, 49, 7,
    50, 8, 29, 9, 30, 51, 31, 52, 10, 53, 11, 32,
    12, 33, 54, 34, 55, 13, 56, 14, 35, 15, 36, 57,
    37, 58, 16, 59, 17, 38, 18, 39, 60, 40, 61, 19,
    62, 20, 41, 63
  ];
  
  let result = '';
  for (let i = 0; i < 21; i++) {
    const idx = i * 3;
    const b0 = hash[order[idx]] || 0;
    const b1 = hash[order[idx + 1]] || 0;
    const b2 = hash[order[idx + 2]] || 0;
    
    const val = (b0 << 16) | (b1 << 8) | b2;
    
    result += b64chars[val & 0x3f];
    result += b64chars[(val >> 6) & 0x3f];
    result += b64chars[(val >> 12) & 0x3f];
    result += b64chars[(val >> 18) & 0x3f];
  }
  
  // Handle last byte
  const lastByte = hash[order[63]] || 0;
  result += b64chars[lastByte & 0x3f];
  result += b64chars[(lastByte >> 6) & 0x3f];
  
  return result;
}

/**
 * Validate password strength.
 */
export function validatePasswordStrength(password: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  
  if (password.length < 8) {
    errors.push('Password must be at least 8 characters long');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}
