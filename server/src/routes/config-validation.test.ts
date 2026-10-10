import { describe, expect, it } from 'vitest';
import {
  findInvalidCidrOrIp,
  findInvalidCorsOrigin,
  validateSessionLifetimeOrder,
} from './config-validation.js';

describe('config validation', () => {
  it('requires absolute session lifetime to cover idle timeout', () => {
    expect(validateSessionLifetimeOrder(60, 60)).toBeNull();
    expect(validateSessionLifetimeOrder(60, 1440)).toBeNull();
    expect(validateSessionLifetimeOrder(60, 30)).toBe(
      'Absolute session lifetime cannot be shorter than the idle timeout'
    );
  });

  it('identifies invalid entries in IP and CIDR lists', () => {
    expect(findInvalidCidrOrIp('203.0.113.10\n2001:db8::/32')).toBeNull();
    expect(findInvalidCidrOrIp('203.0.113.10, not-an-ip')).toBe('not-an-ip');
  });

  it('requires exact HTTP or HTTPS CORS origins', () => {
    expect(findInvalidCorsOrigin('https://admin.example.com\nhttp://localhost:5173')).toBeNull();
    expect(findInvalidCorsOrigin('https://admin.example.com/path')).toBe('https://admin.example.com/path');
    expect(findInvalidCorsOrigin('ftp://admin.example.com')).toBe('ftp://admin.example.com');
  });
});
