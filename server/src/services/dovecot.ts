import {
  DOVECOT_CONFIG_STORE_TABLE,
  deleteConfigStoreEntry,
  upsertConfigStorePayload,
} from '../db/queries/config-store.js';
import { getFleetServiceById, getFleetServiceSoftwareVersion } from '../db/queries/fleet-services.js';
import { commandAgentFor, runAgentCommand, type AgentCommandAction } from './agent-commands.js';
import {
  getManagedFileEntries,
  listConfigStoreOwners,
  readLayeredPayload,
  resetManagedFileEntry,
  saveManagedFileEntry,
  writeLayeredPayload,
  type ManagedFileEntry,
} from './managed-config-file.js';
import { DOVECOT_MANAGED_FILES, DOVECOT_MANAGED_FILES_BY_KEY } from './dovecot-config-files.js';
import { logger } from '../logger.js';

// The conf.d include the robin-agent writes and Dovecot loads via its default
// `!include conf.d/*.conf`.
export const MANAGED_CONF_FILE = '50-robin-managed.conf';
export const MANAGED_VALUES_FILE = 'managed.json';
const HTTP_TIMEOUT_MS = 8000;

// The reserved 'default' scope is the shared base config. It has no
// fleet_services row, so the service resolver/probes must tolerate it.
const DEFAULT_SCOPE_ID = 'default';
const DEFAULT_SCOPE_NAME = 'Default (base)';

// Operational Dovecot knobs safe to manage from robin-admin. Structural config
// (mail_location, SQL userdb, TLS, socket topology) stays ansible-owned and is
// never written here.
// Dovecot renamed a few settings in 2.4 (e.g. `disable_plaintext_auth` →
// `auth_allow_cleartext`, inverted). 2.4 fatals on an unknown setting and rejects
// the whole include, so the rendered file must match the target's major version.
// The version the agent reports (`dovecot --version`) wins; the configured one
// only applies until a version has been reported, e.g. for direct-mode services.
export type DovecotConfigVersion = '2.3' | '2.4';

/** The config syntax line for a reported `dovecot --version`, or null if unknown. */
export function dovecotConfigVersionOf(reported: string | null | undefined): DovecotConfigVersion | null {
  const match = reported?.match(/^\s*(\d+)\.(\d+)/);
  if (!match) return null;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major === 2 && minor === 3) return '2.3';
  if (major > 2 || (major === 2 && minor >= 4)) return '2.4';
  return null;
}

/** The managed values with the version the host actually runs, when known. */
export function withDetectedDovecotVersion(managed: DovecotManagedConfig, reported: string | null): DovecotManagedConfig {
  const detected = dovecotConfigVersionOf(reported);
  return detected ? { ...managed, dovecotVersion: detected } : managed;
}

export interface DovecotManagedConfig {
  dovecotVersion: DovecotConfigVersion; // target Dovecot line; picks 2.3 vs 2.4 syntax
  authCacheSize: string;          // e.g. "10M" (empty = unset)
  authCacheTtl: string;           // e.g. "1 hour"
  authCacheNegativeTtl: string;   // e.g. "1 hour"
  authFailureDelay: string;       // e.g. "2 secs"
  disablePlaintextAuth: boolean;
  mailMaxUseripConnections: number;
  imapIdleNotifyInterval: string; // e.g. "2 mins"
  imapMaxLineLength: string;      // e.g. "64k" (empty = unset)
  mailMaxLockTimeout: string;     // e.g. "5 mins" (empty = unset)
  protocols: string;              // e.g. "imap lmtp pop3"
  mailRetentionDays: number;      // 0 = disabled
}

const DEFAULT_DOVECOT_CONFIG: DovecotManagedConfig = {
  dovecotVersion: '2.3',
  authCacheSize: '',
  authCacheTtl: '1 hour',
  authCacheNegativeTtl: '1 hour',
  authFailureDelay: '2 secs',
  disablePlaintextAuth: true,
  mailMaxUseripConnections: 10,
  imapIdleNotifyInterval: '2 mins',
  imapMaxLineLength: '',
  mailMaxLockTimeout: '',
  protocols: 'imap lmtp',
  mailRetentionDays: 0,
};

function normalizeInteger(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function normalizeDovecotConfig(value: unknown): DovecotManagedConfig {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_DOVECOT_CONFIG };
  }
  const s = value as Record<string, unknown>;
  return {
    dovecotVersion: s.dovecotVersion === '2.4' ? '2.4' : '2.3',
    authCacheSize: typeof s.authCacheSize === 'string' ? s.authCacheSize.trim() : DEFAULT_DOVECOT_CONFIG.authCacheSize,
    authCacheTtl: typeof s.authCacheTtl === 'string' && s.authCacheTtl.trim() ? s.authCacheTtl.trim() : DEFAULT_DOVECOT_CONFIG.authCacheTtl,
    authCacheNegativeTtl: typeof s.authCacheNegativeTtl === 'string' && s.authCacheNegativeTtl.trim() ? s.authCacheNegativeTtl.trim() : DEFAULT_DOVECOT_CONFIG.authCacheNegativeTtl,
    authFailureDelay: typeof s.authFailureDelay === 'string' && s.authFailureDelay.trim() ? s.authFailureDelay.trim() : DEFAULT_DOVECOT_CONFIG.authFailureDelay,
    disablePlaintextAuth: typeof s.disablePlaintextAuth === 'boolean' ? s.disablePlaintextAuth : DEFAULT_DOVECOT_CONFIG.disablePlaintextAuth,
    mailMaxUseripConnections: normalizeInteger(s.mailMaxUseripConnections, DEFAULT_DOVECOT_CONFIG.mailMaxUseripConnections),
    imapIdleNotifyInterval: typeof s.imapIdleNotifyInterval === 'string' && s.imapIdleNotifyInterval.trim() ? s.imapIdleNotifyInterval.trim() : DEFAULT_DOVECOT_CONFIG.imapIdleNotifyInterval,
    imapMaxLineLength: typeof s.imapMaxLineLength === 'string' ? s.imapMaxLineLength.trim() : DEFAULT_DOVECOT_CONFIG.imapMaxLineLength,
    mailMaxLockTimeout: typeof s.mailMaxLockTimeout === 'string' ? s.mailMaxLockTimeout.trim() : DEFAULT_DOVECOT_CONFIG.mailMaxLockTimeout,
    protocols: typeof s.protocols === 'string' && s.protocols.trim() ? s.protocols.trim() : DEFAULT_DOVECOT_CONFIG.protocols,
    mailRetentionDays: normalizeInteger(s.mailRetentionDays, DEFAULT_DOVECOT_CONFIG.mailRetentionDays),
  };
}

export interface DovecotConfigState {
  serviceId: string;
  serviceName: string;
  managed: DovecotManagedConfig;
  /** `dovecot --version` as the service's agent last reported it. */
  detectedVersion: string | null;
  /** Additional per-file managed configs (50-robin-logging.conf, …). */
  managedFiles: ManagedFileEntry[];
}

export interface DovecotLiveMetrics {
  serviceId: string;
  serviceType: 'dovecot';
  timestamp: Date;
  reachable: boolean;
  authSuccess: number;
  authFailure: number;
  loginCount: number;
  imapCommands: number;
  mailDeliveries: number;
  sessionCount: number;
  userCount: number;
  rawStats: string;
}

async function getResolvedService(serviceId: string) {
  const service = await getFleetServiceById(serviceId);
  if (!service || service.serviceType !== 'dovecot') {
    throw new Error('Dovecot service not found');
  }
  return service;
}

// Display name for a scope: base, a registered instance, or (freeform Save-As,
// no fleet row yet) the scope id itself.
async function resolveScopeName(serviceId: string): Promise<string> {
  if (serviceId === DEFAULT_SCOPE_ID) return DEFAULT_SCOPE_NAME;
  const service = await getFleetServiceById(serviceId);
  return service?.name ?? serviceId;
}

export async function getDovecotConfigState(serviceId: string): Promise<DovecotConfigState> {
  // The 'default' base layer is the shared base; an instance scope layers its
  // override delta on top (core object deep-merged, files effective).
  const [serviceName, payload, managedFiles, detectedVersion] = await Promise.all([
    resolveScopeName(serviceId),
    readLayeredPayload(DOVECOT_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_VALUES_FILE),
    getManagedFileEntries(DOVECOT_CONFIG_STORE_TABLE, 'service_id', serviceId, DOVECOT_MANAGED_FILES),
    serviceId === DEFAULT_SCOPE_ID ? null : getFleetServiceSoftwareVersion(serviceId),
  ]);
  return {
    serviceId,
    serviceName,
    managed: normalizeDovecotConfig(payload),
    detectedVersion,
    managedFiles,
  };
}

/** All config scopes: the 'default' base plus every per-instance override owner. */
export async function listDovecotConfigScopes(): Promise<string[]> {
  return listConfigStoreOwners(DOVECOT_CONFIG_STORE_TABLE, 'service_id');
}

/** Reset one file's override at a scope: a managed file, or the core object. */
export async function resetDovecotConfigFile(serviceId: string, key: string): Promise<DovecotConfigState> {
  if (serviceId === DEFAULT_SCOPE_ID) {
    throw new Error('The default base scope has no override to reset');
  }
  const def = DOVECOT_MANAGED_FILES_BY_KEY[key];
  if (def) {
    await resetManagedFileEntry(DOVECOT_CONFIG_STORE_TABLE, 'service_id', serviceId, def);
  } else {
    // A core section (auth/sessions) — they share the one managed.json object.
    await deleteConfigStoreEntry(DOVECOT_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_VALUES_FILE);
    await deleteConfigStoreEntry(DOVECOT_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_CONF_FILE);
  }
  return getDovecotConfigState(serviceId);
}

/** Save one per-file managed Dovecot config (50-robin-logging.conf, …). */
export async function saveDovecotManagedFile(
  serviceId: string,
  key: string,
  values: unknown,
): Promise<ManagedFileEntry> {
  const def = DOVECOT_MANAGED_FILES_BY_KEY[key];
  if (!def) {
    throw new Error(`Unknown Dovecot managed file: ${key}`);
  }
  return saveManagedFileEntry(DOVECOT_CONFIG_STORE_TABLE, 'service_id', serviceId, def, values);
}

// Render the managed knobs to a single includable conf file. Ansible's
// dovecot.conf `!include conf.d/*.conf` picks it up without touching structural
// files.
// `doveadm stats dump` / OpenMetrics only report metrics someone defined, so the
// managed include always ships the counters the Metrics page reads. The robin_
// prefix avoids clashing with operator-defined metrics of the same meaning;
// assignMetric matches by substring and keeps the max of duplicates.
const ROBIN_METRICS = [
  ['robin_auth_success', 'event=auth_request_finished AND success=yes'],
  ['robin_auth_failure', 'event=auth_request_finished AND NOT success=yes'],
  ['robin_login', 'event=auth_request_finished AND success=yes'],
  ['robin_imap_command', 'event=imap_command_finished'],
  ['robin_mail_delivery', 'event=mail_delivery_finished'],
].flatMap(([name, filter]) => [`metric ${name} {`, `  filter = ${filter}`, '}']);

export function renderDovecotConfig(managed: DovecotManagedConfig): string {
  const lines: string[] = [
    '# Managed by Robin Admin — do not edit by hand. Operational overrides only.',
    // 2.4 removed `disable_plaintext_auth` in favour of `auth_allow_cleartext`
    // (inverted). Every other knob below is valid on both 2.3 and 2.4.
    managed.dovecotVersion === '2.4'
      ? `auth_allow_cleartext = ${managed.disablePlaintextAuth ? 'no' : 'yes'}`
      : `disable_plaintext_auth = ${managed.disablePlaintextAuth ? 'yes' : 'no'}`,
    `auth_cache_ttl = ${managed.authCacheTtl}`,
    `auth_cache_negative_ttl = ${managed.authCacheNegativeTtl}`,
    `auth_failure_delay = ${managed.authFailureDelay}`,
  ];
  if (managed.authCacheSize) {
    lines.push(`auth_cache_size = ${managed.authCacheSize}`);
  }
  if (managed.mailMaxLockTimeout) {
    lines.push(`mail_max_lock_timeout = ${managed.mailMaxLockTimeout}`);
  }
  if (managed.protocols) {
    lines.push(`protocols = ${managed.protocols}`);
  }
  lines.push('protocol imap {');
  lines.push(`  mail_max_userip_connections = ${managed.mailMaxUseripConnections}`);
  lines.push(`  imap_idle_notify_interval = ${managed.imapIdleNotifyInterval}`);
  if (managed.imapMaxLineLength) {
    lines.push(`  imap_max_line_length = ${managed.imapMaxLineLength}`);
  }
  lines.push('}');
  lines.push(...ROBIN_METRICS);
  return `${lines.join('\n')}\n`;
}

export async function saveDovecotManagedConfig(
  serviceId: string,
  patch: Partial<DovecotManagedConfig>,
): Promise<DovecotConfigState> {
  const current = await getDovecotConfigState(serviceId);
  const merged = normalizeDovecotConfig({ ...current.managed, ...patch });
  // The managed values (drives the form) — base scope stores full, instance
  // stores only the delta. Metadata; the agent skips *.json.
  await writeLayeredPayload(DOVECOT_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_VALUES_FILE, merged as unknown as Record<string, unknown>);
  // The rendered conf.d include (full effective) — what the fleet agent writes.
  await upsertConfigStorePayload(DOVECOT_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_CONF_FILE, {
    content: renderDovecotConfig(withDetectedDovecotVersion(merged, current.detectedVersion)),
    managedBy: 'robin-admin',
  });

  return { ...current, managed: merged };
}

// Map a Dovecot metric name (from either `doveadm stats dump` or OpenMetrics)
// to one of our flat counters. Matches by substring so it tolerates Dovecot's
// naming differences (2.3 custom `auth_success` vs 2.4 built-in `auth_successes`).
function assignMetric(out: Partial<DovecotLiveMetrics>, name: string, count: number): void {
  if (!Number.isFinite(count)) return;
  const n = name.toLowerCase();
  const keep = (cur: number | undefined) => Math.max(cur ?? 0, count);
  if (n.includes('auth') && n.includes('succ')) out.authSuccess = keep(out.authSuccess);
  else if (n.includes('auth') && n.includes('fail')) out.authFailure = keep(out.authFailure);
  else if (n.includes('login')) out.loginCount = keep(out.loginCount);
  else if (n.includes('imap') && n.includes('command')) out.imapCommands = keep(out.imapCommands);
  else if (n.includes('deliver')) out.mailDeliveries = keep(out.mailDeliveries);
}

export function parseStatsDump(raw: string): Partial<DovecotLiveMetrics> {
  // `doveadm stats dump` prints a TSV header then one row per metric+field:
  //   metric_name<TAB>field<TAB>count<TAB>sum<TAB>...
  // The `count` (3rd column) is the event count, identical across a metric's
  // field rows. Skip the header; take the max count seen per metric name.
  const out: Partial<DovecotLiveMetrics> = {};
  for (const row of raw.split('\n')) {
    const cols = row.trim().split(/\s+/);
    if (cols.length < 3) continue;
    const name = cols[0];
    if (!name || name === 'metric_name') continue;
    assignMetric(out, name, Number.parseInt(cols[2], 10));
  }
  return out;
}

// Parse Dovecot's OpenMetrics HTTP exporter output. Counters look like:
//   dovecot_auth_successes_total 12
//   dovecot_imap_commands_count 34
// Histograms (e.g. mail_deliveries) expose the total via the +Inf bucket:
//   dovecot_mail_deliveries_bucket{le="+Inf"} 5
export function parseOpenMetrics(raw: string): Partial<DovecotLiveMetrics> {
  const out: Partial<DovecotLiveMetrics> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.startsWith('dovecot_')) continue;
    const infBucket = trimmed.match(/^dovecot_(.+?)_bucket\{le="\+Inf"\}\s+([0-9.]+)/);
    if (infBucket) {
      assignMetric(out, infBucket[1], Math.round(Number.parseFloat(infBucket[2])));
      continue;
    }
    const counter = trimmed.match(/^dovecot_(.+?)_(?:total|count)\s+([0-9.]+)/);
    if (counter && !/duration_seconds/.test(trimmed)) {
      assignMetric(out, counter[1], Math.round(Number.parseFloat(counter[2])));
    }
  }
  return out;
}

// `doveadm who` groups sessions per user and service:
//   username          # service (pids)   (ips)
//   jane@example.com  2 imap    (12 34)  (10.0.0.5)
export function parseWho(raw: string): { sessionCount: number; userCount: number } {
  const rows = raw.split('\n').map((l) => l.trim()).filter((r) => r && !/^username\b/i.test(r));
  const users = new Set<string>();
  let sessionCount = 0;
  for (const row of rows) {
    const [user, count] = row.split(/\s+/);
    users.add(user);
    sessionCount += Number.parseInt(count, 10) || 1;
  }
  return { sessionCount, userCount: users.size };
}

export interface DovecotSession {
  user: string;
  service: string;
  pid: string;
  ip: string;
  destIp: string;
}

// `doveadm who -1` prints one row per connection:
//   username          service pid   ip        dest_ip
export function parseWhoSessions(raw: string): DovecotSession[] {
  return raw.split('\n')
    .map((l) => l.trim())
    .filter((r) => r && !/^username\b/i.test(r))
    .map((row) => {
      const [user = '', service = '', pid = '', ip = '', destIp = ''] = row.split(/\s+/);
      return { user, service, pid, ip, destIp };
    });
}

export interface DovecotQuotaRow {
  user: string;
  quotaName: string;
  type: string;
  value: number;
  limit: number | null;
  percent: number;
}

export interface DovecotQuotaResult {
  available: boolean;
  /** Why quota data is unavailable (plugin disabled, no user listing, …). */
  reason: string | null;
  rows: DovecotQuotaRow[];
}

// `doveadm -f tab quota get` prints a header then one row per quota resource;
// with -A the first column is the username. A limit of "-" means unlimited.
export function parseQuota(raw: string, user?: string): DovecotQuotaRow[] {
  const [header, ...rows] = raw.split('\n').filter((l) => l.trim());
  if (!header) return [];
  const cols = header.split('\t').map((c) => c.trim().toLowerCase());
  const at = (name: string) => cols.indexOf(name);
  return rows.map((row) => {
    const f = row.split('\t');
    const limit = f[at('limit')]?.trim();
    return {
      user: at('username') >= 0 ? f[at('username')] : user ?? '',
      quotaName: f[at('quota name')] ?? '',
      type: f[at('type')] ?? '',
      value: Number(f[at('value')]) || 0,
      limit: !limit || limit === '-' ? null : Number(limit) || 0,
      percent: Number(f[at('%')]) || 0,
    };
  });
}

/** `doveadm user <u>` prints `field<TAB>value` rows (userdb lookup). */
export function parseUserLookup(raw: string): Record<string, string> | null {
  if (/doesn't exist/i.test(raw)) return null;
  const fields: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const [key, ...rest] = line.split('\t');
    if (!key?.trim() || key.trim() === 'field') continue;
    fields[key.trim()] = rest.join('\t').trim();
  }
  return fields;
}

function isHttpMetricsUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim());
}

// HTTP mode: scrape Dovecot's OpenMetrics exporter over the network.
async function collectHttpDovecotMetrics(base: DovecotLiveMetrics, metricsUrl: string): Promise<DovecotLiveMetrics> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let text: string;
    try {
      const res = await fetch(metricsUrl, { signal: controller.signal });
      if (!res.ok) {
        logger.warn('Dovecot OpenMetrics endpoint returned non-OK', { metricsUrl, status: res.status });
        return base;
      }
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    Object.assign(base, parseOpenMetrics(text));
    base.rawStats = text.slice(0, 8000);
    base.reachable = true;
  } catch (error) {
    logger.warn('Dovecot OpenMetrics fetch failed', { metricsUrl, error: (error as Error).message });
  }
  return base;
}

/** Direct (non-agent) metrics: Dovecot's OpenMetrics exporter when a metrics URL is registered. */
export async function getDovecotLiveMetrics(serviceId: string): Promise<DovecotLiveMetrics> {
  const base: DovecotLiveMetrics = {
    serviceId,
    serviceType: 'dovecot',
    timestamp: new Date(),
    reachable: false,
    authSuccess: 0,
    authFailure: 0,
    loginCount: 0,
    imapCommands: 0,
    mailDeliveries: 0,
    sessionCount: 0,
    userCount: 0,
    rawStats: '',
  };

  // The 'default' base layer has no running server to probe.
  if (serviceId === DEFAULT_SCOPE_ID) {
    return base;
  }

  const service = await getResolvedService(serviceId);
  return isHttpMetricsUrl(service.metricsUrl) ? collectHttpDovecotMetrics(base, service.metricsUrl) : base;
}

/**
 * Assemble a DovecotLiveMetrics from raw `doveadm stats dump` (and optional
 * `doveadm who`) output shipped by the service's robin-agent. robin-admin owns
 * the parsing; the agent just runs the commands.
 */
export function buildDovecotSnapshotFromRaw(serviceId: string, statsDump: string, who?: string): DovecotLiveMetrics {
  const snapshot: DovecotLiveMetrics = {
    serviceId,
    serviceType: 'dovecot',
    timestamp: new Date(),
    reachable: true,
    authSuccess: 0,
    authFailure: 0,
    loginCount: 0,
    imapCommands: 0,
    mailDeliveries: 0,
    sessionCount: 0,
    userCount: 0,
    rawStats: statsDump.slice(0, 8000),
  };
  Object.assign(snapshot, parseStatsDump(statsDump));
  if (who && who.trim()) {
    Object.assign(snapshot, parseWho(who));
  }
  return snapshot;
}

// ── Agent-backed operations ─────────────────────────────────────────────────

async function runDoveadm(serviceId: string, action: AgentCommandAction, args: Record<string, unknown> = {}, axis: 'metrics' | 'config' = 'metrics'): Promise<string> {
  const service = await getResolvedService(serviceId);
  const agentId = commandAgentFor(service, axis);
  if (!agentId) {
    throw new Error('This Dovecot service has no robin-agent to run doveadm');
  }
  return runAgentCommand(agentId, service, action, args);
}

// `doveconf -n` then `doveadm reload` on the host, via the config agent.
export async function reloadDovecot(serviceId: string): Promise<string> {
  return (await runDoveadm(serviceId, 'dovecot.reload', {}, 'config')).trim() || 'Reload signal sent';
}

export async function listDovecotSessions(serviceId: string): Promise<DovecotSession[]> {
  return parseWhoSessions(await runDoveadm(serviceId, 'dovecot.who'));
}

export async function kickDovecotUser(serviceId: string, user: string): Promise<string> {
  return (await runDoveadm(serviceId, 'dovecot.kick', { user })).trim() || `Disconnected ${user}`;
}

export async function lookupDovecotUser(serviceId: string, user: string): Promise<Record<string, string> | null> {
  try {
    return parseUserLookup(await runDoveadm(serviceId, 'dovecot.user', { user }));
  } catch (error) {
    // doveadm exits non-zero for an unknown user.
    if (/doesn't exist/i.test((error as Error).message)) return null;
    throw error;
  }
}

/** Quota usage for one user, or every user when the userdb can list them. */
export async function getDovecotQuota(serviceId: string, user?: string): Promise<DovecotQuotaResult> {
  try {
    const raw = await runDoveadm(serviceId, 'dovecot.quota', user ? { user } : {});
    return { available: true, reason: null, rows: parseQuota(raw, user) };
  } catch (error) {
    const message = (error as Error).message;
    // Deployment limits, not failures: report them so the UI can explain instead of erroring.
    if (/Unknown command 'quota'/i.test(message)) {
      return { available: false, reason: 'The Dovecot quota plugin is not enabled (mail_plugins = quota).', rows: [] };
    }
    if (/user listing/i.test(message)) {
      return { available: false, reason: "The userdb can't list users, so quota is available per user only.", rows: [] };
    }
    throw error;
  }
}
