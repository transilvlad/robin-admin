/**
 * Per-file managed config for Rspamd, modelled after Robin's per-file config
 * store: each real Rspamd config file (local.d/redis.conf, logging.inc, …) is a
 * first-class managed file with a typed set of values and a renderer that turns
 * those values into the UCL text the agent writes into local.d.
 *
 * This is additive to the existing dkim/bayes managed files (which are entangled
 * with DKIM-domain + secret machinery and stay as they are). Values are stored
 * as a JSON payload per file (`<key>.values.json`) in rspamd_config_store; the
 * rendered `.conf`/`.inc` is stored under its real name and applied by the agent.
 *
 * Field metadata (labels/help/types) lives on the client so it can render the
 * forms generically; here we own the defaults, normalization, and rendering.
 */

const MANAGED_MARKER = '# Managed by Robin Admin';

export interface RspamdManagedFileDef<T extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable key used in the API + client catalog (e.g. 'redis'). */
  key: string;
  /** Real file name written into local.d (e.g. 'redis.conf'). */
  fileName: string;
  defaults: T;
  /** Coerce an arbitrary stored/incoming payload to the typed, validated shape. */
  normalize: (raw: unknown) => T;
  /** Render the UCL config text (including the managed marker). */
  render: (values: T) => string;
}

// ── small coercion helpers ──────────────────────────────────────────────────
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}
/** UCL-quote a string value. */
function q(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── redis.conf — the global Redis backend (Bayes/fuzzy/ratelimit/replies) ────
export interface RspamdRedisFile extends Record<string, unknown> {
  servers: string;
  db: string;
  password: string;
  timeout: number;
  expandKeys: boolean;
}
const redisFile: RspamdManagedFileDef<RspamdRedisFile> = {
  key: 'redis',
  fileName: 'redis.conf',
  defaults: { servers: 'redis-backend:6379', db: '', password: '', timeout: 10, expandKeys: false },
  normalize: (raw) => {
    const r = isRecord(raw) ? raw : {};
    return {
      servers: str(r.servers, 'redis-backend:6379'),
      db: str(r.db, ''),
      password: str(r.password, ''),
      timeout: Math.max(1, num(r.timeout, 10)),
      expandKeys: bool(r.expandKeys, false),
    };
  },
  render: (v) => [
    MANAGED_MARKER,
    `servers = ${q(v.servers)};`,
    v.db.trim() ? `db = ${q(v.db.trim())};` : '',
    v.password.trim() ? `password = ${q(v.password.trim())};` : '',
    `timeout = ${v.timeout};`,
    v.expandKeys ? 'expand_keys = true;' : '',
    '',
  ].filter(Boolean).join('\n'),
};

// ── logging.inc ──────────────────────────────────────────────────────────────
const LOG_TYPES = ['file', 'console', 'syslog'] as const;
const LOG_LEVELS = ['error', 'warning', 'info', 'debug', 'silent'] as const;
export interface RspamdLoggingFile extends Record<string, unknown> {
  type: typeof LOG_TYPES[number];
  filename: string;
  level: typeof LOG_LEVELS[number];
  logReCache: boolean;
  logUsec: boolean;
  systemd: boolean;
}
const loggingFile: RspamdManagedFileDef<RspamdLoggingFile> = {
  key: 'logging',
  fileName: 'logging.inc',
  defaults: { type: 'file', filename: '/var/log/rspamd.log', level: 'info', logReCache: true, logUsec: false, systemd: false },
  normalize: (raw) => {
    const r = isRecord(raw) ? raw : {};
    return {
      type: oneOf(r.type, LOG_TYPES, 'file'),
      filename: str(r.filename, '/var/log/rspamd.log'),
      level: oneOf(r.level, LOG_LEVELS, 'info'),
      logReCache: bool(r.logReCache, true),
      logUsec: bool(r.logUsec, false),
      systemd: bool(r.systemd, false),
    };
  },
  render: (v) => [
    MANAGED_MARKER,
    `type = ${q(v.type)};`,
    v.type === 'file' ? `filename = ${q(v.filename)};` : '',
    `level = ${q(v.level)};`,
    `log_re_cache = ${v.logReCache ? 'true' : 'false'};`,
    `log_usec = ${v.logUsec ? 'true' : 'false'};`,
    v.systemd ? 'systemd = true;' : '',
    '',
  ].filter(Boolean).join('\n'),
};

// ── options.inc — global scan/DNS options ───────────────────────────────────
export interface RspamdOptionsFile extends Record<string, unknown> {
  dnsTimeout: number;
  dnsRetransmits: number;
  taskTimeout: number;
  maxRecipients: number;
  checkAllFilters: boolean;
}
const optionsFile: RspamdManagedFileDef<RspamdOptionsFile> = {
  key: 'options',
  fileName: 'options.inc',
  defaults: { dnsTimeout: 1, dnsRetransmits: 5, taskTimeout: 8, maxRecipients: 1024, checkAllFilters: false },
  normalize: (raw) => {
    const r = isRecord(raw) ? raw : {};
    return {
      dnsTimeout: Math.max(1, num(r.dnsTimeout, 1)),
      dnsRetransmits: Math.max(1, num(r.dnsRetransmits, 5)),
      taskTimeout: Math.max(1, num(r.taskTimeout, 8)),
      maxRecipients: Math.max(1, num(r.maxRecipients, 1024)),
      checkAllFilters: bool(r.checkAllFilters, false),
    };
  },
  render: (v) => [
    MANAGED_MARKER,
    `task_timeout = ${v.taskTimeout}s;`,
    `max_recipients = ${v.maxRecipients};`,
    v.checkAllFilters ? 'check_all_filters = true;' : '',
    'dns {',
    `  timeout = ${v.dnsTimeout}s;`,
    `  retransmits = ${v.dnsRetransmits};`,
    '}',
    '',
  ].filter(Boolean).join('\n'),
};

// ── worker-normal.inc — the scanning worker ─────────────────────────────────
export interface RspamdWorkerNormalFile extends Record<string, unknown> {
  count: number;
  maxTasks: number;
  bindSocket: string;
}
const workerNormalFile: RspamdManagedFileDef<RspamdWorkerNormalFile> = {
  key: 'worker_normal',
  fileName: 'worker-normal.inc',
  defaults: { count: 1, maxTasks: 0, bindSocket: '*:11333' },
  normalize: (raw) => {
    const r = isRecord(raw) ? raw : {};
    return {
      count: Math.max(1, num(r.count, 1)),
      maxTasks: Math.max(0, num(r.maxTasks, 0)),
      bindSocket: str(r.bindSocket, '*:11333'),
    };
  },
  render: (v) => [
    MANAGED_MARKER,
    `count = ${v.count};`,
    v.maxTasks > 0 ? `max_tasks = ${v.maxTasks};` : '',
    v.bindSocket.trim() ? `bind_socket = ${q(v.bindSocket.trim())};` : '',
    '',
  ].filter(Boolean).join('\n'),
};

/** Registry of the additional per-file managed Rspamd configs, in display order. */
// Cast through unknown: each def is generic in its value shape, and the registry
// erases that to the base Record type (render is contravariant in its param, so a
// direct cast is rejected — the erasure is intentional and safe here).
export const RSPAMD_MANAGED_FILES: RspamdManagedFileDef[] = [
  redisFile as unknown as RspamdManagedFileDef,
  loggingFile as unknown as RspamdManagedFileDef,
  optionsFile as unknown as RspamdManagedFileDef,
  workerNormalFile as unknown as RspamdManagedFileDef,
];

export const RSPAMD_MANAGED_FILES_BY_KEY: Record<string, RspamdManagedFileDef> =
  Object.fromEntries(RSPAMD_MANAGED_FILES.map((f) => [f.key, f]));

/** The config-store payload file name that holds a managed file's typed values. */
export function valuesStoreFileName(key: string): string {
  return `robin-admin.${key}.values.json`;
}
