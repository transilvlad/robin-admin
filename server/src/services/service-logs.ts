import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFleetServiceById, type FleetService } from '../db/queries/fleet-services.js';
import { getAgentServiceLogs, storeAgentServiceLogs } from '../db/queries/fleet-agent-logs.js';
import { getRspamdAuthHeaders } from './metrics-poller.js';
import { type FleetServiceType } from './service-types.js';
import { logger } from '../logger.js';
import { getConfig } from '../db/queries/config.js';

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 8000;
const HTTP_TIMEOUT_MS = 6000;
const MAX_LINES = 1000;
const DEFAULT_LINES = 200;

export interface ServiceLogsResult {
  serviceType: FleetServiceType;
  serviceId: string;
  source: string;
  available: boolean;
  lines: string[];
  error?: string;
}

const CO_LOCATED_MSG = 'Logs are only readable when robin-admin is co-located with the service (host deploy). '
  + 'No reachable journald unit or log file for this service in the current environment.';

async function clampLines(n: number): Promise<number> {
  const config = await getConfig();
  const defaultLines = Math.max(1, Math.min(10000, config.logDefaultLines || DEFAULT_LINES));
  const maxLines = Math.max(defaultLines, Math.min(10000, config.logMaxLines || MAX_LINES));
  if (!Number.isFinite(n) || n <= 0) return defaultLines;
  return Math.min(Math.floor(n), maxLines);
}

// ── Co-located / host-mounted sources (journald → log file / dir) ──────────
// Any of three shapes, tried in order: a journald `unit`, a fixed `file`, or a
// `dir` + `glob` whose newest match is tailed (for date-rotated logs like
// Robin's YYYYMMDD.log). Env overrides: <TYPE>_LOG_UNIT / _LOG_FILE / _LOG_DIR.
// The dir/file can be the service's own log bind-mounted read-only into
// robin-admin — the "read it from the host when co-located on the docker host"
// path; a <TYPE>_LOG_URL sidecar covers the fully off-host case.
interface FileLogSource { unit?: string; file?: string; dir?: string; glob?: string; filter?: string }
const FILE_LOG_SOURCES: Partial<Record<FleetServiceType, FileLogSource>> = {
  clamav: { unit: 'clamav-daemon', file: '/var/log/clamav/clamav.log' },
  cyrus: { unit: 'cyrus-imapd', file: '/var/log/mail.log', filter: 'cyrus/' },
  dovecot: { unit: 'dovecot', file: '/var/log/mail.log', filter: 'dovecot' },
  postfix: { unit: 'postfix@-', file: '/var/log/mail.log', filter: 'postfix/' },
  redis: { unit: 'redis-server', file: '/var/log/redis/redis-server.log' },
  postgres: { unit: 'postgresql', dir: '/var/log/postgresql', glob: '*.log' },
  mariadb: { unit: 'mariadb', file: '/var/log/mysql/error.log' },
  // Robin (the Java MTA) has no log HTTP endpoint; it writes date-rotated files.
  robin: { unit: 'robin', dir: '/var/log/robin', glob: '*.log' },
};

function resolveFileSource(serviceType: FleetServiceType): FileLogSource | null {
  const base = FILE_LOG_SOURCES[serviceType];
  if (!base) return null;
  const T = serviceType.toUpperCase();
  const envUnit = process.env[`${T}_LOG_UNIT`];
  const envFile = process.env[`${T}_LOG_FILE`];
  const envDir = process.env[`${T}_LOG_DIR`];
  return {
    unit: envUnit || base.unit,
    file: envFile || base.file,
    dir: envDir || base.dir,
    glob: base.glob,
    // A dedicated per-service log (explicit file or a dir of them) is unfiltered.
    filter: envFile || envDir ? undefined : base.filter,
  };
}

async function readJournald(unit: string, lines: number, filter?: string): Promise<string[]> {
  const args = ['-u', unit, '-n', String(lines), '--no-pager', '-o', 'short-iso'];
  if (filter) args.push('--grep', filter);
  const { stdout } = await execFileAsync('journalctl', args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  return stdout.split('\n').filter((l) => l.trim() && !/^-- No entries --/.test(l));
}

function tailPipe(fileExpr: string, lines: number, filter?: string): string {
  const rawTail = filter ? lines * 20 : lines;
  return filter
    ? `tail -n ${rawTail} ${fileExpr} | grep -F ${JSON.stringify(filter)} | tail -n ${lines}`
    : `tail -n ${lines} ${fileExpr}`;
}

async function readLogFile(file: string, lines: number, filter?: string): Promise<string[]> {
  // `test -f` guard so a `tail | grep` pipe can't exit 0 on a missing file.
  const cmd = `test -f ${JSON.stringify(file)} && { ${tailPipe(JSON.stringify(file), lines, filter)}; }`;
  const { stdout } = await execFileAsync('sh', ['-c', cmd], { timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  return stdout.split('\n').filter((l) => l.trim());
}

// Tail the newest file matching <dir>/<glob> — for services that rotate the
// active log by filename (Robin's YYYYMMDD.log), so "latest" tracks the date.
async function readLatestInDir(dir: string, glob: string, lines: number, filter?: string): Promise<string[]> {
  const pattern = `${dir.replace(/\/$/, '')}/${glob}`;
  const pick = `f=$(ls -1t ${pattern} 2>/dev/null | head -1)`;
  const cmd = `${pick}; test -n "$f" && test -f "$f" && { ${tailPipe('"$f"', lines, filter)}; }`;
  const { stdout } = await execFileAsync('sh', ['-c', cmd], { timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  return stdout.split('\n').filter((l) => l.trim());
}

async function readFileSource(serviceType: FleetServiceType, serviceId: string, lines: number): Promise<ServiceLogsResult> {
  const base: ServiceLogsResult = { serviceType, serviceId, source: '', available: false, lines: [] };
  const source = resolveFileSource(serviceType);
  if (!source) return { ...base, error: CO_LOCATED_MSG };

  if (source.unit) {
    try {
      const out = await readJournald(source.unit, lines, source.filter);
      return { ...base, source: `journalctl -u ${source.unit}`, available: true, lines: out };
    } catch (error) {
      logger.debug('journalctl read failed, trying log file', { serviceType, error: (error as Error).message });
    }
  }
  if (source.file) {
    try {
      const out = await readLogFile(source.file, lines, source.filter);
      return { ...base, source: source.file, available: true, lines: out };
    } catch (error) {
      logger.debug('log file read failed', { serviceType, file: source.file, error: (error as Error).message });
    }
  }
  if (source.dir && source.glob) {
    try {
      const out = await readLatestInDir(source.dir, source.glob, lines, source.filter);
      return { ...base, source: `${source.dir}/${source.glob} (latest)`, available: true, lines: out };
    } catch (error) {
      logger.debug('log dir read failed', { serviceType, dir: source.dir, error: (error as Error).message });
    }
  }
  return { ...base, source: source.unit || source.file || source.dir || 'unknown', error: CO_LOCATED_MSG };
}

// ── HTTP source — Rspamd controller /errors (works cross-container) ────────
function rspamdControllerBase(service: FleetService): string | null {
  return service.controllerUrl ?? service.metricsUrl ?? service.apiUrl;
}

async function readRspamdErrors(service: FleetService, lines: number): Promise<ServiceLogsResult> {
  const base: ServiceLogsResult = { serviceType: 'rspamd', serviceId: service.serviceId, source: '', available: false, lines: [] };
  const controllerBase = rspamdControllerBase(service);
  if (!controllerBase) {
    return { ...base, error: 'Rspamd service has no controller URL configured.' };
  }
  const url = `${controllerBase.replace(/\/$/, '')}/errors`;
  try {
    const headers = await getRspamdAuthHeaders(service.serviceId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let text: string;
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (!res.ok) {
        return { ...base, source: url, error: `Rspamd controller returned HTTP ${res.status} for /errors (controller password required).` };
      }
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    const parsed = JSON.parse(text) as Array<Record<string, unknown>>;
    const rows = Array.isArray(parsed) ? parsed : [];
    const formatted = rows.slice(-lines).map((e) => {
      const ts = typeof e.ts === 'number' ? new Date(e.ts * 1000).toISOString() : (e.ts ?? '');
      const parts = [ts, e.type, e.module, e.id].filter(Boolean).join(' ');
      return `${parts}: ${e.message ?? ''}`.trim();
    });
    return { ...base, source: url, available: true, lines: formatted };
  } catch (error) {
    return { ...base, source: url, error: `Rspamd /errors unavailable: ${(error as Error).message}` };
  }
}

// ── Generic HTTP log source (any type) — for off-host / separate-container ──
// Set <TYPE>_LOG_URL to a plain endpoint that returns recent log text (e.g. a
// co-located log-tail sidecar). Mirrors the metrics exec-vs-http duality.
async function readHttpLog(serviceType: FleetServiceType, serviceId: string, url: string, lines: number): Promise<ServiceLogsResult> {
  const base: ServiceLogsResult = { serviceType, serviceId, source: url, available: false, lines: [] };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let text: string;
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return { ...base, error: `Log endpoint returned HTTP ${res.status}.` };
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    const all = text.split('\n').filter((l) => l.trim());
    return { ...base, available: true, lines: all.slice(-lines) };
  } catch (error) {
    return { ...base, error: `Log endpoint unavailable: ${(error as Error).message}` };
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

async function resolveService(serviceType: FleetServiceType, serviceId: string): Promise<FleetService> {
  const service = await getFleetServiceById(serviceId);
  if (!service || service.serviceType !== serviceType) {
    throw new Error(`${serviceType} service not found`);
  }
  return service;
}

const AGENT_LOG_MSG = 'This service is collected by an agent, which has not pushed a log tail yet. '
  + 'Logs appear once the agent has run its log collector at least once (journald unit or log file readable on the agent host).';

// An agent-mode service isn't reachable from robin-admin — the agent tails the
// log on its own host and pushes the recent lines, which we serve from storage.
async function readAgentPushedLogs(
  serviceType: FleetServiceType,
  serviceId: string,
  lines: number,
): Promise<ServiceLogsResult> {
  const base: ServiceLogsResult = { serviceType, serviceId, source: 'agent', available: false, lines: [] };
  const stored = await getAgentServiceLogs(serviceId);
  if (!stored) return { ...base, error: AGENT_LOG_MSG };
  return {
    ...base,
    source: `${stored.source} (agent, captured ${stored.capturedAt.toISOString()})`,
    available: true,
    lines: stored.lines.slice(-lines),
  };
}

/**
 * Store log lines an agent pushed for a service it owns. `reset` batches (the
 * agent's first push after start) replace the buffer; later batches carry only
 * new lines and are appended. `source` is a human label of what was followed.
 */
export async function ingestAgentLogs(serviceId: string, source: string, lines: string[], reset: boolean): Promise<number> {
  const config = await getConfig();
  const maxLines = Math.max(1, Math.min(10000, config.logMaxLines || MAX_LINES));
  const clean = lines.filter((l) => typeof l === 'string' && l.length > 0);
  const previous = reset ? [] : (await getAgentServiceLogs(serviceId))?.lines ?? [];
  await storeAgentServiceLogs(serviceId, source || 'agent', [...previous, ...clean].slice(-maxLines));
  return clean.length;
}

export async function getServiceLogs(
  serviceType: FleetServiceType,
  serviceId: string,
  requestedLines: number = DEFAULT_LINES,
): Promise<ServiceLogsResult> {
  const service = await resolveService(serviceType, serviceId);
  const lines = await clampLines(requestedLines);

  // Logs are decoupled from collection_mode: whenever an agent is assigned to
  // ship this service's logs — either its metrics agent (collection_mode='agent')
  // or an explicit logs-only log agent — serve the pushed buffer. This lets a
  // direct-metrics service (postgres/clamav) still have root-owned logs tailed by
  // a co-located agent. (A <TYPE>_LOG_URL sidecar is a direct path, ignored here.)
  if (service.logAgentId || service.collectionMode === 'agent') {
    return readAgentPushedLogs(serviceType, serviceId, lines);
  }

  // A configured HTTP log endpoint wins for any type (off-host / separate container).
  const envUrl = process.env[`${serviceType.toUpperCase()}_LOG_URL`];
  if (envUrl) {
    return readHttpLog(serviceType, serviceId, envUrl, lines);
  }
  if (serviceType === 'rspamd') {
    return readRspamdErrors(service, lines);
  }
  // robin/clamav/dovecot/postfix → co-located journald/file, or a host-mounted
  // log dir/file (see FILE_LOG_SOURCES). Unreadable here → available:false.
  return readFileSource(serviceType, serviceId, lines);
}

// Agents push every cycle (~30s), even when nothing was logged.
const AGENT_LOGS_LIVE_MS = 5 * 60_000;

/** True when an agent is actively streaming this service's log. */
export async function agentLogsLive(serviceId: string): Promise<boolean> {
  const stored = await getAgentServiceLogs(serviceId);
  return Boolean(stored && Date.now() - stored.capturedAt.getTime() < AGENT_LOGS_LIVE_MS);
}

/** Cheap availability probe used to decide whether to show the Logs nav item. */
export async function getServiceLogsAvailability(serviceType: FleetServiceType, serviceId: string): Promise<boolean> {
  try {
    const result = await getServiceLogs(serviceType, serviceId, 1);
    return result.available;
  } catch {
    return false;
  }
}
