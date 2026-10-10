/**
 * Connection strings for the database service types (Redis, PostgreSQL,
 * MariaDB): resolution, validation, and masking for the API.
 */
import { DSN_PROTOCOLS, type FleetServiceType } from './service-types.js';

/** Shown in place of a DSN password; sent back unchanged it keeps the stored one. */
export const DSN_PASSWORD_MASK = '********';

const PASSWORD_OPTIONS = new Set(['password', 'pass']);

/**
 * The service's own DSN, else the `<TYPE>_ADMIN_DSN` fallback. The fallback is
 * a single-instance convenience: it never overrides a DSN set on the service.
 */
export function resolveServiceDsn(service: { metricsUrl: string | null }, envName: string): string | null {
  const own = service.metricsUrl?.trim();
  if (own) return own;
  const fallback = process.env[envName]?.trim();
  return fallback || null;
}

export function isDsnFor(serviceType: FleetServiceType, value: string | null | undefined): value is string {
  const protocols = DSN_PROTOCOLS[serviceType];
  if (!protocols || typeof value !== 'string') return false;
  const scheme = /^([a-z][a-z0-9+.-]*:)\/\//i.exec(value.trim())?.[1]?.toLowerCase();
  return scheme !== undefined && protocols.includes(scheme);
}

export function maskDsnPassword(value: string | null): string | null {
  if (!value) return value;
  try {
    const url = new URL(value);
    if (url.password) url.password = DSN_PASSWORD_MASK;
    for (const key of new Set(url.searchParams.keys())) {
      if (PASSWORD_OPTIONS.has(key.toLowerCase())) url.searchParams.set(key, DSN_PASSWORD_MASK);
    }
    return url.href;
  } catch {
    return '[invalid connection string]';
  }
}

/** Put the stored password back where an edit sent the mask. */
export function restoreDsnPassword(incoming: string, stored: string | null): string {
  let url: URL;
  try { url = new URL(incoming); } catch { throw new Error('Connection string must be a valid URL'); }
  let previous: URL | null = null;
  try { previous = stored ? new URL(stored) : null; } catch { /* A replacement can repair a malformed saved DSN. */ }
  if (url.password === DSN_PASSWORD_MASK && previous?.password) url.password = previous.password;
  for (const key of new Set(url.searchParams.keys())) {
    if (PASSWORD_OPTIONS.has(key.toLowerCase()) && url.searchParams.get(key) === DSN_PASSWORD_MASK && previous?.searchParams.has(key)) url.searchParams.set(key, previous.searchParams.getAll(key).at(-1)!);
  }
  return url.href;
}

/** A fleet service as the API returns it: a database DSN's password masked. */
export function toPublicFleetService<T extends { serviceType: FleetServiceType; metricsUrl: string | null }>(service: T): T {
  return DSN_PROTOCOLS[service.serviceType] ? { ...service, metricsUrl: maskDsnPassword(service.metricsUrl) } : service;
}
