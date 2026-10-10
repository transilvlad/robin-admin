/**
 * Security middleware for IP policy, API keys, CSRF, and ingestion auth.
 */

import crypto from 'crypto';
import dns from 'node:dns/promises';
import { Request, Response, NextFunction } from 'express';
import ipaddr from 'ipaddr.js';
import { getConfig, getConfigValue } from '../db/queries/config.js';
import { getAdminById } from '../db/queries/admins.js';
import { findActiveIpJailMatch, getApiKeyByToken, hashSecret, touchApiKey, type ApiKeyWithHash } from '../db/queries/security.js';
import { logger } from '../logger.js';
import type { AdminRole } from '../types/index.js';

declare global {
  namespace Express {
    interface Request {
      apiKey?: ApiKeyWithHash;
      apiKeyAuthError?: string;
    }
  }
}

const roleHierarchy: Record<AdminRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
};

function getRequestIp(req: Request): string {
  const ip = req.socket.remoteAddress || 'unknown';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

// A reverse proxy on the same host (nginx, Caddy) always connects from
// loopback, so loopback is a trusted proxy even when none are configured.
// Without this, every proxied visitor looks like 127.0.0.1: one shared rate
// limit and jail bucket, and a pass through loopback allowlists such as report
// ingestion.
const LOOPBACK_PROXY_CIDRS = ['127.0.0.0/8', '::1/128'];

export async function getTrustedClientIp(req: Request): Promise<string> {
  const cfg = await getConfig();
  const trustedProxyCidrs = [...LOOPBACK_PROXY_CIDRS, ...parseList(cfg.trustedProxyCidrs)];

  const remoteIp = getRequestIp(req);
  if (!ipMatchesCidrs(remoteIp, trustedProxyCidrs)) {
    return remoteIp;
  }

  const forwarded = req.headers?.['x-forwarded-for'];
  const header = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (!header) {
    return remoteIp;
  }

  // Proxies append the address they received the request from, so walk from
  // the nearest hop: the first address not added by a trusted proxy is the
  // client. The leftmost entries are whatever the client sent and can be forged.
  const hops = header.split(',').map((hop) => normalizeIp(hop.trim())).filter(Boolean);
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    if (!ipMatchesCidrs(hops[index], trustedProxyCidrs)) {
      return hops[index];
    }
  }
  return hops[0] ?? remoteIp;
}

export function parseList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => parseList(item));
  }
  return (value ?? '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeIp(ip: string): string {
  if (ip.startsWith('::ffff:')) {
    return ip.slice(7);
  }
  return ip;
}

/**
 * True only when the raw TCP connection itself originates from loopback and
 * was not forwarded by a proxy — deliberately reads req.socket.remoteAddress
 * directly rather than going through getTrustedClientIp/X-Forwarded-For, so a
 * remote client can never pass for a local one.
 *
 * Exempts same-host report forwarding from the global API rate limiter (see
 * index.ts). Local report producers can funnel bursts through a single
 * loopback IP bucket, while the limiter is tuned for arbitrary external API
 * callers.
 */
export function isLoopbackConnection(req: Request): boolean {
  const remote = normalizeIp(req.socket.remoteAddress || '');
  // A same-host reverse proxy also connects from loopback, but it forwards
  // other clients and always adds X-Forwarded-For.
  return (remote === '127.0.0.1' || remote === '::1') && !req.headers?.['x-forwarded-for'];
}

export function ipMatchesCidrs(ip: string, cidrs: string[]): boolean {
  if (cidrs.length === 0) {
    return true;
  }

  let parsed;
  try {
    parsed = ipaddr.parse(normalizeIp(ip));
  } catch {
    return false;
  }

  return cidrs.some((cidr) => {
    try {
      if (cidr.includes('/')) {
        const [range, bits] = ipaddr.parseCIDR(cidr);
        if (parsed.kind() !== range.kind()) {
          return false;
        }
        return parsed.match(range, bits);
      }
      const addr = ipaddr.parse(cidr);
      return parsed.toNormalizedString() === addr.toNormalizedString();
    } catch {
      logger.warn('Ignoring invalid CIDR in security policy', { cidr });
      return false;
    }
  });
}

export function validateCidrOrIp(value: string): boolean {
  try {
    if (value.includes('/')) {
      ipaddr.parseCIDR(value);
      return true;
    }
    ipaddr.parse(value);
    return true;
  } catch {
    return false;
  }
}

export function hasApiKeyScope(req: Request, scope: string): boolean {
  const apiKey = req.apiKey;
  if (!apiKey || apiKey.revokedAt || (apiKey.expiresAt && apiKey.expiresAt <= new Date())) {
    return false;
  }
  const scopes = apiKey.scopes;
  const [area, action] = scope.split(':');
  return scopes.includes('*') || scopes.includes(scope) || scopes.includes(`${area}:*`) || scopes.includes(`*:${action}`);
}

export function hasApiKeyRole(req: Request, minRole: AdminRole): boolean {
  if (!req.apiKey) {
    return false;
  }
  return roleHierarchy[req.apiKey.role] >= roleHierarchy[minRole];
}

export function requiredScopeForRequest(req: Request): string {
  const method = req.method.toUpperCase();
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const base = req.baseUrl || req.path;
  const path = req.path;

  if (base.startsWith('/api/admins') || base.startsWith('/api/config') || base.startsWith('/api/robin-config')) {
    return 'admin:*';
  }
  if (base.startsWith('/api/rspamd')) {
    if (
      path === '/scan'
      || path === '/scan-file'
      || path.endsWith('/replay')
      || path.endsWith('/learn')
      || path.endsWith('/fuzzy')
    ) {
      return 'rspamd:scan';
    }
    if (path === '/scans' || /^\/scans\/\d+$/.test(path) || path === '/classifiers') {
      return write ? 'rspamd:write' : 'rspamd:read';
    }
    return 'admin:*';
  }
  if (base.startsWith('/api/security')) {
    return 'admin:*';
  }
  if (base.startsWith('/api/api-keys')) {
    return 'admin:*';
  }
  if (base.startsWith('/api/users')) {
    return write ? 'users:write' : 'users:read';
  }
  if (base.startsWith('/api/aliases')) {
    return write ? 'aliases:write' : 'aliases:read';
  }
  if (base.startsWith('/api/queue')) {
    return write ? 'queue:write' : 'queue:read';
  }
  if (base.startsWith('/api/robin')) {
    return 'mail:send';
  }
  if (base.startsWith('/api/fleet/services')) {
    return write ? 'fleet:write' : 'fleet:read';
  }
  if (base.startsWith('/api/metrics') || base.startsWith('/api/dashboard')) {
    return 'metrics:read';
  }
  if (base.startsWith('/api/reporting')) {
    return write ? 'reporting:write' : 'reporting:read';
  }
  if (base.startsWith('/api/telemetry')) {
    // Ingest keys (Vector) must not be able to change dashboards.
    if (!write) return 'telemetry:read';
    return path === '/write' || path === '/import' ? 'telemetry:write' : 'telemetry:manage';
  }
  if (base.startsWith('/api/audit')) {
    return 'audit:read';
  }
  if (base.startsWith('/api/dmarc') || base.startsWith('/api/tlsrpt') || base.startsWith('/api/forensic')) {
    return write && path === '/reports' ? 'reports:ingest' : 'reports:read';
  }
  return write ? 'api:write' : 'api:read';
}

export async function attachApiKey(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      next();
      return;
    }

    const token = auth.slice('Bearer '.length).trim();
    const apiKey = await getApiKeyByToken(token);
    if (!apiKey) {
      req.apiKeyAuthError = 'Invalid API key';
      next();
      return;
    }
    if (apiKey.revokedAt) {
      req.apiKeyAuthError = 'API key has been revoked';
      next();
      return;
    }
    if (apiKey.expiresAt && apiKey.expiresAt <= new Date()) {
      req.apiKeyAuthError = 'API key has expired';
      next();
      return;
    }

    req.apiKey = apiKey;
    await touchApiKey(apiKey.id, await getTrustedClientIp(req));
    next();
  } catch (error) {
    next(error);
  }
}

export async function enforceIpRestrictions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const cfg = await getConfig();
    const ip = await getTrustedClientIp(req);
    const globalCidrs = parseList(cfg.globalIpAllowlist);
    if (globalCidrs.length > 0 && !ipMatchesCidrs(ip, globalCidrs)) {
      res.status(403).json({ success: false, error: 'IP address is not allowed' });
      return;
    }

    if (req.apiKey?.allowedCidrs?.length && !ipMatchesCidrs(ip, req.apiKey.allowedCidrs)) {
      res.status(403).json({ success: false, error: 'API key is not allowed from this IP address' });
      return;
    }

    const sessionAdminId = req.session?.admin?.id;
    if (sessionAdminId) {
      const admin = await getAdminById(sessionAdminId);

      // A disabled or deleted account's session must not keep working.
      // Sessions are also proactively invalidated on disable/delete/
      // password-change (invalidateAdminSessions), but this check is a
      // backstop against races and pre-existing sessions from before that.
      // Never attach a restored/reused integer ID to a different person.
      if (!admin || admin.disabled || !req.session.admin?.uid || req.session.admin.uid !== admin.uid) {
        req.session.destroy(() => undefined);
        res.status(401).json({ success: false, error: 'Session no longer valid' });
        return;
      }

      if (req.session.admin) {
        req.session.admin = {
          ...req.session.admin,
          name: admin.name,
          email: admin.email,
          role: admin.role,
          allowedCidrs: admin.allowedCidrs,
        };
      }

      if (admin.allowedCidrs.length > 0 && !ipMatchesCidrs(ip, admin.allowedCidrs)) {
        res.status(403).json({ success: false, error: 'Your administrator account is not allowed from this IP address' });
        return;
      }
    }

    next();
  } catch (error) {
    next(error);
  }
}

export async function enforceIpJail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ip = await getTrustedClientIp(req);
    const jailed = await findActiveIpJailMatch(ip);
    if (!jailed) {
      next();
      return;
    }
    res.status(403).json({
      success: false,
      error: `IP is jailed by policy (${jailed.cidr})`,
    });
  } catch (error) {
    next(error);
  }
}

function ensureCsrfToken(req: Request): string {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
  }
  return req.session.csrfToken;
}

export function getCsrfToken(req: Request): string {
  return ensureCsrfToken(req);
}

export async function csrfProtection(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const cfg = await getConfig();
    if (!cfg.csrfProtectionEnabled || req.apiKey || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      next();
      return;
    }

    // Login and first setup are not authenticated session mutations.
    if (req.path === '/api/auth/login' || req.path === '/api/setup') {
      next();
      return;
    }

    if (!req.session?.admin) {
      next();
      return;
    }

    const expected = ensureCsrfToken(req);
    const provided = req.headers['x-csrf-token'];
    const providedBuffer = typeof provided === 'string' ? Buffer.from(provided) : null;
    const expectedBuffer = Buffer.from(expected);
    if (!providedBuffer || providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
      res.status(403).json({ success: false, error: 'Invalid CSRF token' });
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
}

export async function enforceSessionPolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.session?.admin || req.apiKey) {
      next();
      return;
    }

    const cfg = await getConfig();
    const now = Date.now();
    const authenticatedAt = req.session.authenticatedAt ?? now;
    const lastSeenAt = req.session.lastSeenAt ?? now;
    const idleMs = cfg.sessionTimeoutMinutes * 60 * 1000;
    const absoluteMs = Math.max(cfg.sessionTimeoutMinutes, cfg.sessionAbsoluteLifetimeMinutes) * 60 * 1000;

    if (now - lastSeenAt > idleMs || now - authenticatedAt > absoluteMs) {
      req.session.destroy(() => undefined);
      res.status(401).json({ success: false, error: 'Session expired' });
      return;
    }

    req.session.lastSeenAt = now;
    next();
  } catch (error) {
    next(error);
  }
}

export async function requireIngestionAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const cfg = await getConfig();
    const ip = await getTrustedClientIp(req);
    const allowedCidrs = parseList(cfg.ingestionAllowedCidrs);
    if (allowedCidrs.length > 0 && ipMatchesCidrs(ip, allowedCidrs)) {
      next();
      return;
    }

    if (!cfg.ingestionAuthRequired) {
      next();
      return;
    }

    if (req.apiKey && hasApiKeyScope(req, 'reports:ingest')) {
      next();
      return;
    }

    const secret = req.headers['x-robin-admin-ingest-secret'];
    const storedHash = await getConfigValue('ingestionSecretHash');
    if (typeof secret === 'string' && storedHash) {
      const providedHash = hashSecret(secret);
      const providedBuffer = Buffer.from(providedHash);
      const storedBuffer = Buffer.from(storedHash);
      if (providedBuffer.length === storedBuffer.length && crypto.timingSafeEqual(providedBuffer, storedBuffer)) {
        next();
        return;
      }
    }

    res.status(401).json({ success: false, error: 'Report ingestion authentication required' });
  } catch (error) {
    next(error);
  }
}

export function validateOutboundUrl(
  rawUrl: string,
  allowPrivate: boolean,
  protocols: readonly string[] = ['http:', 'https:']
): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'URL must be valid';
  }
  if (!protocols.includes(url.protocol)) {
    return `URL must use ${protocols.map((protocol) => protocol.slice(0, -1)).join(' or ')}`;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // A hostless DSN (postgresql://user@/db?host=/run/postgresql) is a local socket.
  if (!host && !allowPrivate) {
    return 'Private service URLs are disabled';
  }
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost'))) {
    return 'Private service URLs are disabled';
  }
  try {
    const addr = ipaddr.parse(host);
    const range = addr.range();
    if (!allowPrivate && range !== 'unicast') {
      return 'Private, loopback, link-local, multicast, and reserved IP URLs are disabled';
    }
  } catch {
    // Hostnames are resolved by the target network at request time. Block the
    // obvious local names here; deployers can still restrict egress at Caddy/Docker.
    if (!allowPrivate && ['metadata.google.internal'].includes(host)) {
      return 'Metadata service hostnames are not allowed';
    }
  }
  return null;
}

const MAX_OUTBOUND_REDIRECTS = 3;

/**
 * Whether `host` (already known not to be a literal IP) resolves to any
 * address outside the public unicast range. Fails closed: a lookup error
 * counts as disallowed, since the caller cannot verify the destination.
 */
async function hostnameResolvesToDisallowedAddress(host: string): Promise<boolean> {
  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    if (records.length === 0) {
      return true;
    }
    return records.some((record) => {
      try {
        return ipaddr.parse(record.address).range() !== 'unicast';
      } catch {
        return true;
      }
    });
  } catch {
    return true;
  }
}

/**
 * Like validateOutboundUrl, but also resolves hostnames and rejects targets
 * whose DNS answer lands in a private/loopback/link-local/reserved range.
 * validateOutboundUrl alone only catches literal IPs and a short hostname
 * denylist — it cannot see where an arbitrary hostname actually resolves.
 * Use this for any outbound request whose URL is derived from untrusted or
 * attacker-influenceable input (report data, redirect targets); the plain
 * sync check remains fine for validating admin-supplied config at save time.
 */
export async function validateOutboundUrlWithDns(rawUrl: string, allowPrivate: boolean): Promise<string | null> {
  const syncError = validateOutboundUrl(rawUrl, allowPrivate);
  if (syncError) {
    return syncError;
  }
  if (allowPrivate) {
    return null;
  }

  const host = new URL(rawUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  try {
    ipaddr.parse(host);
    return null; // literal IP already range-checked above
  } catch {
    // hostname — resolve and validate below
  }

  if (await hostnameResolvesToDisallowedAddress(host)) {
    return 'Hostname resolves to a private, loopback, link-local, or reserved IP address';
  }
  return null;
}

/**
 * Fetch a URL derived from untrusted input safely: every hop (the initial
 * URL and every redirect Location) is validated with validateOutboundUrlWithDns
 * before the request is made, and redirects are followed manually rather
 * than automatically so a malicious or compromised destination cannot
 * redirect the request past validation to an internal target. Returns null
 * if the destination is disallowed, redirects loop past the limit, or the
 * request otherwise fails — callers should treat null like any other
 * best-effort fetch failure.
 */
// Express's Response (imported above) shadows the fetch API's Response, so
// the fetch return type is named explicitly here rather than reused bare.
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

export async function safeFetch(
  rawUrl: string,
  options: { signal?: AbortSignal; headers?: Record<string, string> } = {}
): Promise<FetchResponse | null> {
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= MAX_OUTBOUND_REDIRECTS; hop++) {
    const error = await validateOutboundUrlWithDns(currentUrl, false);
    if (error) {
      logger.warn('Blocked outbound fetch to disallowed destination', { url: currentUrl, error });
      return null;
    }

    let response: FetchResponse;
    try {
      response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: options.signal,
        headers: options.headers,
      });
    } catch (fetchError) {
      logger.debug('Outbound fetch failed', { url: currentUrl, error: (fetchError as Error).message });
      return null;
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        return null;
      }
      try {
        currentUrl = new URL(location, currentUrl).toString();
      } catch {
        return null;
      }
      continue;
    }
    return response;
  }
  logger.warn('Blocked outbound fetch: too many redirects', { url: rawUrl });
  return null;
}
