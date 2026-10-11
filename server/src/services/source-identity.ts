/**
 * Source identity — turning sending IPs into names an operator can act on.
 *
 * Every established DMARC product treats IP-to-service resolution as table
 * stakes; showing bare IPs is what the vendors themselves call the "manual
 * baseline". Ours resolved nothing at all: 0 of 77,936 sender rows carried a
 * provider and only 265 carried a hostname, so the sender screens were an
 * unreadable wall of addresses like `2a01:111:f403:c409::1` — which is, in fact,
 * Microsoft 365 forwarding perfectly ordinary mail.
 *
 * Resolution is deliberately cheap and cached:
 *
 *   1. Reverse DNS (PTR) for the address.
 *   2. Forward-confirmed reverse DNS — resolve the PTR name back and require it
 *      to contain the original address. PTR records are controlled by whoever
 *      owns the address block, so an unverified name must never be presented as
 *      though it were authoritative.
 *   3. The curated provider catalogue, by CIDR first and hostname second.
 *
 * Results are persisted in `source_identity` and reused, because the same few
 * hundred addresses recur across every report and re-resolving them per request
 * would be both slow and abusive to the resolvers.
 */

import { Resolver } from 'node:dns/promises';
import { query } from '../db/connection.js';
import { logger } from '../logger.js';
import { lookupProvider, providerAuthDocs, type ProviderMatch } from './provider-catalog.js';
import { getConfig } from '../db/queries/config.js';
import { sourceWhere, type AggregateScope, type Timeframe } from './reporting-aggregate.js';

/** Re-resolve an address if the cached answer is older than this. */
export const IDENTITY_TTL_DAYS = 30;
/** Concurrent DNS lookups. Kept modest to stay polite to resolvers. */
const RESOLVE_CONCURRENCY = 12;
const RESOLVE_TIMEOUT_MS = 3000;

/**
 * Reverse lookups use explicit recursive resolvers so source identity is stable
 * across host, container, and proxy DNS environments.
 */
const REVERSE_RESOLVERS = (process.env.DNS_RESOLVERS ?? '1.1.1.1,8.8.8.8,9.9.9.9')
  .split(',')
  .map((server) => server.trim())
  .filter(Boolean);

let reverseResolver: Resolver | null = null;
let resolverServers = REVERSE_RESOLVERS;
let resolveConcurrency = RESOLVE_CONCURRENCY;
let resolveTimeoutMs = RESOLVE_TIMEOUT_MS;
let identityTtlDays = IDENTITY_TTL_DAYS;

function getResolver(): Resolver {
  if (reverseResolver) return reverseResolver;
  const resolver = new Resolver({ timeout: resolveTimeoutMs, tries: 2 });
  if (resolverServers.length > 0) {
    try {
      resolver.setServers(resolverServers);
    } catch (error) {
      logger.warn('Invalid source identity resolvers, falling back to system resolver', {
        error: (error as Error).message,
      });
    }
  }
  reverseResolver = resolver;
  return resolver;
}

export interface SourceIdentity {
  ip: string;
  /** PTR hostname, whether or not it forward-confirmed. */
  ptr: string | null;
  /** True when the PTR name resolves back to this address. */
  fcrdnsVerified: boolean;
  /** Catalogue provider name, or null when unrecognised. */
  provider: string | null;
  providerCategory: string | null;
  /** Which signal identified the provider. */
  providerVia: 'rdns' | 'cidr' | null;
  authDocsUrl: string | null;
  resolvedAt: Date | null;
}

/**
 * The label to show for a source. Prefers the recognised provider, falls back
 * to a verified hostname, then an unverified one (marked as such by the caller),
 * and finally the bare address.
 */
export function displayNameFor(identity: SourceIdentity | null, ip: string): string {
  if (identity?.provider) return identity.provider;
  if (identity?.ptr) return identity.ptr;
  return ip;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

async function reverseLookup(ip: string): Promise<{ ptr: string | null; verified: boolean }> {
  const resolver = getResolver();
  const names = await withTimeout(resolver.reverse(ip), resolveTimeoutMs);
  const ptr = names?.[0]?.replace(/\.$/, '').toLowerCase() ?? null;
  if (!ptr) return { ptr: null, verified: false };

  // Forward-confirm. A PTR alone is asserted by the address block owner and is
  // trivially spoofable, so an unconfirmed name is recorded but flagged.
  const forward = await withTimeout(
    Promise.all([
      resolver.resolve4(ptr).catch(() => [] as string[]),
      resolver.resolve6(ptr).catch(() => [] as string[]),
    ]).then(([v4, v6]) => [...v4, ...v6]),
    resolveTimeoutMs
  );

  const normalized = normalizeIp(ip);
  const verified = (forward ?? []).some((address) => normalizeIp(address) === normalized);
  return { ptr, verified };
}

/** Compare addresses textually but tolerantly, so ::1 and 0:0:...:1 match. */
function normalizeIp(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed.includes(':')) return trimmed;
  try {
    const groups = trimmed.split('::');
    const head = groups[0] ? groups[0].split(':') : [];
    const tail = groups[1] ? groups[1].split(':') : [];
    const fill = groups.length > 1 ? Array(8 - head.length - tail.length).fill('0') : [];
    return [...head, ...fill, ...tail]
      .map((part) => (part === '' ? '0' : part).replace(/^0+(?=.)/, ''))
      .join(':');
  } catch {
    return trimmed;
  }
}

/** Resolve a single address from scratch, without consulting the cache. */
export async function resolveIdentity(ip: string): Promise<SourceIdentity> {
  let ptr: string | null = null;
  let fcrdnsVerified = false;

  try {
    const reverse = await reverseLookup(ip);
    ptr = reverse.ptr;
    fcrdnsVerified = reverse.verified;
  } catch (error) {
    logger.debug('Reverse lookup failed', { ip, error: (error as Error).message });
  }

  // Only a forward-confirmed hostname is trusted for identification; an
  // unverified PTR is still stored for display but must not, on its own,
  // promote a source into a recognised provider.
  const match: ProviderMatch | null = lookupProvider(fcrdnsVerified ? ptr : null, ip);

  return {
    ip,
    ptr,
    fcrdnsVerified,
    provider: match?.name ?? null,
    providerCategory: match?.category ?? null,
    providerVia: match?.via ?? null,
    authDocsUrl: match?.authDocsUrl ?? providerAuthDocs(match?.name) ?? null,
    resolvedAt: new Date(),
  };
}

interface IdentityRow {
  ip: string;
  ptr: string | null;
  fcrdns_verified: boolean | null;
  provider: string | null;
  provider_category: string | null;
  provider_via: string | null;
  auth_docs_url: string | null;
  resolved_at: Date | null;
}

function mapRow(row: IdentityRow): SourceIdentity {
  return {
    ip: row.ip,
    ptr: row.ptr,
    fcrdnsVerified: row.fcrdns_verified === true,
    provider: row.provider,
    providerCategory: row.provider_category,
    providerVia: (row.provider_via as SourceIdentity['providerVia']) ?? null,
    authDocsUrl: row.auth_docs_url,
    resolvedAt: row.resolved_at,
  };
}

function mapIdentities(rows: IdentityRow[]): Map<string, SourceIdentity> {
  const identities = new Map<string, SourceIdentity>();
  for (const row of rows) {
    const key = normalizeIp(row.ip);
    const previous = identities.get(key);
    const resolved = row.resolved_at?.getTime() ?? 0;
    const previousResolved = previous?.resolvedAt?.getTime() ?? 0;
    // Textual IPv6 aliases can have separate cache rows. The latest resolution
    // wins, with a deterministic raw-address tie-break rather than query order.
    if (!previous || resolved > previousResolved || (resolved === previousResolved && row.ip > previous.ip)) {
      identities.set(key, mapRow(row));
    }
  }
  return identities;
}

/** Cached identities for the given addresses. Missing entries are simply absent. */
export async function getIdentities(ips: string[]): Promise<Map<string, SourceIdentity>> {
  const unique = [...new Set(ips.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const result = await query<IdentityRow>(
    `SELECT si.ip, si.ptr, si.fcrdns_verified, si.provider, si.provider_category,
            si.provider_via, si.auth_docs_url, si.resolved_at
     FROM source_identity si
     JOIN unnest($1::text[]) AS addresses(ip) ON si.ip = addresses.ip`,
    [unique]
  );

  return mapIdentities(result.rows);
}

export const CANONICAL_IPV4_PATTERN = '^(0|[1-9][0-9]{0,2})([.](0|[1-9][0-9]{0,2})){3}$';

/** Read every grouping identity, but only display representatives of unnamed IPv4 networks. */
export async function getSourceWindowIdentities(
  timeframe: Timeframe,
  scope: AggregateScope = {}
): Promise<Map<string, SourceIdentity>> {
  const where = sourceWhere(timeframe, scope);
  const negative = await query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM source_identity si
       WHERE COALESCE(si.provider, '') = ''
         AND NOT (COALESCE(si.ptr, '') <> '' AND si.fcrdns_verified IS TRUE)
         AND si.ip ~ '${CANONICAL_IPV4_PATTERN}'
         AND EXISTS (SELECT 1 FROM dmarc_rollup_source_daily s
           WHERE ${where.sql} AND s.source_ip = si.ip)) AS present`, where.params
  );
  // This probe selects a query plan, not a cached fact. A concurrent identity
  // change can alter its cost, but both plans still read live scoped metadata.
  if (!negative.rows[0]?.present) {
    const result = await query<IdentityRow>(
      `SELECT si.ip, si.ptr, si.fcrdns_verified, si.provider, si.provider_category,
         si.provider_via, si.auth_docs_url, si.resolved_at FROM source_identity si
       WHERE EXISTS (SELECT 1 FROM dmarc_rollup_source_daily s
         WHERE ${where.sql} AND s.source_ip = si.ip)`, where.params
    );
    return mapIdentities(result.rows);
  }
  const result = await query<IdentityRow>(
    `WITH addresses AS MATERIALIZED (
       SELECT DISTINCT s.source_ip FROM dmarc_rollup_source_daily s WHERE ${where.sql}
     ), aliases AS (
       SELECT DISTINCT LOWER(TRIM(source_ip)) AS ip FROM addresses
       WHERE source_ip !~ '${CANONICAL_IPV4_PATTERN}'
     ), candidates AS (
       SELECT CASE WHEN a.source_ip ~ '${CANONICAL_IPV4_PATTERN}'
           AND COALESCE(si.provider, '') = ''
           AND NOT (COALESCE(si.ptr, '') <> '' AND si.fcrdns_verified IS TRUE)
           AND alias.ip IS NULL
         THEN 'net:' || split_part(a.source_ip, '.', 1) || '.' || split_part(a.source_ip, '.', 2)
           || '.' || split_part(a.source_ip, '.', 3)
         ELSE 'ip:' || a.source_ip END AS group_key,
         a.source_ip, si.ip, si.ptr, si.fcrdns_verified, si.provider, si.provider_category,
         si.provider_via, si.auth_docs_url, si.resolved_at
       FROM addresses a LEFT JOIN source_identity si ON a.source_ip = si.ip
       LEFT JOIN aliases alias ON alias.ip = a.source_ip
     ), representatives AS (
       SELECT DISTINCT ON (group_key) ip, ptr, fcrdns_verified, provider, provider_category,
         provider_via, auth_docs_url, resolved_at FROM candidates
       ORDER BY group_key, source_ip
     ) SELECT * FROM representatives WHERE ip IS NOT NULL`, where.params
  );
  return mapIdentities(result.rows);
}

/** Look up one address in the cache, keyed tolerantly. */
export function pickIdentity(
  identities: Map<string, SourceIdentity>,
  ip: string
): SourceIdentity | null {
  return identities.get(normalizeIp(ip)) ?? null;
}

async function persist(identity: SourceIdentity): Promise<void> {
  await persistMany([identity]);
}

/**
 * Bulk upsert. One statement per chunk instead of one per IP — a resolve run of
 * a thousand IPs was a thousand round trips.
 */
async function persistMany(identities: SourceIdentity[]): Promise<void> {
  if (identities.length === 0) return;
  const CHUNK = 500;
  for (let i = 0; i < identities.length; i += CHUNK) {
    const chunk = identities.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const rows = chunk.map((identity, index) => {
      const base = index * 7;
      params.push(
        identity.ip,
        identity.ptr,
        identity.fcrdnsVerified,
        identity.provider,
        identity.providerCategory,
        identity.providerVia,
        identity.authDocsUrl
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, NOW())`;
    });
    await query(
      `INSERT INTO source_identity
         (ip, ptr, fcrdns_verified, provider, provider_category, provider_via, auth_docs_url, resolved_at)
       VALUES ${rows.join(', ')}
       ON CONFLICT (ip) DO UPDATE SET
         ptr = EXCLUDED.ptr,
         fcrdns_verified = EXCLUDED.fcrdns_verified,
         provider = EXCLUDED.provider,
         provider_category = EXCLUDED.provider_category,
         provider_via = EXCLUDED.provider_via,
         auth_docs_url = EXCLUDED.auth_docs_url,
         resolved_at = NOW()`,
      params
    );
  }
}

export interface BackfillResult {
  considered: number;
  resolved: number;
  identified: number;
  failed: number;
  /** Cached identities newly matched to a catalogue provider, without DNS. */
  refreshed: number;
}

/**
 * Resolve every sending address seen in the reports that has no fresh cached
 * identity. Safe to run repeatedly; it only does work for addresses that are
 * missing or stale.
 */
export async function backfillIdentities(options: { limit?: number } = {}): Promise<BackfillResult> {
  const config = await getConfig();
  const nextServers = config.dnsResolvers.split(/[\s,]+/).map((server) => server.trim()).filter(Boolean);
  if (nextServers.join(',') !== resolverServers.join(',')) {
    resolverServers = nextServers;
    reverseResolver = null;
  }
  resolveConcurrency = Math.max(1, Math.min(100, config.sourceIdentityConcurrency));
  resolveTimeoutMs = Math.max(500, Math.min(30000, config.sourceIdentityTimeoutMs));
  identityTtlDays = Math.max(1, Math.min(3650, config.sourceIdentityTtlDays));
  const limit = Math.min(5000, Math.max(1, options.limit ?? 1000));

  const pending = await query<{ source_ip: string }>(
    `SELECT DISTINCT r.source_ip
     FROM dmarc_records r
     LEFT JOIN source_identity si ON si.ip = r.source_ip
     WHERE r.source_ip IS NOT NULL AND r.source_ip <> ''
       AND (si.ip IS NULL OR si.resolved_at < NOW() - ($1 || ' days')::interval)
     LIMIT ${limit}`,
    [String(identityTtlDays)]
  );

  const ips = pending.rows.map((row) => row.source_ip);
  const result: BackfillResult = {
    considered: ips.length,
    resolved: 0,
    identified: 0,
    failed: 0,
    refreshed: 0,
  };
  if (ips.length === 0) {
    result.refreshed = await refreshCatalogueMatches();
    return result;
  }

  // DNS resolution stays concurrency-gated; writes batch after all workers
  // finish so a thousand IPs cost one grouped INSERT instead of a thousand.
  let cursor = 0;
  const resolved: SourceIdentity[] = [];
  const workers = Array.from({ length: Math.min(resolveConcurrency, ips.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= ips.length) return;
      const ip = ips[index];
      try {
        const identity = await resolveIdentity(ip);
        resolved.push(identity);
        result.resolved += 1;
        if (identity.provider) result.identified += 1;
      } catch (error) {
        result.failed += 1;
        logger.debug('Source identity resolution failed', { ip, error: (error as Error).message });
      }
    }
  });

  await Promise.all(workers);
  await persistMany(resolved);
  result.refreshed = await refreshCatalogueMatches();
  logger.info('Source identity backfill complete', { ...result });
  return result;
}

/**
 * Re-match cached hostnames against the provider catalogue without touching DNS.
 *
 * Identities are cached for weeks, so a catalogue addition would otherwise have
 * no effect until the TTL expired — a source would keep showing as an opaque
 * hostname long after we taught the system its name. This is pure local
 * computation over rows we already hold.
 */
async function refreshCatalogueMatches(): Promise<number> {
  const stale = await query<{ ip: string; ptr: string | null; fcrdns_verified: boolean }>(
    `SELECT ip, ptr, fcrdns_verified FROM source_identity
      WHERE provider IS NULL AND fcrdns_verified = TRUE AND ptr IS NOT NULL AND ptr <> ''`
  );

  let updated = 0;
  for (const row of stale.rows) {
    const match = lookupProvider(row.ptr, row.ip);
    if (!match) continue;
    await query(
      `UPDATE source_identity
          SET provider = $2, provider_category = $3, provider_via = $4, auth_docs_url = $5
        WHERE ip = $1`,
      [
        row.ip,
        match.name,
        match.category ?? null,
        match.via ?? null,
        match.authDocsUrl ?? providerAuthDocs(match.name) ?? null,
      ]
    );
    updated += 1;
  }

  if (updated > 0) logger.info('Refreshed provider matches from catalogue', { updated });
  return updated;
}
