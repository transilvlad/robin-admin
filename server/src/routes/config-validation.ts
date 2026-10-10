import { parseList, validateCidrOrIp } from '../middleware/security.js';

export function validateSessionLifetimeOrder(idleMinutes: number, absoluteMinutes: number): string | null {
  if (absoluteMinutes < idleMinutes) {
    return 'Absolute session lifetime cannot be shorter than the idle timeout';
  }
  return null;
}

export function findInvalidCidrOrIp(value: string): string | null {
  return parseList(value).find((entry) => !validateCidrOrIp(entry)) ?? null;
}

export function findInvalidCorsOrigin(value: string): string | null {
  return parseList(value).find((entry) => {
    try {
      const url = new URL(entry);
      return !['http:', 'https:'].includes(url.protocol) || entry !== url.origin;
    } catch {
      return true;
    }
  }) ?? null;
}
