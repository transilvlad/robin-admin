/**
 * Sender enrichment for DMARC source IPs.
 *
 * Given a source IP from a DMARC aggregate report and the report's domain,
 * derive a meaningful classification using:
 *
 *   1. Forward-Confirmed Reverse DNS (FCrDNS) — PTR lookup, then re-resolve
 *      the result and check the original IP appears. Bare PTR records can
 *      be controlled by the IP owner so they aren't trustworthy alone.
 *
 *   2. Live SPF expansion — recursively resolve the report domain's SPF
 *      record (include / redirect / a / mx / ip4 / ip6 mechanisms) and
 *      check whether the source IP is covered. Honors RFC 7208's 10-DNS-
 *      lookup ceiling so we don't hand-wave permerror as authorized.
 *
 *   3. Public Suffix List org-domain alignment — using the `psl` package
 *      to compare the FCrDNS-verified hostname against the report domain.
 *      Subdomains and sister hostnames within the same registered org
 *      domain count as own infrastructure.
 *
 *   4. Aggregated DMARC counts from the report itself — pass/fail
 *      disposition, DKIM verdict, SPF verdict — to fill in the
 *      forwarder vs. suspicious-forwarder bucket when the IP isn't in
 *      the report domain's SPF.
 *
 * Buckets returned (highest precedence first):
 *
 *   - own_server            : FCrDNS host shares an org domain with report domain
 *   - authorized            : source IP is in the report domain's SPF
 *   - forwarder             : DKIM-aligned pass + SPF doesn't authorize this IP
 *   - suspicious_forwarder  : forwarder pattern but DKIM failed
 *   - unknown               : none of the above; surface for manual review
 *
 * All lookups have short timeouts and are LRU-cached in-process. Failures
 * never throw — we degrade gracefully to "unknown" when DNS is misbehaving.
 */

import dns from 'node:dns/promises';
import * as psl from 'psl';
import ipaddrLib from 'ipaddr.js';
import { logger } from '../logger.js';
import { lookupProvider } from './provider-catalog.js';
import { getConfig } from '../db/queries/config.js';
import { safeFetch } from '../middleware/security.js';
import type { SenderClassification } from '../types/reporting.js';

// ──────────────────────────────────────────────────────────────────────
// Tunables
// ──────────────────────────────────────────────────────────────────────
const DNS_TIMEOUT_MS = 3000;
const SPF_LOOKUP_LIMIT = 10;            // RFC 7208 §4.6.4
const PTR_CACHE_TTL_MS = 6 * 60 * 60_000;
const SPF_CACHE_TTL_MS = 60 * 60_000;
const NEG_CACHE_TTL_MS = 60 * 60_000;
const PTR_RESOLVER_SERVERS = (process.env.DNS_RESOLVERS ?? '1.1.1.1,8.8.8.8,9.9.9.9')
  .split(',')
  .map((server) => server.trim())
  .filter(Boolean);
let dnsTimeoutMs = DNS_TIMEOUT_MS;
let ptrResolverServers = PTR_RESOLVER_SERVERS;

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────
export interface DmarcCounts {
  /** Sum of `count` from the DMARC records for this (domain, source_ip) tuple. */
  total: number;
  /** Records where aligned SPF or aligned DKIM passed (actual DMARC pass). */
  pass: number;
  /** Records where `policy_evaluated.dkim = pass`. */
  dkimPass: number;
  /** Records where `policy_evaluated.spf = pass`. */
  spfPass: number;
}

export interface SenderEnrichmentInput {
  sourceIp: string;
  reportDomain: string;
  counts: DmarcCounts;
}

export interface SenderEnrichmentResult {
  classification: SenderClassification;
  confidence: number;          // 0..1
  /** First PTR hostname seen for the source IP, even when FCrDNS fails. */
  ptrHost: string | null;
  /** FCrDNS-verified hostname; null when PTR is missing or fails FCrDNS. */
  rdnsHost: string | null;
  /** True iff `rdnsHost` shares an organizational domain with `reportDomain`. */
  rdnsAlignsWithDomain: boolean;
  /** Whether the IP appears in `reportDomain`'s SPF record. */
  spfAuthorized: boolean;
  /** Resolved ESP/provider name from the curated catalogue, or null. */
  provider: string | null;
  providerCategory: string | null;
  /** Registered org domain of `reportDomain`, for subdomain rollup. */
  orgDomain: string | null;
  /** Reason string suitable for the `notes` column. */
  reason: string;
}

interface CacheEntry<T> { value: T; expires: number; }

// ──────────────────────────────────────────────────────────────────────
// Caches (in-process; short-lived)
// ──────────────────────────────────────────────────────────────────────
const ptrCache = new Map<string, CacheEntry<string[] | null>>();
const fcrdnsCache = new Map<string, CacheEntry<string | null>>();
const spfCache = new Map<string, CacheEntry<{ ipv4: string[]; ipv6: string[]; permerror: boolean }>>();
const ptrResolver = typeof dns.Resolver === 'function' ? new dns.Resolver() : null;

if (ptrResolver && PTR_RESOLVER_SERVERS.length > 0) {
  ptrResolver.setServers(PTR_RESOLVER_SERVERS);
}

async function loadSenderEnrichmentPolicy(): Promise<void> {
  const config = await getConfig();
  dnsTimeoutMs = Math.max(500, Math.min(30000, config.senderEnrichmentDnsTimeoutMs));
  const nextServers = config.dnsResolvers
    .split(/[\s,]+/)
    .map((server) => server.trim())
    .filter(Boolean);
  if (ptrResolver && nextServers.join(',') !== ptrResolverServers.join(',')) {
    try {
      ptrResolver.setServers(nextServers);
      ptrResolverServers = nextServers;
    } catch (error) {
      logger.warn('Invalid DNS resolvers, keeping previous resolver set', {
        error: (error as Error).message,
      });
    }
  }
}

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (entry.expires < Date.now()) {
    map.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number) {
  map.set(key, { value, expires: Date.now() + ttlMs });
}

// ──────────────────────────────────────────────────────────────────────
// Generic timed DNS wrappers
// ──────────────────────────────────────────────────────────────────────
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ──────────────────────────────────────────────────────────────────────
// FCrDNS
// ──────────────────────────────────────────────────────────────────────

/**
 * Returns normalized PTR candidates for `ip`.
 */
async function resolvePtrCandidates(ip: string): Promise<string[]> {
  const cached = cacheGet(ptrCache, ip);
  if (cached !== undefined) return cached ?? [];

  try {
    const ptrs = await withTimeout(
      (ptrResolver?.reverse(ip) ?? dns.reverse(ip)),
      dnsTimeoutMs,
      `PTR ${ip}`
    );
    if (!ptrs.length) {
      cacheSet(ptrCache, ip, null, NEG_CACHE_TTL_MS);
      return [];
    }
    const hosts = [...new Set(ptrs.map((candidate) => candidate.replace(/\.$/, '').toLowerCase()).filter(Boolean))];
    cacheSet(ptrCache, ip, hosts, PTR_CACHE_TTL_MS);
    return hosts;
  } catch (err) {
    logger.debug?.('PTR lookup error', { ip, err: (err as Error).message });
  }

  cacheSet(ptrCache, ip, null, NEG_CACHE_TTL_MS);
  return [];
}

export async function resolvePtrHost(ip: string): Promise<string | null> {
  await loadSenderEnrichmentPolicy();
  const hosts = await resolvePtrCandidates(ip);
  return hosts[0] ?? null;
}

/**
 * Returns the FCrDNS-verified hostname for `ip`, or null if:
 *   - PTR lookup fails / returns no record
 *   - re-resolving the PTR result doesn't include the original IP
 *   - any DNS step times out
 */
export async function resolveFcrdns(ip: string): Promise<string | null> {
  const cached = cacheGet(fcrdnsCache, ip);
  if (cached !== undefined) return cached;

  let host: string | null = null;
  try {
    const ptrs = await resolvePtrCandidates(ip);
    for (const candidate of ptrs) {
      try {
        const fwd = isIPv6(ip)
          ? await withTimeout(dns.resolve6(candidate), dnsTimeoutMs, `AAAA ${candidate}`)
          : await withTimeout(dns.resolve4(candidate), dnsTimeoutMs, `A ${candidate}`);
        if (fwd.some((f) => normalizeIp(f) === normalizeIp(ip))) {
          host = candidate;
          break;
        }
      } catch {
        // try the next PTR candidate
      }
    }
  } catch (err) {
    logger.debug?.('FCrDNS lookup error', { ip, err: (err as Error).message });
  }

  cacheSet(fcrdnsCache, ip, host, host ? PTR_CACHE_TTL_MS : NEG_CACHE_TTL_MS);
  return host;
}

function normalizeIp(ip: string): string {
  try {
    return ipaddrLib.parse(ip).toNormalizedString();
  } catch {
    return ip;
  }
}

function isIPv6(ip: string): boolean {
  try { return ipaddrLib.parse(ip).kind() === 'ipv6'; } catch { return ip.includes(':'); }
}

// ──────────────────────────────────────────────────────────────────────
// SPF expansion
// ──────────────────────────────────────────────────────────────────────

/**
 * Recursively expand `domain`'s SPF record into an explicit list of
 * IPv4 / IPv6 CIDRs. Honors the RFC 7208 10-lookup ceiling.
 *
 * Returns `{ permerror: true }` when:
 *   - no SPF (TXT) record exists
 *   - the lookup limit is exceeded
 *   - any timeout/network error during expansion
 *
 * `permerror=true` MUST NOT be treated as "authorized" — fall through to
 * other classification signals.
 */
export async function flattenSpf(domain: string): Promise<{
  ipv4: string[]; ipv6: string[]; permerror: boolean;
}> {
  const cached = cacheGet(spfCache, domain);
  if (cached) return cached;

  const ipv4 = new Set<string>();
  const ipv6 = new Set<string>();
  const seen = new Set<string>();
  let lookupCount = 0;
  let permerror = false;

  async function expand(d: string): Promise<void> {
    if (permerror) return;
    if (seen.has(d.toLowerCase())) return; // avoid include loops
    seen.add(d.toLowerCase());

    let txts: string[][];
    try {
      txts = await withTimeout(dns.resolveTxt(d), dnsTimeoutMs, `TXT ${d}`);
    } catch {
      permerror = true;
      return;
    }

    const flatTxts = txts
      .map((parts) => parts.join(''))
      .filter((s) => s.toLowerCase().startsWith('v=spf1'));
    if (flatTxts.length !== 1) {
      // 0 = no SPF (treat as permerror so we don't mis-classify);
      // >1 = invalid (RFC 7208 §3.1) → permerror
      permerror = true;
      return;
    }

    for (const term of flatTxts[0].split(/\s+/).slice(1)) {
      if (permerror) return;
      const t = term.toLowerCase();
      // Strip qualifier (+ - ~ ?) — even softfails authorize the IP for
      // our purposes (we want to know the operator declared the IP).
      const bare = t.replace(/^[+\-~?]/, '');

      if (bare.startsWith('ip4:')) {
        const v = term.slice(term.indexOf(':') + 1);
        ipv4.add(v.includes('/') ? v : `${v}/32`);
      } else if (bare.startsWith('ip6:')) {
        const v = term.slice(term.indexOf(':') + 1);
        ipv6.add(v.includes('/') ? v : `${v}/128`);
      } else if (bare === 'a' || bare.startsWith('a:') || bare.startsWith('a/')) {
        if (++lookupCount > SPF_LOOKUP_LIMIT) { permerror = true; return; }
        const target = bare.startsWith('a:') ? term.slice(2).split('/')[0] : d;
        await collectAddresses(target, ipv4, ipv6);
      } else if (bare === 'mx' || bare.startsWith('mx:')) {
        if (++lookupCount > SPF_LOOKUP_LIMIT) { permerror = true; return; }
        const target = bare.startsWith('mx:') ? term.slice(3).split('/')[0] : d;
        try {
          const mx = await withTimeout(dns.resolveMx(target), dnsTimeoutMs, `MX ${target}`);
          for (const m of mx) {
            if (++lookupCount > SPF_LOOKUP_LIMIT) { permerror = true; return; }
            await collectAddresses(m.exchange, ipv4, ipv6);
          }
        } catch { /* MX missing is not fatal */ }
      } else if (bare.startsWith('include:')) {
        if (++lookupCount > SPF_LOOKUP_LIMIT) { permerror = true; return; }
        const next = term.slice(term.indexOf(':') + 1);
        await expand(next);
      } else if (bare.startsWith('redirect=')) {
        if (++lookupCount > SPF_LOOKUP_LIMIT) { permerror = true; return; }
        const next = term.slice(term.indexOf('=') + 1);
        await expand(next);
      }
      // exists / ptr / exp / unknown mechanisms: ignored for flattening
    }
  }

  await expand(domain);

  const result = { ipv4: [...ipv4], ipv6: [...ipv6], permerror };
  cacheSet(spfCache, domain, result, permerror ? NEG_CACHE_TTL_MS : SPF_CACHE_TTL_MS);
  return result;
}

// ──────────────────────────────────────────────────────────────────────
// Live DNS snapshot for the issue/health UI
// ──────────────────────────────────────────────────────────────────────

// Default selectors scanned when we have no other hint about which DKIM
// keys a domain publishes. Order doesn't matter — we resolve in parallel
// and persist whatever responds. Anything not in this list will need to
// be discovered later from DMARC report dkim_selector hints.
const DEFAULT_DKIM_SELECTORS = [
  'default', 'google', 'k1', 'k2', 'k3', 's1', 's2', 'mail', 'dkim',
  'smtpapi', 'mailgun', 'sendgrid', 'postmark', 'mandrill', 'ml',
];

export interface DomainDnsSnapshot {
  spfRecord: string | null;
  spfAuthorized: { ipv4: string[]; ipv6: string[] };
  spfPermerror: boolean;
  dmarcRecord: string | null;
  dkimRecords: Record<string, string>;
  mxHosts: string[];
  daneRecords: Record<string, string[]>;
  mtaStsDnsRecord: string | null;
  mtaStsPolicyText: string | null;
  mtaStsPolicyMode: string | null;
  tlsRptRecord: string | null;
  bimiRecord: string | null;
  checkedAt: Date;
}

const dnsSnapshotCache = new Map<string, CacheEntry<DomainDnsSnapshot>>();

async function resolveAllTxtSpf(domain: string): Promise<string | null> {
  try {
    const all = await withTimeout(dns.resolveTxt(domain), dnsTimeoutMs, `TXT ${domain}`);
    for (const parts of all) {
      const joined = parts.join('');
      if (joined.toLowerCase().startsWith('v=spf1')) return joined;
    }
  } catch { /* ignore */ }
  return null;
}

async function resolveDmarcTxt(domain: string): Promise<string | null> {
  try {
    const all = await withTimeout(dns.resolveTxt(`_dmarc.${domain}`), dnsTimeoutMs, `TXT _dmarc.${domain}`);
    for (const parts of all) {
      const joined = parts.join('');
      if (joined.toLowerCase().startsWith('v=dmarc1')) return joined;
    }
  } catch { /* ignore */ }
  return null;
}

async function resolveTxtByPrefix(name: string, prefix: string): Promise<string | null> {
  try {
    const all = await withTimeout(dns.resolveTxt(name), dnsTimeoutMs, `TXT ${name}`);
    for (const parts of all) {
      const joined = parts.join('');
      if (joined.toLowerCase().startsWith(prefix.toLowerCase())) return joined;
    }
  } catch {
    // ignore missing / timed-out TXT records
  }
  return null;
}

async function resolveMxHosts(domain: string): Promise<string[]> {
  try {
    const records = await withTimeout(dns.resolveMx(domain), dnsTimeoutMs, `MX ${domain}`);
    return [...new Set(records.map((record) => record.exchange.toLowerCase()))].sort();
  } catch {
    return [];
  }
}

async function resolveTlsaRecords(mxHost: string): Promise<string[]> {
  try {
    const records = await withTimeout(
      dns.resolve(`_25._tcp.${mxHost}`, 'TLSA') as Promise<unknown[]>,
      dnsTimeoutMs,
      `TLSA _25._tcp.${mxHost}`
    );
    return records
      .map((record) => {
        const parsed = record as Record<string, unknown>;
        const usage = parsed.certUsage ?? parsed.certificateUsage ?? parsed.usage;
        const selector = parsed.selector;
        const matching = parsed.matchingType ?? parsed.matching;
        const association = parsed.certAssociationData ?? parsed.certAssociation ?? parsed.cert;
        return [usage, selector, matching, association].filter((value) => value !== undefined).join(' ').trim();
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchWithTimeout(url: string, ms: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    // The hostname is derived from report data, which is not fully trusted,
    // so this uses safeFetch's DNS-validated, manually-followed redirects
    // rather than a plain fetch with automatic redirects.
    const response = await safeFetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'RobinAdmin/1.0',
      },
    });
    if (!response || !response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseMtaStsMode(policyText: string | null): string | null {
  if (!policyText) return null;
  const match = policyText.match(/^\s*mode:\s*([a-z-]+)\s*$/im);
  return match ? match[1].toLowerCase() : null;
}

async function resolveDkimTxt(selector: string, domain: string): Promise<string | null> {
  try {
    const all = await withTimeout(
      dns.resolveTxt(`${selector}._domainkey.${domain}`),
      dnsTimeoutMs,
      `TXT ${selector}._domainkey.${domain}`
    );
    if (!all.length) return null;
    return all[0].join('');
  } catch {
    return null;
  }
}

/**
 * Resolves the live SPF + DMARC + observed DKIM records for `domain` and
 * returns them as a snapshot suitable for persisting to domain_health
 * and embedding in issue evidence. Cached for SPF_CACHE_TTL_MS so a
 * batch of issue creates for the same domain doesn't re-hit DNS.
 *
 * Failures are swallowed — missing records come back as `null` so the
 * UI can render "no record published" rather than a broken state.
 */
export async function getDomainDnsRecords(domain: string): Promise<DomainDnsSnapshot> {
  await loadSenderEnrichmentPolicy();
  const cached = cacheGet(dnsSnapshotCache, domain);
  if (cached) return cached;

  const [
    spfFlat,
    spfTxt,
    dmarcTxt,
    mxHosts,
    mtaStsDnsRecord,
    tlsRptRecord,
    bimiRecord,
    ...dkimTxts
  ] = await Promise.all([
    flattenSpf(domain).catch(() => ({ ipv4: [] as string[], ipv6: [] as string[], permerror: true })),
    resolveAllTxtSpf(domain),
    resolveDmarcTxt(domain),
    resolveMxHosts(domain),
    resolveTxtByPrefix(`_mta-sts.${domain}`, 'v=stsv1'),
    resolveTxtByPrefix(`_smtp._tls.${domain}`, 'v=tlsrptv1'),
    resolveTxtByPrefix(`default._bimi.${domain}`, 'v=bimi1'),
    ...DEFAULT_DKIM_SELECTORS.map((sel) =>
      resolveDkimTxt(sel, domain).then((txt) => ({ sel, txt }))
    ),
  ]);
  const mtaStsPolicyText = mtaStsDnsRecord
    ? await fetchWithTimeout(`https://mta-sts.${domain}/.well-known/mta-sts.txt`, dnsTimeoutMs)
    : null;

  const dkimRecords: Record<string, string> = {};
  for (const r of dkimTxts as Array<{ sel: string; txt: string | null }>) {
    if (r.txt) dkimRecords[r.sel] = r.txt;
  }

  const daneEntries = await Promise.all(
    (mxHosts as string[]).map(async (mxHost) => [mxHost, await resolveTlsaRecords(mxHost)] as const)
  );
  const daneRecords = Object.fromEntries(
    daneEntries.filter(([, records]) => records.length > 0)
  );

  const snapshot: DomainDnsSnapshot = {
    spfRecord: spfTxt,
    spfAuthorized: { ipv4: spfFlat.ipv4, ipv6: spfFlat.ipv6 },
    spfPermerror: spfFlat.permerror,
    dmarcRecord: dmarcTxt,
    dkimRecords,
    mxHosts: mxHosts as string[],
    daneRecords,
    mtaStsDnsRecord,
    mtaStsPolicyText,
    mtaStsPolicyMode: parseMtaStsMode(mtaStsPolicyText),
    tlsRptRecord,
    bimiRecord,
    checkedAt: new Date(),
  };
  cacheSet(dnsSnapshotCache, domain, snapshot, SPF_CACHE_TTL_MS);
  return snapshot;
}

async function collectAddresses(host: string, ipv4: Set<string>, ipv6: Set<string>): Promise<void> {
  try {
    const a = await withTimeout(dns.resolve4(host), dnsTimeoutMs, `A ${host}`);
    for (const ip of a) ipv4.add(`${ip}/32`);
  } catch { /* ignore */ }
  try {
    const aaaa = await withTimeout(dns.resolve6(host), dnsTimeoutMs, `AAAA ${host}`);
    for (const ip of aaaa) ipv6.add(`${ip}/128`);
  } catch { /* ignore */ }
}

/**
 * True if `ip` is covered by any of the CIDRs in `flattened`.
 */
export function ipMatchesSpf(
  ip: string,
  flattened: { ipv4: string[]; ipv6: string[] }
): boolean {
  let parsed;
  try { parsed = ipaddrLib.parse(ip); } catch { return false; }
  const list = parsed.kind() === 'ipv6' ? flattened.ipv6 : flattened.ipv4;
  for (const cidr of list) {
    try {
      const [range, prefixStr] = cidr.split('/');
      const network = ipaddrLib.parse(range);
      if (network.kind() !== parsed.kind()) continue;
      const prefix = parseInt(prefixStr, 10);
      // ipaddr.js's `match` accepts a parsed range + prefix length.
      if ((parsed as ipaddrLib.IPv4 | ipaddrLib.IPv6).match([network as never, prefix])) return true;
    } catch { /* malformed CIDR — skip */ }
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────
// Org-domain alignment via PSL
// ──────────────────────────────────────────────────────────────────────

/**
 * True if `host` shares an organizational domain (per the Public Suffix
 * List) with `reportDomain`. This is the "relaxed alignment" rule used
 * by DMARC itself — `mta1.example.com` and `bounces.example.com` both
 * align with `example.com`, but `mta1.example.net` does not.
 */
export function hostAlignsWithDomain(host: string, reportDomain: string): boolean {
  if (!host) return false;
  const hostOrg = psl.get(host.toLowerCase());
  const domainOrg = psl.get(reportDomain.toLowerCase());
  return !!hostOrg && !!domainOrg && hostOrg === domainOrg;
}

// ──────────────────────────────────────────────────────────────────────
// Classification
// ──────────────────────────────────────────────────────────────────────

const FORWARDER_HINT_PATTERNS = [
  /(^|\.)mailman(?:[0-9]+)?\./i,
  /(^|\.)listserv\./i,
  /\.lists\./i,
  /\.fwd\./i,
  /\.forward\./i,
  /(^|\.)protection\.outlook\.com$/i,
  /(^|\.)googlemail\.com$/i,
];

function looksLikeForwarderHost(host: string | null): boolean {
  if (!host) return false;
  return FORWARDER_HINT_PATTERNS.some((re) => re.test(host));
}

/**
 * Compute classification + confidence for a single source IP, then attach
 * provider identity.
 *
 * Classification answers "is this authorized?"; the provider lookup
 * answers "who is this?". Both are needed for an issue to be actionable —
 * "unknown sender 149.72.x.x" is noise, "unknown sender 149.72.x.x —
 * SendGrid" is a task.
 */
export async function enrichSender(
  input: SenderEnrichmentInput
): Promise<SenderEnrichmentResult> {
  await loadSenderEnrichmentPolicy();
  const base = await classifySenderCore(input);
  const provider = lookupProvider(base.rdnsHost ?? base.ptrHost, input.sourceIp);
  const orgDomain = getOrgDomain(input.reportDomain);

  return {
    ...base,
    provider: provider?.name ?? null,
    providerCategory: provider?.category ?? null,
    orgDomain,
    reason: provider ? `${base.reason} | provider=${provider.name}` : base.reason,
  };
}

/**
 * Registered organizational domain for a hostname, via the Public Suffix
 * List. Reports arrive per header-from domain including subdomains, so
 * this is what lets a domain's posture roll up instead of fragmenting.
 */
export function getOrgDomain(domain: string): string | null {
  const normalized = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!normalized) return null;
  try {
    const parsed = psl.parse(normalized) as psl.ParsedDomain;
    return parsed.domain ?? null;
  } catch {
    return null;
  }
}

async function classifySenderCore(
  input: SenderEnrichmentInput
): Promise<Omit<SenderEnrichmentResult, 'provider' | 'providerCategory' | 'orgDomain'>> {
  const { sourceIp, reportDomain, counts } = input;
  const safeTotal = Math.max(counts.total, 1);
  const dkimPassRate = counts.dkimPass / safeTotal;
  const spfPassRate = counts.spfPass / safeTotal;

  // Lookups in parallel — failures degrade gracefully.
  const [ptrHost, rdnsHost, spfFlat] = await Promise.all([
    resolvePtrHost(sourceIp).catch(() => null),
    resolveFcrdns(sourceIp).catch(() => null),
    flattenSpf(reportDomain).catch(() => ({ ipv4: [], ipv6: [], permerror: true })),
  ]);

  const displayHost = rdnsHost ?? ptrHost;
  const aligns = rdnsHost ? hostAlignsWithDomain(rdnsHost, reportDomain) : false;
  const inSpf = !spfFlat.permerror && ipMatchesSpf(sourceIp, spfFlat);

  // Precedence:
  //   own_server > authorized > forwarder > suspicious_forwarder > unknown
  if (rdnsHost && aligns) {
    return {
      classification: 'own_server',
      confidence: 0.95,
      ptrHost,
      rdnsHost,
      rdnsAlignsWithDomain: true,
      spfAuthorized: inSpf,
      reason: `FCrDNS host ${rdnsHost} shares org-domain with ${reportDomain}`,
    };
  }

  if (inSpf) {
    return {
      classification: 'authorized',
      confidence: 0.9,
      ptrHost,
      rdnsHost,
      rdnsAlignsWithDomain: false,
      spfAuthorized: true,
      reason: `Source IP listed in ${reportDomain}'s SPF record`,
    };
  }

  // Forwarder territory: DKIM-aligned pass without SPF authorization.
  // We trust `dkim = pass` from the report's `policy_evaluated`, since
  // the receiving MTA has already verified the signature.
  if (dkimPassRate >= 0.8 && counts.dkimPass > 0) {
    return {
      classification: 'forwarder',
      confidence: dkimPassRate,
      ptrHost,
      rdnsHost,
      rdnsAlignsWithDomain: false,
      spfAuthorized: false,
      reason: looksLikeForwarderHost(displayHost)
        ? `DKIM-pass without SPF; PTR ${displayHost} matches a known forwarder pattern`
        : `DKIM-pass without SPF — likely compliant forwarder`,
    };
  }

  // Some DKIM passes but mostly fails — looks like a forwarder that's
  // mangling messages, or something pretending to be one.
  if (dkimPassRate > 0 && dkimPassRate < 0.8) {
    return {
      classification: 'suspicious_forwarder',
      confidence: 1 - dkimPassRate,
      ptrHost,
      rdnsHost,
      rdnsAlignsWithDomain: false,
      spfAuthorized: false,
      reason: `Partial DKIM-pass (${(dkimPassRate * 100).toFixed(0)}%) without SPF — broken forwarder or impersonation`,
    };
  }

  // Forwarder-shaped hostname with no DKIM evidence — still suspicious
  // (we don't have proof either way), bucket as such for review.
  if (looksLikeForwarderHost(displayHost) && counts.dkimPass === 0) {
    return {
      classification: 'suspicious_forwarder',
      confidence: 0.6,
      ptrHost,
      rdnsHost,
      rdnsAlignsWithDomain: false,
      spfAuthorized: false,
      reason: `PTR ${displayHost} looks like a forwarder but DKIM never passed`,
    };
  }

  return {
    classification: 'unknown',
    confidence: 0.5,
    ptrHost,
    rdnsHost,
    rdnsAlignsWithDomain: false,
    spfAuthorized: false,
    reason: spfFlat.permerror
      ? `Could not resolve SPF for ${reportDomain}; SPF unauthorized; SPF pass-rate ${(spfPassRate * 100).toFixed(0)}%, DKIM pass-rate ${(dkimPassRate * 100).toFixed(0)}%`
      : `Not in ${reportDomain}'s SPF, no DKIM pass, no FCrDNS alignment`,
  };
}
