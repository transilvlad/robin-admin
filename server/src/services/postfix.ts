import {
  POSTFIX_CONFIG_STORE_TABLE,
  deleteConfigStoreEntry,
  upsertConfigStorePayload,
} from '../db/queries/config-store.js';
import { getFleetServiceById } from '../db/queries/fleet-services.js';
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
import { POSTFIX_MANAGED_FILES, POSTFIX_MANAGED_FILES_BY_KEY } from './postfix-config-files.js';
import { logger } from '../logger.js';

// Postfix has no admin socket or API: queue state, queue control, and reloads
// run through the service's robin-agent (postqueue/postsuper/postcat/postfix),
// or queue depth alone comes from a postfix_exporter in HTTP mode.
// The agent writes the check maps here; main.cf references them by this path.
const APPLIED_DIR = '/etc/postfix';
const MANAGED_MAIN_FILE = 'robin-managed.cf';
const MANAGED_HEADER_CHECKS_FILE = 'robin-header_checks';
const MANAGED_BODY_CHECKS_FILE = 'robin-body_checks';
const HTTP_TIMEOUT_MS = 8000;

// The reserved 'default' scope is the shared base config. It has no
// fleet_services row, so the service resolver/probes must tolerate it.
const DEFAULT_SCOPE_ID = 'default';
const DEFAULT_SCOPE_NAME = 'Default (base)';

// Operational Postfix knobs safe to manage from robin-admin. Structural config
// (myhostname, mynetworks, inet_*, virtual/pgsql maps, transport_maps, restriction
// chains, TLS, master.cf topology, relay.py content filter) stays ansible-owned
// and is NEVER written here.
export interface PostfixManagedConfig {
  messageSizeLimit: number;                 // bytes; 0 = unlimited
  mailboxSizeLimit: number;                 // bytes; 0 = unlimited
  maximalQueueLifetime: string;             // e.g. "1h", "5d"
  bounceQueueLifetime: string;              // e.g. "1h"
  defaultProcessLimit: number;
  defaultDestinationConcurrencyLimit: number;
  smtpdClientConnectionCountLimit: number;  // 0 = unlimited
  smtpdClientConnectionRateLimit: number;
  smtpdClientMessageRateLimit: number;
  smtpdClientRecipientRateLimit: number;
  smtpdClientAuthRateLimit: number;
  notifyClasses: string;                    // e.g. "resource, software"
  headerChecks: string[];                   // pcre/regexp lines → header_checks map
  bodyChecks: string[];                     // pcre/regexp lines → body_checks map
}

const DEFAULT_POSTFIX_CONFIG: PostfixManagedConfig = {
  messageSizeLimit: 20480000,
  mailboxSizeLimit: 0,
  maximalQueueLifetime: '1h',
  bounceQueueLifetime: '1h',
  defaultProcessLimit: 300,
  defaultDestinationConcurrencyLimit: 50,
  smtpdClientConnectionCountLimit: 0,
  smtpdClientConnectionRateLimit: 0,
  smtpdClientMessageRateLimit: 0,
  smtpdClientRecipientRateLimit: 0,
  smtpdClientAuthRateLimit: 0,
  notifyClasses: 'resource, software',
  headerChecks: [],
  bodyChecks: [],
};

function normalizeInteger(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeLines(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((l): l is string => typeof l === 'string').map((l) => l.trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split('\n').map((l) => l.trim()).filter(Boolean);
  }
  return [];
}

function normalizePostfixConfig(value: unknown): PostfixManagedConfig {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_POSTFIX_CONFIG, headerChecks: [], bodyChecks: [] };
  }
  const s = value as Record<string, unknown>;
  return {
    messageSizeLimit: normalizeInteger(s.messageSizeLimit, DEFAULT_POSTFIX_CONFIG.messageSizeLimit),
    mailboxSizeLimit: normalizeInteger(s.mailboxSizeLimit, DEFAULT_POSTFIX_CONFIG.mailboxSizeLimit),
    maximalQueueLifetime: normalizeString(s.maximalQueueLifetime, DEFAULT_POSTFIX_CONFIG.maximalQueueLifetime),
    bounceQueueLifetime: normalizeString(s.bounceQueueLifetime, DEFAULT_POSTFIX_CONFIG.bounceQueueLifetime),
    defaultProcessLimit: normalizeInteger(s.defaultProcessLimit, DEFAULT_POSTFIX_CONFIG.defaultProcessLimit),
    defaultDestinationConcurrencyLimit: normalizeInteger(s.defaultDestinationConcurrencyLimit, DEFAULT_POSTFIX_CONFIG.defaultDestinationConcurrencyLimit),
    smtpdClientConnectionCountLimit: normalizeInteger(s.smtpdClientConnectionCountLimit, DEFAULT_POSTFIX_CONFIG.smtpdClientConnectionCountLimit),
    smtpdClientConnectionRateLimit: normalizeInteger(s.smtpdClientConnectionRateLimit, DEFAULT_POSTFIX_CONFIG.smtpdClientConnectionRateLimit),
    smtpdClientMessageRateLimit: normalizeInteger(s.smtpdClientMessageRateLimit, DEFAULT_POSTFIX_CONFIG.smtpdClientMessageRateLimit),
    smtpdClientRecipientRateLimit: normalizeInteger(s.smtpdClientRecipientRateLimit, DEFAULT_POSTFIX_CONFIG.smtpdClientRecipientRateLimit),
    smtpdClientAuthRateLimit: normalizeInteger(s.smtpdClientAuthRateLimit, DEFAULT_POSTFIX_CONFIG.smtpdClientAuthRateLimit),
    notifyClasses: normalizeString(s.notifyClasses, DEFAULT_POSTFIX_CONFIG.notifyClasses),
    headerChecks: normalizeLines(s.headerChecks),
    bodyChecks: normalizeLines(s.bodyChecks),
  };
}

export interface PostfixConfigState {
  serviceId: string;
  serviceName: string;
  managed: PostfixManagedConfig;
  /** Additional per-file managed configs (robin-tls.cf, robin-restrictions.cf, …). */
  managedFiles: ManagedFileEntry[];
}

export interface PostfixLiveMetrics {
  serviceId: string;
  serviceType: 'postfix';
  timestamp: Date;
  reachable: boolean;
  queueActive: number;
  queueDeferred: number;
  queueHold: number;
  queueIncoming: number;
  queueTotal: number;
  oldestDeferredAgeSecs: number;
  messagesDelivered: number;
  messagesDeferred: number;
  messagesBounced: number;
  messagesRejected: number;
  rawStats: string;
}

async function getResolvedService(serviceId: string) {
  const service = await getFleetServiceById(serviceId);
  if (!service || service.serviceType !== 'postfix') {
    throw new Error('Postfix service not found');
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

export async function getPostfixConfigState(serviceId: string): Promise<PostfixConfigState> {
  // The 'default' base layer is the shared base; an instance scope layers its
  // override delta on top (core object deep-merged, files effective).
  const [serviceName, payload, managedFiles] = await Promise.all([
    resolveScopeName(serviceId),
    readLayeredPayload(POSTFIX_CONFIG_STORE_TABLE, 'service_id', serviceId, 'managed.json'),
    getManagedFileEntries(POSTFIX_CONFIG_STORE_TABLE, 'service_id', serviceId, POSTFIX_MANAGED_FILES),
  ]);
  return {
    serviceId,
    serviceName,
    managed: normalizePostfixConfig(payload),
    managedFiles,
  };
}

/** All config scopes: the 'default' base plus every per-instance override owner. */
export async function listPostfixConfigScopes(): Promise<string[]> {
  return listConfigStoreOwners(POSTFIX_CONFIG_STORE_TABLE, 'service_id');
}

/** Reset one file's override at a scope: a managed file, or the core object. */
export async function resetPostfixConfigFile(serviceId: string, key: string): Promise<PostfixConfigState> {
  if (serviceId === DEFAULT_SCOPE_ID) {
    throw new Error('The default base scope has no override to reset');
  }
  const def = POSTFIX_MANAGED_FILES_BY_KEY[key];
  if (def) {
    await resetManagedFileEntry(POSTFIX_CONFIG_STORE_TABLE, 'service_id', serviceId, def);
  } else {
    // A core section (limits/ratelimits/checks) — they share managed.json + the
    // rendered main.cf and check-map files.
    await Promise.all([
      deleteConfigStoreEntry(POSTFIX_CONFIG_STORE_TABLE, 'service_id', serviceId, 'managed.json'),
      deleteConfigStoreEntry(POSTFIX_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_MAIN_FILE),
      deleteConfigStoreEntry(POSTFIX_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_HEADER_CHECKS_FILE),
      deleteConfigStoreEntry(POSTFIX_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_BODY_CHECKS_FILE),
    ]);
  }
  return getPostfixConfigState(serviceId);
}

/** Save one per-file managed Postfix config (robin-tls.cf, …). */
export async function savePostfixManagedFile(
  serviceId: string,
  key: string,
  values: unknown,
): Promise<ManagedFileEntry> {
  const def = POSTFIX_MANAGED_FILES_BY_KEY[key];
  if (!def) {
    throw new Error(`Unknown Postfix managed file: ${key}`);
  }
  return saveManagedFileEntry(POSTFIX_CONFIG_STORE_TABLE, 'service_id', serviceId, def, values);
}

const MANAGED_HEADER = '# Managed by Robin Admin — do not edit by hand. Operational main.cf overrides only.';

// Render the managed knobs as `key = value` lines (postconf format). The apply
// unit feeds each non-comment line to `postconf -e`, so this is both the on-host
// artifact and the UI preview. header/body_checks point at the sibling map files.
export function renderPostfixConfig(managed: PostfixManagedConfig): string {
  const lines: string[] = [
    MANAGED_HEADER,
    `message_size_limit = ${managed.messageSizeLimit}`,
    `mailbox_size_limit = ${managed.mailboxSizeLimit}`,
    `maximal_queue_lifetime = ${managed.maximalQueueLifetime}`,
    `bounce_queue_lifetime = ${managed.bounceQueueLifetime}`,
    `default_process_limit = ${managed.defaultProcessLimit}`,
    `default_destination_concurrency_limit = ${managed.defaultDestinationConcurrencyLimit}`,
    `smtpd_client_connection_count_limit = ${managed.smtpdClientConnectionCountLimit}`,
    `smtpd_client_connection_rate_limit = ${managed.smtpdClientConnectionRateLimit}`,
    `smtpd_client_message_rate_limit = ${managed.smtpdClientMessageRateLimit}`,
    `smtpd_client_recipient_rate_limit = ${managed.smtpdClientRecipientRateLimit}`,
    `smtpd_client_auth_rate_limit = ${managed.smtpdClientAuthRateLimit}`,
    `notify_classes = ${managed.notifyClasses}`,
  ];
  if (managed.headerChecks.length > 0) {
    lines.push(`header_checks = regexp:${APPLIED_DIR}/${MANAGED_HEADER_CHECKS_FILE}`);
  }
  if (managed.bodyChecks.length > 0) {
    lines.push(`body_checks = regexp:${APPLIED_DIR}/${MANAGED_BODY_CHECKS_FILE}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderPostfixCheckFile(kind: 'header' | 'body', managed: PostfixManagedConfig): string {
  const rules = kind === 'header' ? managed.headerChecks : managed.bodyChecks;
  return `# Managed by Robin Admin — ${kind}_checks (regexp). One rule per line.\n${rules.join('\n')}\n`;
}

export async function savePostfixManagedConfig(
  serviceId: string,
  patch: Partial<PostfixManagedConfig>,
): Promise<PostfixConfigState> {
  const current = await getPostfixConfigState(serviceId);
  const merged = normalizePostfixConfig({ ...current.managed, ...patch });
  // The managed values (drives the form) — base scope stores full, instance
  // stores only the delta. Metadata; the agent skips *.json.
  await writeLayeredPayload(POSTFIX_CONFIG_STORE_TABLE, 'service_id', serviceId, 'managed.json', merged as unknown as Record<string, unknown>);
  // The rendered files (full effective) — this is what the fleet agent writes + reloads.
  await upsertConfigStorePayload(POSTFIX_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_MAIN_FILE, {
    content: renderPostfixConfig(merged),
    managedBy: 'robin-admin',
  });
  await upsertConfigStorePayload(POSTFIX_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_HEADER_CHECKS_FILE, {
    content: renderPostfixCheckFile('header', merged),
    managedBy: 'robin-admin',
  });
  await upsertConfigStorePayload(POSTFIX_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_BODY_CHECKS_FILE, {
    content: renderPostfixCheckFile('body', merged),
    managedBy: 'robin-admin',
  });

  return { serviceId, serviceName: current.serviceName, managed: merged, managedFiles: current.managedFiles };
}

interface PostfixQueueCounts {
  queueActive: number;
  queueDeferred: number;
  queueHold: number;
  queueIncoming: number;
  queueTotal: number;
  oldestDeferredAgeSecs: number;
}

interface PostqueueEntry {
  queue_name?: string;
  queue_id?: string;
  arrival_time?: number;
  message_size?: number;
  forced_expire?: boolean;
  sender?: string;
  recipients?: Array<{ address?: string; delay_reason?: string }>;
}

// `postqueue -j` prints one JSON object per queued message; anything else on
// the stream (warnings) is skipped.
function parsePostqueueEntries(raw: string): PostqueueEntry[] {
  const entries: PostqueueEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    try {
      entries.push(JSON.parse(trimmed) as PostqueueEntry);
    } catch {
      // not a queue record
    }
  }
  return entries;
}

// Count messages per queue and track the oldest deferred arrival for an age gauge.
export function parsePostqueueJson(raw: string, nowEpoch: number): PostfixQueueCounts {
  const counts: PostfixQueueCounts = {
    queueActive: 0, queueDeferred: 0, queueHold: 0, queueIncoming: 0, queueTotal: 0, oldestDeferredAgeSecs: 0,
  };
  let oldestDeferredArrival = Number.POSITIVE_INFINITY;
  for (const obj of parsePostqueueEntries(raw)) {
    const q = (obj.queue_name || '').toLowerCase();
    counts.queueTotal += 1;
    if (q === 'active') counts.queueActive += 1;
    else if (q === 'deferred') {
      counts.queueDeferred += 1;
      if (typeof obj.arrival_time === 'number') oldestDeferredArrival = Math.min(oldestDeferredArrival, obj.arrival_time);
    }
    else if (q === 'hold') counts.queueHold += 1;
    else if (q === 'incoming' || q === 'maildrop') counts.queueIncoming += 1;
  }
  if (Number.isFinite(oldestDeferredArrival)) {
    counts.oldestDeferredAgeSecs = Math.max(0, nowEpoch - oldestDeferredArrival);
  }
  return counts;
}

export interface PostfixQueueMessage {
  queueId: string;
  queueName: string;
  arrivalTime: string | null;
  size: number;
  sender: string;
  recipients: Array<{ address: string; delayReason: string | null }>;
  forcedExpire: boolean;
}

export function parsePostqueueMessages(raw: string): PostfixQueueMessage[] {
  return parsePostqueueEntries(raw)
    .filter((entry) => typeof entry.queue_id === 'string' && entry.queue_id)
    .map((entry) => ({
      queueId: entry.queue_id as string,
      queueName: (entry.queue_name || 'unknown').toLowerCase(),
      arrivalTime: typeof entry.arrival_time === 'number' ? new Date(entry.arrival_time * 1000).toISOString() : null,
      size: typeof entry.message_size === 'number' ? entry.message_size : 0,
      sender: entry.sender ?? '',
      recipients: (entry.recipients ?? []).map((r) => ({ address: r.address ?? '', delayReason: r.delay_reason || null })),
      forcedExpire: entry.forced_expire === true,
    }))
    .sort((a, b) => (a.arrivalTime ?? '').localeCompare(b.arrivalTime ?? ''));
}

export interface PostfixMessageCounters {
  messagesDelivered: number;
  messagesDeferred: number;
  messagesBounced: number;
  messagesRejected: number;
}

// Delivery agents log one `status=` line per recipient; smtpd/postscreen/cleanup
// log `reject:` for refused mail. Multi-instance setups prefix the syslog name
// (postfix-out/smtp), which the [\w.-]* covers.
const DELIVERY_STATUS_RE = /\bpostfix[\w.-]*\/(?:[\w-]+\/)*(smtp|lmtp|local|virtual|pipe|error|discard)\[\d+\]: [0-9A-Za-z]+: to=<.*?, status=(sent|deferred|bounced)\b/;
// An SMTP handoff to a loopback relay is a content-filter hop (e.g. a filter
// on 127.0.0.1:10025); the message is counted again when it leaves for real.
// LMTP to loopback stays counted: that is final delivery to the mailbox store.
const LOOPBACK_RELAY_RE = /, relay=[^,\s]*\[(?:127\.\d+\.\d+\.\d+|::1)\]:\d+,/;
const REJECT_RE = /\bpostfix[\w.-]*\/(?:[\w-]+\/)*(?:smtpd|postscreen|cleanup)\[\d+\]: (?:NOQUEUE|[0-9A-Za-z]+): reject:/;

/** Count delivery outcomes (per recipient) and rejections in Postfix log lines. */
export function countPostfixLogLines(lines: string[]): PostfixMessageCounters {
  const counts: PostfixMessageCounters = { messagesDelivered: 0, messagesDeferred: 0, messagesBounced: 0, messagesRejected: 0 };
  for (const line of lines) {
    const [, agent, status] = DELIVERY_STATUS_RE.exec(line) ?? [];
    if (status === 'sent' && agent === 'smtp' && LOOPBACK_RELAY_RE.test(line)) continue;
    if (status === 'sent') counts.messagesDelivered += 1;
    else if (status === 'deferred') counts.messagesDeferred += 1;
    else if (status === 'bounced') counts.messagesBounced += 1;
    else if (REJECT_RE.test(line)) counts.messagesRejected += 1;
  }
  return counts;
}

/**
 * Assemble a PostfixLiveMetrics from raw `postqueue -j` output shipped by the
 * service's robin-agent, plus the cumulative log-derived message counters.
 */
export function buildPostfixSnapshotFromRaw(
  serviceId: string,
  postqueueJson: string,
  counters: PostfixMessageCounters = { messagesDelivered: 0, messagesDeferred: 0, messagesBounced: 0, messagesRejected: 0 },
): PostfixLiveMetrics {
  const counts = parsePostqueueJson(postqueueJson, Math.floor(Date.now() / 1000));
  return {
    serviceId,
    serviceType: 'postfix',
    timestamp: new Date(),
    reachable: true,
    ...counts,
    ...counters,
    rawStats: postqueueJson.slice(0, 8000),
  };
}

// Parse a postfix_exporter (kumina/hsn) OpenMetrics endpoint. Queue depth comes
// from the showq histogram counts per queue; `postfix_up` is reachability.
export function parsePostfixExporter(raw: string): Partial<PostfixLiveMetrics> {
  const out: Partial<PostfixLiveMetrics> = {};
  let total = 0;
  for (const line of raw.split('\n')) {
    const showq = line.trim().match(/^postfix_showq_message_size_bytes_count\{queue="([^"]+)"\}\s+([0-9.]+)/);
    if (!showq) continue;
    const n = Math.round(Number.parseFloat(showq[2]));
    const q = showq[1].toLowerCase();
    if (q === 'active') out.queueActive = n;
    else if (q === 'deferred') out.queueDeferred = n;
    else if (q === 'hold') out.queueHold = n;
    else if (q === 'incoming' || q === 'maildrop') out.queueIncoming = n;
    total += n;
  }
  if (total > 0 || out.queueActive !== undefined) out.queueTotal = total;
  return out;
}

function isHttpMetricsUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim());
}

// HTTP mode: scrape a postfix_exporter for queue depth.
async function collectHttpPostfixMetrics(base: PostfixLiveMetrics, metricsUrl: string): Promise<PostfixLiveMetrics> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let text: string;
    try {
      const res = await fetch(metricsUrl, { signal: controller.signal });
      if (!res.ok) {
        logger.warn('Postfix exporter returned non-OK', { metricsUrl, status: res.status });
        return base;
      }
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    Object.assign(base, parsePostfixExporter(text));
    base.rawStats = text.slice(0, 8000);
    base.reachable = !/^postfix_up\s+0/m.test(text);
  } catch (error) {
    logger.warn('Postfix exporter fetch failed', { metricsUrl, error: (error as Error).message });
  }
  return base;
}

/** Direct (non-agent) metrics: a postfix_exporter when a metrics URL is registered. */
export async function getPostfixLiveMetrics(serviceId: string): Promise<PostfixLiveMetrics> {
  const base: PostfixLiveMetrics = {
    serviceId,
    serviceType: 'postfix',
    timestamp: new Date(),
    reachable: false,
    queueActive: 0,
    queueDeferred: 0,
    queueHold: 0,
    queueIncoming: 0,
    queueTotal: 0,
    oldestDeferredAgeSecs: 0,
    messagesDelivered: 0,
    messagesDeferred: 0,
    messagesBounced: 0,
    messagesRejected: 0,
    rawStats: '',
  };

  // The 'default' base layer has no running server to probe.
  if (serviceId === DEFAULT_SCOPE_ID) {
    return base;
  }

  const service = await getResolvedService(serviceId);
  return isHttpMetricsUrl(service.metricsUrl) ? collectHttpPostfixMetrics(base, service.metricsUrl) : base;
}

// ── Agent-backed operations ─────────────────────────────────────────────────

export type PostfixQueueAction = 'hold' | 'release' | 'requeue' | 'delete';

async function runPostfix(serviceId: string, action: AgentCommandAction, args: Record<string, unknown> = {}, axis: 'metrics' | 'config' = 'metrics'): Promise<string> {
  const service = await getResolvedService(serviceId);
  const agentId = commandAgentFor(service, axis);
  if (!agentId) {
    throw new Error('This Postfix service has no robin-agent to run queue commands');
  }
  return runAgentCommand(agentId, service, action, args);
}

export async function listPostfixQueue(serviceId: string): Promise<PostfixQueueMessage[]> {
  return parsePostqueueMessages(await runPostfix(serviceId, 'postfix.queue.list'));
}

export async function showPostfixMessage(serviceId: string, queueId: string): Promise<string> {
  return runPostfix(serviceId, 'postfix.queue.show', { queueId });
}

export async function applyPostfixQueueAction(serviceId: string, action: PostfixQueueAction, queueIds: string[]): Promise<string> {
  return (await runPostfix(serviceId, `postfix.queue.${action}`, { queueIds })).trim();
}

export async function deliverPostfixMessage(serviceId: string, queueId: string): Promise<string> {
  return (await runPostfix(serviceId, 'postfix.queue.deliver', { queueId })).trim() || 'Delivery attempt scheduled';
}

// Attempt immediate delivery of all deferred mail (`postqueue -f`).
export async function flushPostfixQueue(serviceId: string): Promise<string> {
  return (await runPostfix(serviceId, 'postfix.queue.flush')).trim() || 'Queue flush requested';
}

// `postfix check` then `postfix reload` on the host, via the config agent.
export async function reloadPostfix(serviceId: string): Promise<string> {
  return (await runPostfix(serviceId, 'postfix.reload', {}, 'config')).trim() || 'Reload signal sent';
}
