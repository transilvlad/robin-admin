/**
 * Sources span domains and are keyed by identified service or, when unknown, address.
 * Classification buckets:
 *
 *   capable        Sending compliant mail. Nothing to do.
 *   non_compliant  Recognised or approved, but failing DMARC. This is the work.
 *   forwarder      Failing only because the receiver told us it was forwarded,
 *                  or because the operator marked it a forwarder. Benign.
 *   threat_unknown Failing, unrecognised, unapproved. Investigate.
 */

import { query } from '../db/connection.js';
import { createHash } from 'node:crypto';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import {
  addSqlBreakdown,
  emptyBreakdown,
  complianceRate,
  taxonomyResum,
  TAXONOMY_COLUMNS,
  type TaxonomyBreakdown,
  type TaxonomySqlRow,
} from './dmarc-taxonomy.js';
import { CANONICAL_IPV4_PATTERN, getSourceWindowIdentities, pickIdentity, type SourceIdentity } from './source-identity.js';
import { getOrgDomain } from './sender-enrichment.js';
import { rollupCacheKey, memo } from './reporting-cache.js';
import { runSourceRead } from './reporting-capacity.js';
import { getConfig } from '../db/queries/config.js';
import { sourceWhere, type AggregateScope, type Page, type PageRequest, type SortDirection, type Timeframe } from './reporting-aggregate.js';

export type SourceBucket = 'capable' | 'non_compliant' | 'forwarder' | 'threat_unknown';
export type SourceReviewState = 'pending' | 'authorized' | 'forwarder' | 'threat';

/** How a source acquired its name, so the UI can show how much to trust it. */
export type SourceIdentityKind = 'provider' | 'rdns_domain' | 'network' | 'address';

export interface SourceGroupKey {
  key: string;
  displayName: string;
  kind: SourceIdentityKind;
}

/**
 * Decide which group an address belongs to, and what to call it.
 *
 * A curated ESP catalogue only ever names third-party services, and most of the
 * mail here comes from the operator's own sending infrastructure — addresses
 * like 192.0.2.13 (sender.example.test) or a /24 of 198.51.100.x with no PTR
 * at all. Left ungrouped those appear as hundreds of anonymous rows, which is
 * exactly the unusable wall of IPs this rebuild exists to remove.
 *
 * So naming degrades gracefully, strongest signal first:
 *
 *   provider     Recognised in the catalogue. "Google Workspace".
 *   rdns_domain  Registrable domain of a forward-confirmed PTR, which collapses
 *                a37-8.craaza.com and a37-9.craaza.com into "craaza.com".
 *   network      No usable PTR, so group by /24 (v4) or /48 (v6). Providers
 *                allocate contiguously, so this keeps a block together instead
 *                of scattering it across 200 rows.
 *   address      Nothing else applies.
 */
export function groupKeyFor(ip: string, identity: SourceIdentity | null): SourceGroupKey {
  if (identity?.provider) {
    return { key: `provider:${identity.provider}`, displayName: identity.provider, kind: 'provider' };
  }

  // Only a forward-confirmed PTR may name a group. An unverified PTR is asserted
  // by whoever controls the address block and must not be presented as identity.
  if (identity?.ptr && identity.fcrdnsVerified) {
    const org = getOrgDomain(identity.ptr);
    if (org) {
      return { key: `rdns:${org}`, displayName: org, kind: 'rdns_domain' };
    }
  }

  const network = networkFor(ip);
  if (network) {
    return { key: `net:${network}`, displayName: network, kind: 'network' };
  }

  return { key: `ip:${ip}`, displayName: ip, kind: 'address' };
}

function networkFor(ip: string): string | null {
  const value = ip.trim();
  if (!value) return null;

  if (value.includes(':')) {
    const groups = expandIpv6(value);
    return groups ? `${groups.slice(0, 3).join(':')}::/48` : null;
  }

  const octets = value.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return null;
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

function expandIpv6(value: string): string[] | null {
  const lower = value.toLowerCase().split('%')[0];
  const halves = lower.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const tail = halves[1] ? halves[1].split(':').filter(Boolean) : [];
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array(missing).fill('0'), ...tail];
}

/**
 * A source is only judged non-compliant once enough of its mail is failing to
 * rule out incidental noise. Without this a service sending 50,000 compliant
 * messages and one failure would sit in the same bucket as one that is entirely
 * broken.
 */
export const NON_COMPLIANT_RATE_THRESHOLD = 0.02;
/** Below this absolute volume of actionable failures, a source is not flagged. */
export const NON_COMPLIANT_MIN_VOLUME = 10;
/**
 * Above this absolute volume of actionable failures a source is flagged
 * regardless of its rate.
 *
 * A pure rate test buries high-volume providers: 200 unexplained failures
 * inside an 800,000-message stream is 0.025% and would slip under the rate
 * threshold, yet it is still 200 messages nobody can account for. Real DMARC
 * products surface both the proportion and the count for exactly this reason.
 */
export const NON_COMPLIANT_ABSOLUTE_FLOOR = 100;

interface SourceClassificationPolicy {
  rateThreshold: number;
  minVolume: number;
  absoluteFloor: number;
}

export interface SourceAggregate {
  /** Stable key: provider, rDNS domain, network or address, in that order. */
  key: string;
  displayName: string;
  /** How the name was derived, so the UI can convey how much to trust it. */
  identityKind: SourceIdentityKind;
  provider: string | null;
  providerCategory: string | null;
  /** Addresses this source sends from, capped for display. */
  ips: string[];
  ipCount: number;
  ptr: string | null;
  fcrdnsVerified: boolean;
  authDocsUrl: string | null;

  breakdown: TaxonomyBreakdown;
  complianceRate: number;
  /** Share of this source's mail with a valid DKIM signature, aligned or not. */
  dkimRate: number;
  /** Share of this source's mail passing SPF, aligned or not. */
  spfRate: number;

  domains: string[];
  domainCount: number;
  reviewState: SourceReviewState;
  reviewNote: string | null;
  bucket: SourceBucket;
  /** First/last day (YYYY-MM-DD) this source appears in the window. */
  firstSeen: string | null;
  lastSeen: string | null;
}

type SourceRow = TaxonomySqlRow & {
  source_ip: string;
  ips: string[];
  ip_count: string | number;
  domains: string[] | null;
  first_seen: string | null;
  last_seen: string | null;
  dkim_ok_volume: string | number | null;
  spf_ok_volume: string | number | null;
};

/** How many domains to carry per source for display; the count is always exact. */
const DOMAIN_SAMPLE = 25;
const IP_SAMPLE = 20;
const SOURCE_VOLUME_COLUMNS = [...TAXONOMY_COLUMNS, 'dkim_ok_volume', 'spf_ok_volume'];
const canonicalIpv4 = new RegExp(CANONICAL_IPV4_PATTERN);

/**
 * Classify a source into one of the four industry buckets.
 *
 * Order matters. Operator decisions win over inference, because an operator who
 * has marked something a threat or a known forwarder should not have that
 * overturned by the next batch of reports. Below that, the receiver's own
 * forwarding annotation wins over our guesswork — if Google says it forwarded
 * the message, arguing is pointless.
 */
export function classifySource(input: {
  breakdown: TaxonomyBreakdown;
  reviewState: SourceReviewState;
  identified: boolean;
  policy?: SourceClassificationPolicy;
}): SourceBucket {
  const { breakdown, reviewState, identified } = input;
  const policy = input.policy ?? {
    rateThreshold: NON_COMPLIANT_RATE_THRESHOLD,
    minVolume: NON_COMPLIANT_MIN_VOLUME,
    absoluteFloor: NON_COMPLIANT_ABSOLUTE_FLOOR,
  };

  if (reviewState === 'threat') return 'threat_unknown';
  if (reviewState === 'forwarder') return 'forwarder';

  const nonCompliantVolume = breakdown.totalVolume - breakdown.compliantVolume;
  if (breakdown.totalVolume === 0 || nonCompliantVolume === 0) return 'capable';

  const actionable = breakdown.actionableFailureVolume;
  const actionableRate = actionable / breakdown.totalVolume;
  const failingMeaningfully =
    actionable >= policy.absoluteFloor ||
    (actionable >= policy.minVolume && actionableRate >= policy.rateThreshold);

  if (!failingMeaningfully) {
    // Everything that failed was explained by the receiver as forwarding, or the
    // volume is too small to be a signal. If forwarding dominates the failures,
    // say so rather than pretending the source is flawless.
    if (breakdown.benignRelayVolume > actionable) return 'forwarder';

    // Below the volume floor, but an unidentified source that never produced a
    // single compliant message is not "DMARC capable" in any sense — it is
    // precisely what the unknown bucket exists for. Calling it capable would be
    // the same false reassurance this rebuild set out to remove.
    if (
      actionable > 0 &&
      breakdown.compliantVolume === 0 &&
      !identified &&
      reviewState !== 'authorized'
    ) {
      return 'threat_unknown';
    }

    return 'capable';
  }

  // Genuinely failing. Whether that is work or a threat depends on whether we
  // know who it is: a recognised provider or an approved source is a
  // misconfiguration to fix, an unknown one is something to investigate.
  if (reviewState === 'authorized' || identified) return 'non_compliant';
  return 'threat_unknown';
}

export type SourceSort = 'volume' | 'compliance' | 'actionable' | 'domains' | 'name';

export interface SourceQueryOptions extends PageRequest {
  sort?: SourceSort;
  direction?: SortDirection;
  bucket?: SourceBucket | 'all';
  search?: string;
}

export interface SourcePage extends Page<SourceAggregate> {
  /**
   * Bucket tallies for the tab strip, computed from the same fold as `items`
   * so a tab can never disagree with the table under it. Reflects the search
   * filter but not the bucket filter, which is what a tab strip must do.
   */
  bucketCounts: Record<SourceBucket | 'all', number>;
}

type DerivedSource = Omit<SourceAggregate, 'reviewState' | 'reviewNote' | 'bucket'>;

/** Address rows are transient; only the completed service fold is retained. */
async function loadSourceRows(timeframe: Timeframe, scope: AggregateScope, identities: Map<string, SourceIdentity>): Promise<SourceRow[]> {
  const where = sourceWhere(timeframe, scope);
  const identityParameter = `$${where.params.length + 1}::text[]`;
  const groupParameter = `$${where.params.length + 2}::text[]`;
  const identifiedIps: string[] = [];
  const identifiedGroups: string[] = [];
  let visited = 0;
  for (const [ip, identity] of identities) {
    if (canonicalIpv4.test(ip)) {
      const group = groupKeyFor(ip, identity);
      if (group.kind === 'provider' || group.kind === 'rdns_domain') {
        identifiedIps.push(ip);
        identifiedGroups.push(group.key);
      }
    }
    if (++visited % 2048 === 0) await yieldEventLoop();
  }
  // Fold live canonical IPv4 service keys before transfer. Negative DNS cache
  // entries still share their network; IPv6/text aliases retain the Node fold.
  const networkKey = `CASE WHEN identified.group_key IS NOT NULL THEN identified.group_key
    WHEN s.source_ip ~ '${CANONICAL_IPV4_PATTERN}'
    THEN 'net:' || split_part(s.source_ip, '.', 1) || '.' || split_part(s.source_ip, '.', 2)
      || '.' || split_part(s.source_ip, '.', 3) || '.0/24'
    ELSE 'ip:' || s.source_ip END`;
  const result = await query<SourceRow>(
    `SELECT MIN(s.source_ip) AS source_ip, ${taxonomyResum('s')},
       COUNT(DISTINCT s.source_ip) AS ip_count,
       (ARRAY_AGG(DISTINCT s.source_ip ORDER BY s.source_ip))[1:${IP_SAMPLE}] AS ips,
       SUM(s.dkim_pass_volume) AS dkim_ok_volume, SUM(s.spf_pass_volume) AS spf_ok_volume,
       ARRAY_AGG(DISTINCT s.domain ORDER BY s.domain) AS domains,
       MIN(s.day)::text AS first_seen, MAX(s.day)::text AS last_seen
     FROM dmarc_rollup_source_daily s
     LEFT JOIN unnest(${identityParameter}, ${groupParameter}) AS identified(ip, group_key) ON identified.ip = s.source_ip
     WHERE ${where.sql} GROUP BY ${networkKey}
     ORDER BY MIN(s.source_ip)`, [...where.params, identifiedIps, identifiedGroups]
  );
  const domainSets = new Map<string, string[]>();
  let processed = 0;
  for (const row of result.rows) {
    // PostgreSQL SUM(bigint) returns strings; the API exposes Number counters.
    const values = row as unknown as Record<string, string | number | null>;
    for (const column of SOURCE_VOLUME_COLUMNS) values[column] = Number(values[column] ?? 0);
    if (row.domains) {
      // SQL sorts complete sets; PostgreSQL text cannot contain NUL.
      const key = row.domains.join('\0');
      const canonical = domainSets.get(key);
      if (canonical) row.domains = canonical;
      else domainSets.set(key, row.domains);
    }
    if (++processed % 2048 === 0) await yieldEventLoop();
  }
  return result.rows;
}

async function derivedSources(
  timeframe: Timeframe,
  scope: AggregateScope,
  identities: Map<string, SourceIdentity>
): Promise<DerivedSource[]> {
  const hash = createHash('sha256');
  let processed = 0;
  for (const key of [...identities.keys()].sort()) {
    hash.update(JSON.stringify([key, identities.get(key)]));
    if (++processed % 2048 === 0) await yieldEventLoop();
  }
  return memo(rollupCacheKey('sourceFold', timeframe, scope, hash.digest('hex')), async () => {
    return foldByService(await loadSourceRows(timeframe, scope, identities), identities);
  });
}

/**
 * Aggregate every sending address in the window, then fold addresses belonging
 * to the same identified service into one row.
 *
 * The fold cache is keyed by window and live identities, not by a cached raw
 * array. Cache hits do not reload the underlying address aggregates.
 */
export async function getSourceAggregates(
  timeframe: Timeframe,
  scope: AggregateScope = {},
  options: SourceQueryOptions = {}
): Promise<SourcePage> {
  return runSourceRead(() => readSourceAggregates(timeframe, scope, options));
}

async function readSourceAggregates(
  timeframe: Timeframe,
  scope: AggregateScope,
  options: SourceQueryOptions
): Promise<SourcePage> {
  // Sorting is done in Node by `sortSources`, after addresses have been folded
  // into services — ordering the raw per-address rows would order the wrong
  // things.
  const direction = options.direction === 'asc' ? 'ASC' : 'DESC';

  const [identities, reviews, config] = await Promise.all([
    getSourceWindowIdentities(timeframe, scope),
    getSourceReviews(),
    getConfig(),
  ]);
  const policy: SourceClassificationPolicy = {
    rateThreshold: config.reportingNonCompliantRateThreshold,
    minVolume: config.reportingNonCompliantMinVolume,
    absoluteFloor: config.reportingNonCompliantAbsoluteFloor,
  };

  const folded: SourceAggregate[] = (await derivedSources(timeframe, scope, identities)).map(source => {
    const review = reviews.get(source.key) ?? { state: 'pending' as SourceReviewState, note: null };
    return { ...source, reviewState: review.state, reviewNote: review.note,
      bucket: classifySource({ breakdown: source.breakdown, reviewState: review.state,
        identified: source.identityKind === 'provider' || source.identityKind === 'rdns_domain', policy }) };
  });
  const searched = applyFilters(folded, { ...options, bucket: 'all' });
  const filtered = applyFilters(searched, options);
  const sorted = sortSources(filtered, options.sort ?? 'volume', direction === 'ASC' ? 'asc' : 'desc');

  const bucketCounts: Record<SourceBucket | 'all', number> = {
    all: searched.length,
    capable: 0,
    non_compliant: 0,
    forwarder: 0,
    threat_unknown: 0,
  };
  for (const source of searched) bucketCounts[source.bucket] += 1;

  const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 50)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));

  return {
    items: sorted.slice(offset, offset + limit),
    total: sorted.length,
    limit,
    offset,
    bucketCounts,
  };
}

interface Accumulator {
  key: string;
  displayName: string;
  kind: SourceIdentityKind;
  identity: SourceIdentity | null;
  ips: Set<string>;
  ipCount: number;
  domains: Set<string>;
  breakdown: TaxonomyBreakdown;
  // YYYY-MM-DD strings; ISO dates compare correctly lexicographically.
  firstSeen: string | null;
  lastSeen: string | null;
  dkimOk: number;
  spfOk: number;
}

async function foldByService(
  rows: SourceRow[],
  identities: Map<string, SourceIdentity>
): Promise<DerivedSource[]> {
  const groups = new Map<string, Accumulator>();

  let processed = 0;
  for (const row of rows) {
    const identity = pickIdentity(identities, row.source_ip);
    const groupKey = groupKeyFor(row.source_ip, identity);

    let group = groups.get(groupKey.key);
    if (!group) {
      group = {
        key: groupKey.key,
        displayName: groupKey.displayName,
        kind: groupKey.kind,
        identity,
        ips: new Set(),
        ipCount: 0,
        domains: new Set(),
        breakdown: emptyBreakdown(),
        firstSeen: null,
        lastSeen: null,
        dkimOk: 0,
        spfOk: 0,
      };
      groups.set(groupKey.key, group);
    }

    addSqlBreakdown(group.breakdown, row);
    group.ipCount += Number(row.ip_count);
    for (const ip of row.ips) if (group.ips.size < IP_SAMPLE) group.ips.add(ip);
    for (const domain of row.domains ?? []) group.domains.add(domain);
    group.dkimOk += Number(row.dkim_ok_volume ?? 0);
    group.spfOk += Number(row.spf_ok_volume ?? 0);
    if (row.first_seen && (!group.firstSeen || row.first_seen < group.firstSeen)) {
      group.firstSeen = row.first_seen;
    }
    if (row.last_seen && (!group.lastSeen || row.last_seen > group.lastSeen)) {
      group.lastSeen = row.last_seen;
    }
    if (++processed % 2048 === 0) await yieldEventLoop();
  }

  const result: DerivedSource[] = [];
  for (const group of groups.values()) {
    const breakdown = group.breakdown;

    result.push({
      key: group.key,
      displayName: group.displayName,
      identityKind: group.kind,
      provider: group.identity?.provider ?? null,
      providerCategory: group.identity?.providerCategory ?? null,
      ips: [...group.ips].slice(0, IP_SAMPLE),
      ipCount: group.ipCount,
      ptr: group.identity?.ptr ?? null,
      fcrdnsVerified: group.identity?.fcrdnsVerified ?? false,
      authDocsUrl: group.identity?.authDocsUrl ?? null,
      breakdown,
      complianceRate: complianceRate(breakdown),
      dkimRate: breakdown.totalVolume > 0 ? group.dkimOk / breakdown.totalVolume : 0,
      spfRate: breakdown.totalVolume > 0 ? group.spfOk / breakdown.totalVolume : 0,
      domains: [...group.domains].sort().slice(0, DOMAIN_SAMPLE),
      domainCount: group.domains.size,
      firstSeen: group.firstSeen,
      lastSeen: group.lastSeen,
    });
    if (++processed % 2048 === 0) await yieldEventLoop();
  }
  return result;
}

function applyFilters(sources: SourceAggregate[], options: SourceQueryOptions): SourceAggregate[] {
  let result = sources;
  if (options.bucket && options.bucket !== 'all') {
    result = result.filter((source) => source.bucket === options.bucket);
  }
  if (options.search) {
    const needle = options.search.toLowerCase();
    result = result.filter(
      (source) =>
        source.displayName.toLowerCase().includes(needle) ||
        source.ips.some((ip) => ip.toLowerCase().includes(needle)) ||
        (source.ptr ?? '').toLowerCase().includes(needle) ||
        source.domains.some((domain) => domain.toLowerCase().includes(needle))
    );
  }
  return result;
}

function sortSources(
  sources: SourceAggregate[],
  sort: SourceSort,
  direction: SortDirection
): SourceAggregate[] {
  const sign = direction === 'asc' ? 1 : -1;
  const value = (source: SourceAggregate): number | string => {
    switch (sort) {
      case 'compliance':
        return source.complianceRate;
      case 'actionable':
        return source.breakdown.actionableFailureVolume;
      case 'domains':
        return source.domainCount;
      case 'name':
        return source.displayName.toLowerCase();
      case 'volume':
      default:
        return source.breakdown.totalVolume;
    }
  };

  return [...sources].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    if (typeof left === 'string' || typeof right === 'string') {
      return sign * String(left).localeCompare(String(right));
    }
    if (left === right) return a.displayName.localeCompare(b.displayName);
    return sign * (left - right);
  });
}

/**
 * Counts per bucket, for the tab strip.
 *
 * Prefer reading `bucketCounts` off a `getSourceAggregates` result you already
 * have — this exists only for callers that need the tallies on their own, and
 * costs a full scan.
 */
export async function getSourceBucketCounts(
  timeframe: Timeframe,
  scope: AggregateScope = {}
): Promise<Record<SourceBucket | 'all', number>> {
  const page = await getSourceAggregates(timeframe, scope, { limit: 1, bucket: 'all' });
  return page.bucketCounts;
}

export async function getSourceReviews(): Promise<
  Map<string, { state: SourceReviewState; note: string | null }>
> {
  const result = await query<{ source_key: string; review_state: string; note: string | null }>(
    `SELECT source_key, review_state, note FROM source_review`
  );
  return new Map(
    result.rows.map((row) => [
      row.source_key,
      { state: row.review_state as SourceReviewState, note: row.note },
    ])
  );
}

export async function setSourceReview(
  sourceKey: string,
  state: SourceReviewState,
  reviewedBy: string,
  note?: string | null
): Promise<void> {
  await query(
    `INSERT INTO source_review (source_key, review_state, reviewed_by, reviewed_at, note, updated_at)
     VALUES ($1, $2, $3, NOW(), $4, NOW())
     ON CONFLICT (source_key) DO UPDATE SET
       review_state = EXCLUDED.review_state,
       reviewed_by = EXCLUDED.reviewed_by,
       reviewed_at = NOW(),
       note = EXCLUDED.note,
       updated_at = NOW()`,
    [sourceKey, state, reviewedBy, note ?? null]
  );
}
