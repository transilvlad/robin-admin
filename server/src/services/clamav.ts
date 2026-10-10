import { Socket } from 'node:net';
import {
  CLAMAV_CONFIG_STORE_TABLE,
  deleteConfigStoreEntry,
  upsertConfigStorePayload,
} from '../db/queries/config-store.js';
import { getFleetServiceById, type FleetService } from '../db/queries/fleet-services.js';
import {
  listConfigStoreOwners,
  readLayeredPayload,
  writeLayeredPayload,
} from './managed-config-file.js';

// The reserved 'default' scope is the shared base config. It has no
// fleet_services row, so the service resolver/probes must tolerate it.
const DEFAULT_SCOPE_ID = 'default';
const DEFAULT_SCOPE_NAME = 'Default (base)';

// The managed values (drive the form) are stored as `.json` metadata — the fleet
// agent skips those. The rendered `clamd.conf`/`freshclam.conf` are the real
// config files the agent writes onto the service host.
const CLAMD_VALUES_FILE = 'robin-admin.clamd.json';
const FRESHCLAM_VALUES_FILE = 'robin-admin.freshclam.json';
const CLAMD_CONF_FILE = 'clamd.conf';
const FRESHCLAM_CONF_FILE = 'freshclam.conf';

export interface ClamdManagedConfig {
  tcpAddr: string;
  tcpPort: number;
  localSocket: string;
  localSocketMode: string;
  maxScanSize: string;
  maxFileSize: string;
  maxRecursion: number;
  maxFiles: number;
  scanArchive: boolean;
  maxThreads: number;
  readTimeoutSeconds: number;
  user: string;
  logFile: string;
  logVerbose: boolean;
  virusEvent: string;
  notifyClamdOnUpdate: boolean;
  // Detection tuning
  detectPua: boolean;
  heuristicAlerts: boolean;
  scanPdf: boolean;
  scanHtml: boolean;
  scanOle2: boolean;
  maxScanTimeMs: number;
}

export interface FreshclamManagedConfig {
  enabled: boolean;
  daemon: boolean;
  checks: number;
  databaseMirror: string[];
  privateMirror: string[];
  updateLogFile: string;
  databaseOwner: string;
  notifyClamd: string;
  connectTimeoutSeconds: number;
  receiveTimeoutSeconds: number;
  httpProxyServer: string;
  httpProxyPort: number | null;
  httpProxyUsername: string;
  httpProxyPassword: string;
}

export interface ClamavConfigState {
  serviceId: string | null;
  serviceName: string | null;
  clamd: ClamdManagedConfig;
  freshclam: FreshclamManagedConfig;
}

export interface ClamavLiveMetrics {
  serviceId: string;
  serviceType: 'clamav';
  timestamp: Date;
  pingOk: boolean;
  versionText: string | null;
  engineVersion: string | null;
  databaseVersion: number | null;
  databaseUpdatedAt: Date | null;
  statusText: string | null;
  pools: number;
  threadsLive: number;
  threadsIdle: number;
  threadsMax: number;
  queueItems: number;
  memoryHeapMB: number;
  memoryMmapMB: number;
  memoryUsedMB: number;
  memoryFreeMB: number;
  memoryReleasableMB: number;
  memoryPoolsUsedMB: number;
  memoryPoolsTotalMB: number;
  rawStats: string;
}

export interface ClamavStatus extends ClamavLiveMetrics {
  serviceName: string | null;
  /** Where robin-admin reaches clamd; null when the service has no address. */
  endpoint: { host: string; port: number } | null;
  freshclam: FreshclamManagedConfig;
  privateNetworkOnly: true;
}

export interface ClamavScanResult {
  serviceId: string;
  serviceName: string | null;
  fileName: string;
  sizeBytes: number;
  clean: boolean;
  infected: boolean;
  viruses: string[];
  rawResponse: string;
  durationMs: number;
  scannedAt: string;
}

const DEFAULT_CLAMD_CONFIG: ClamdManagedConfig = {
  tcpAddr: 'antivirus-backend',
  tcpPort: 3310,
  localSocket: '',
  localSocketMode: '666',
  maxScanSize: '100M',
  maxFileSize: '25M',
  maxRecursion: 17,
  maxFiles: 10000,
  scanArchive: true,
  maxThreads: 12,
  readTimeoutSeconds: 120,
  user: 'clamav',
  logFile: '/var/log/clamav/clamd.log',
  logVerbose: false,
  virusEvent: '',
  notifyClamdOnUpdate: true,
  detectPua: false,
  heuristicAlerts: true,
  scanPdf: true,
  scanHtml: true,
  scanOle2: true,
  maxScanTimeMs: 120000,
};

const DEFAULT_FRESHCLAM_CONFIG: FreshclamManagedConfig = {
  enabled: true,
  daemon: true,
  checks: 12,
  databaseMirror: ['database.clamav.net'],
  privateMirror: [],
  updateLogFile: '/var/log/clamav/freshclam.log',
  databaseOwner: 'clamav',
  notifyClamd: '/etc/clamav/clamd.conf',
  connectTimeoutSeconds: 30,
  receiveTimeoutSeconds: 60,
  httpProxyServer: '',
  httpProxyPort: null,
  httpProxyUsername: '',
  httpProxyPassword: '',
};

function normalizeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function normalizeOptionalInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function normalizeClamdConfig(value: unknown): ClamdManagedConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_CLAMD_CONFIG };
  }

  const source = value as Partial<ClamdManagedConfig>;
  return {
    tcpAddr: typeof source.tcpAddr === 'string' && source.tcpAddr.trim() ? source.tcpAddr.trim() : DEFAULT_CLAMD_CONFIG.tcpAddr,
    tcpPort: normalizeInteger(source.tcpPort, DEFAULT_CLAMD_CONFIG.tcpPort),
    localSocket: typeof source.localSocket === 'string' ? source.localSocket : DEFAULT_CLAMD_CONFIG.localSocket,
    localSocketMode: typeof source.localSocketMode === 'string' && source.localSocketMode.trim() ? source.localSocketMode.trim() : DEFAULT_CLAMD_CONFIG.localSocketMode,
    maxScanSize: typeof source.maxScanSize === 'string' && source.maxScanSize.trim() ? source.maxScanSize.trim() : DEFAULT_CLAMD_CONFIG.maxScanSize,
    maxFileSize: typeof source.maxFileSize === 'string' && source.maxFileSize.trim() ? source.maxFileSize.trim() : DEFAULT_CLAMD_CONFIG.maxFileSize,
    maxRecursion: normalizeInteger(source.maxRecursion, DEFAULT_CLAMD_CONFIG.maxRecursion),
    maxFiles: normalizeInteger(source.maxFiles, DEFAULT_CLAMD_CONFIG.maxFiles),
    scanArchive: typeof source.scanArchive === 'boolean' ? source.scanArchive : DEFAULT_CLAMD_CONFIG.scanArchive,
    maxThreads: normalizeInteger(source.maxThreads, DEFAULT_CLAMD_CONFIG.maxThreads),
    readTimeoutSeconds: normalizeInteger(source.readTimeoutSeconds, DEFAULT_CLAMD_CONFIG.readTimeoutSeconds),
    user: typeof source.user === 'string' && source.user.trim() ? source.user.trim() : DEFAULT_CLAMD_CONFIG.user,
    logFile: typeof source.logFile === 'string' ? source.logFile : DEFAULT_CLAMD_CONFIG.logFile,
    logVerbose: typeof source.logVerbose === 'boolean' ? source.logVerbose : DEFAULT_CLAMD_CONFIG.logVerbose,
    virusEvent: typeof source.virusEvent === 'string' ? source.virusEvent : DEFAULT_CLAMD_CONFIG.virusEvent,
    notifyClamdOnUpdate: typeof source.notifyClamdOnUpdate === 'boolean' ? source.notifyClamdOnUpdate : DEFAULT_CLAMD_CONFIG.notifyClamdOnUpdate,
    detectPua: typeof source.detectPua === 'boolean' ? source.detectPua : DEFAULT_CLAMD_CONFIG.detectPua,
    heuristicAlerts: typeof source.heuristicAlerts === 'boolean' ? source.heuristicAlerts : DEFAULT_CLAMD_CONFIG.heuristicAlerts,
    scanPdf: typeof source.scanPdf === 'boolean' ? source.scanPdf : DEFAULT_CLAMD_CONFIG.scanPdf,
    scanHtml: typeof source.scanHtml === 'boolean' ? source.scanHtml : DEFAULT_CLAMD_CONFIG.scanHtml,
    scanOle2: typeof source.scanOle2 === 'boolean' ? source.scanOle2 : DEFAULT_CLAMD_CONFIG.scanOle2,
    maxScanTimeMs: normalizeInteger(source.maxScanTimeMs, DEFAULT_CLAMD_CONFIG.maxScanTimeMs),
  };
}

function normalizeFreshclamConfig(value: unknown): FreshclamManagedConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_FRESHCLAM_CONFIG };
  }

  const source = value as Partial<FreshclamManagedConfig>;
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_FRESHCLAM_CONFIG.enabled,
    daemon: typeof source.daemon === 'boolean' ? source.daemon : DEFAULT_FRESHCLAM_CONFIG.daemon,
    checks: normalizeInteger(source.checks, DEFAULT_FRESHCLAM_CONFIG.checks),
    databaseMirror: Array.isArray(source.databaseMirror) ? source.databaseMirror.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '') : DEFAULT_FRESHCLAM_CONFIG.databaseMirror,
    privateMirror: Array.isArray(source.privateMirror) ? source.privateMirror.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '') : DEFAULT_FRESHCLAM_CONFIG.privateMirror,
    updateLogFile: typeof source.updateLogFile === 'string' ? source.updateLogFile : DEFAULT_FRESHCLAM_CONFIG.updateLogFile,
    databaseOwner: typeof source.databaseOwner === 'string' && source.databaseOwner.trim() ? source.databaseOwner.trim() : DEFAULT_FRESHCLAM_CONFIG.databaseOwner,
    notifyClamd: typeof source.notifyClamd === 'string' ? source.notifyClamd : DEFAULT_FRESHCLAM_CONFIG.notifyClamd,
    connectTimeoutSeconds: normalizeInteger(source.connectTimeoutSeconds, DEFAULT_FRESHCLAM_CONFIG.connectTimeoutSeconds),
    receiveTimeoutSeconds: normalizeInteger(source.receiveTimeoutSeconds, DEFAULT_FRESHCLAM_CONFIG.receiveTimeoutSeconds),
    httpProxyServer: typeof source.httpProxyServer === 'string' ? source.httpProxyServer : DEFAULT_FRESHCLAM_CONFIG.httpProxyServer,
    httpProxyPort: normalizeOptionalInteger(source.httpProxyPort),
    httpProxyUsername: typeof source.httpProxyUsername === 'string' ? source.httpProxyUsername : DEFAULT_FRESHCLAM_CONFIG.httpProxyUsername,
    httpProxyPassword: typeof source.httpProxyPassword === 'string' ? source.httpProxyPassword : DEFAULT_FRESHCLAM_CONFIG.httpProxyPassword,
  };
}

function parseMemoryValue(rawValue: string): number {
  const match = rawValue.trim().match(/^([\d.]+)\s*([KMGTP])?$/i);
  if (!match) {
    return 0;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return 0;
  }

  const unit = (match[2] ?? 'M').toUpperCase();
  if (unit === 'K') {
    return Math.round((value / 1024) * 100) / 100;
  }
  if (unit === 'G') {
    return Math.round(value * 1024 * 100) / 100;
  }
  if (unit === 'T') {
    return Math.round(value * 1024 * 1024 * 100) / 100;
  }
  return Math.round(value * 100) / 100;
}

function parseVersion(versionText: string | null): {
  versionText: string | null;
  engineVersion: string | null;
  databaseVersion: number | null;
  databaseUpdatedAt: Date | null;
} {
  if (!versionText) {
    return {
      versionText: null,
      engineVersion: null,
      databaseVersion: null,
      databaseUpdatedAt: null,
    };
  }

  const trimmed = versionText.trim();
  const match = trimmed.match(/ClamAV\s+([^\s/]+)\/(\d+)\/(.+)$/i);
  return {
    versionText: trimmed,
    engineVersion: match?.[1] ?? null,
    databaseVersion: match ? Number(match[2]) : null,
    databaseUpdatedAt: match?.[3] ? new Date(match[3]) : null,
  };
}

function parseStats(statsText: string): Omit<ClamavLiveMetrics, 'serviceId' | 'serviceType' | 'timestamp' | 'pingOk' | 'versionText' | 'engineVersion' | 'databaseVersion' | 'databaseUpdatedAt'> {
  const result = {
    statusText: null as string | null,
    pools: 0,
    threadsLive: 0,
    threadsIdle: 0,
    threadsMax: 0,
    queueItems: 0,
    memoryHeapMB: 0,
    memoryMmapMB: 0,
    memoryUsedMB: 0,
    memoryFreeMB: 0,
    memoryReleasableMB: 0,
    memoryPoolsUsedMB: 0,
    memoryPoolsTotalMB: 0,
    rawStats: statsText,
  };

  for (const rawLine of statsText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith('POOLS:')) {
      result.pools = Number.parseInt(line.replace('POOLS:', '').trim(), 10) || 0;
      continue;
    }

    if (line.startsWith('STATE:')) {
      result.statusText = line.replace('STATE:', '').trim() || null;
      continue;
    }

    if (line.startsWith('THREADS:')) {
      const threadsLine = line.replace('THREADS:', '').trim();
      result.threadsLive = Number.parseInt(threadsLine.match(/live\s+(\d+)/i)?.[1] ?? '0', 10) || 0;
      result.threadsIdle = Number.parseInt(threadsLine.match(/idle\s+(\d+)/i)?.[1] ?? '0', 10) || 0;
      result.threadsMax = Number.parseInt(threadsLine.match(/max\s+(\d+)/i)?.[1] ?? '0', 10) || 0;
      continue;
    }

    if (line.startsWith('QUEUE:')) {
      result.queueItems = Number.parseInt(line.match(/(\d+)/)?.[1] ?? '0', 10) || 0;
      continue;
    }

    if (line.startsWith('MEMSTATS:')) {
      const memstats = line.replace('MEMSTATS:', '').trim();
      const pairs = memstats.matchAll(/([a-z_]+)\s+([\d.]+[KMGTP]?)/gi);
      for (const pair of pairs) {
        const key = pair[1].toLowerCase();
        const value = parseMemoryValue(pair[2]);
        if (key === 'heap') result.memoryHeapMB = value;
        if (key === 'mmap') result.memoryMmapMB = value;
        if (key === 'used') result.memoryUsedMB = value;
        if (key === 'free') result.memoryFreeMB = value;
        if (key === 'releasable') result.memoryReleasableMB = value;
        if (key === 'pools_used') result.memoryPoolsUsedMB = value;
        if (key === 'pools_total') result.memoryPoolsTotalMB = value;
      }
    }
  }

  return result;
}

async function getResolvedService(serviceId: string) {
  const service = await getFleetServiceById(serviceId);
  if (!service || service.serviceType !== 'clamav') {
    throw new Error('ClamAV service not found');
  }
  return service;
}

/**
 * Where robin-admin reaches clamd: the fleet service's address
 * (`tcp://host:3310`, `http://host:3310` or `host:3310`). clamd.conf's TCPAddr
 * is the address clamd binds, often 0.0.0.0, so it is never dialled.
 */
export function clamdEndpointOf(service: Pick<FleetService, 'apiUrl' | 'metricsUrl'>): { host: string; port: number } | null {
  for (const raw of [service.apiUrl, service.metricsUrl]) {
    const value = raw?.trim();
    if (!value) continue;
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `tcp://${value}`);
      if (url.hostname) {
        return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : 3310 };
      }
    } catch {
      // Not an address; try the next field.
    }
  }
  return null;
}

async function openClamdSocket(serviceId: string): Promise<{ socket: Socket; config: ClamavConfigState }> {
  const [service, config] = await Promise.all([getResolvedService(serviceId), getClamavConfigState(serviceId)]);
  const endpoint = clamdEndpointOf(service);
  if (!endpoint) {
    throw new Error('No clamd address is set for this ClamAV service (e.g. tcp://clamav:3310)');
  }

  return await new Promise((resolve, reject) => {
    const socket = new Socket();
    let settled = false;
    const timeoutMs = Math.max(config.clamd.readTimeoutSeconds, 5) * 1000;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    socket.setTimeout(timeoutMs);
    socket.once('error', (error) => finish(() => reject(error)));
    socket.once('timeout', () => finish(() => reject(new Error('ClamAV request timed out'))));
    socket.connect(endpoint.port, endpoint.host, () => {
      finish(() => resolve({ socket, config }));
    });
  });
}

async function sendSimpleCommand(serviceId: string, command: 'PING' | 'VERSION' | 'STATS' | 'RELOAD'): Promise<string> {
  const { socket } = await openClamdSocket(serviceId);
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    socket.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    socket.once('error', (error) => finish(() => reject(error)));
    socket.once('timeout', () => finish(() => reject(new Error('ClamAV request timed out'))));
    socket.once('close', () => finish(() => resolve(Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim())));
    socket.end(Buffer.from(`z${command}\0`, 'utf8'));
  });
}

// Display name for a scope: base, a registered instance, or (freeform Save-As,
// no fleet row yet) the scope id itself.
async function resolveScopeName(serviceId: string): Promise<string> {
  if (serviceId === DEFAULT_SCOPE_ID) return DEFAULT_SCOPE_NAME;
  const service = await getFleetServiceById(serviceId);
  return service?.name ?? serviceId;
}

export async function getClamavConfigState(serviceId?: string): Promise<ClamavConfigState> {
  // 'default' is the shared base; an instance scope layers its clamd/freshclam
  // override deltas on top (deep-merged), decoupled from fleet_services rows.
  const scope = (serviceId ?? '').trim() || DEFAULT_SCOPE_ID;
  const [serviceName, clamdPayload, freshclamPayload] = await Promise.all([
    resolveScopeName(scope),
    readLayeredPayload(CLAMAV_CONFIG_STORE_TABLE, 'service_id', scope, CLAMD_VALUES_FILE),
    readLayeredPayload(CLAMAV_CONFIG_STORE_TABLE, 'service_id', scope, FRESHCLAM_VALUES_FILE),
  ]);

  return {
    serviceId: scope,
    serviceName,
    clamd: normalizeClamdConfig(clamdPayload),
    freshclam: normalizeFreshclamConfig(freshclamPayload),
  };
}

/** All config scopes: the 'default' base plus every per-instance override owner. */
export async function listClamavConfigScopes(): Promise<string[]> {
  return listConfigStoreOwners(CLAMAV_CONFIG_STORE_TABLE, 'service_id');
}

export async function saveClamavManagedConfig(
  serviceId: string,
  payload: Partial<ClamavConfigState>
): Promise<ClamavConfigState> {
  const scope = (serviceId ?? '').trim() || DEFAULT_SCOPE_ID;
  const current = await getClamavConfigState(scope);
  const clamd = normalizeClamdConfig({ ...current.clamd, ...(payload.clamd ?? {}) });
  const freshclam = normalizeFreshclamConfig({ ...current.freshclam, ...(payload.freshclam ?? {}) });

  await Promise.all([
    // Managed values — base scope stores full, instance stores only the delta.
    writeLayeredPayload(CLAMAV_CONFIG_STORE_TABLE, 'service_id', scope, CLAMD_VALUES_FILE, clamd as unknown as Record<string, unknown>),
    writeLayeredPayload(CLAMAV_CONFIG_STORE_TABLE, 'service_id', scope, FRESHCLAM_VALUES_FILE, freshclam as unknown as Record<string, unknown>),
    // Rendered config (full effective) — what the fleet agent writes + reloads.
    upsertConfigStorePayload(CLAMAV_CONFIG_STORE_TABLE, 'service_id', scope, CLAMD_CONF_FILE, {
      content: renderClamdConfig(clamd),
      managedBy: 'robin-admin',
    }),
    upsertConfigStorePayload(CLAMAV_CONFIG_STORE_TABLE, 'service_id', scope, FRESHCLAM_CONF_FILE, {
      content: renderFreshclamConfig(freshclam),
      managedBy: 'robin-admin',
    }),
  ]);

  return getClamavConfigState(scope);
}

/** Reset a scope's override for the clamd or freshclam config back to base. */
export async function resetClamavConfigFile(serviceId: string, key: string): Promise<ClamavConfigState> {
  const scope = (serviceId ?? '').trim();
  if (!scope || scope === DEFAULT_SCOPE_ID) {
    throw new Error('The default base scope has no override to reset');
  }
  if (key.startsWith('freshclam')) {
    await deleteConfigStoreEntry(CLAMAV_CONFIG_STORE_TABLE, 'service_id', scope, FRESHCLAM_VALUES_FILE);
    await deleteConfigStoreEntry(CLAMAV_CONFIG_STORE_TABLE, 'service_id', scope, FRESHCLAM_CONF_FILE);
  } else {
    await deleteConfigStoreEntry(CLAMAV_CONFIG_STORE_TABLE, 'service_id', scope, CLAMD_VALUES_FILE);
    await deleteConfigStoreEntry(CLAMAV_CONFIG_STORE_TABLE, 'service_id', scope, CLAMD_CONF_FILE);
  }
  return getClamavConfigState(scope);
}

export function renderClamdConfig(config: ClamdManagedConfig): string {
  const lines = [
    `TCPAddr ${config.tcpAddr}`,
    `TCPSocket ${config.tcpPort}`,
    config.localSocket ? `LocalSocket ${config.localSocket}` : '',
    config.localSocket ? `LocalSocketMode ${config.localSocketMode}` : '',
    `MaxScanSize ${config.maxScanSize}`,
    `MaxFileSize ${config.maxFileSize}`,
    `MaxRecursion ${config.maxRecursion}`,
    `MaxFiles ${config.maxFiles}`,
    `ScanArchive ${config.scanArchive ? 'yes' : 'no'}`,
    `MaxThreads ${config.maxThreads}`,
    `ReadTimeout ${config.readTimeoutSeconds}`,
    `User ${config.user}`,
    `LogFile ${config.logFile}`,
    `LogVerbose ${config.logVerbose ? 'yes' : 'no'}`,
    config.virusEvent ? `VirusEvent ${config.virusEvent}` : '',
    `NotifyClamd ${config.notifyClamdOnUpdate ? 'yes' : 'no'}`,
    `DetectPUA ${config.detectPua ? 'yes' : 'no'}`,
    `HeuristicAlerts ${config.heuristicAlerts ? 'yes' : 'no'}`,
    `ScanPDF ${config.scanPdf ? 'yes' : 'no'}`,
    `ScanHTML ${config.scanHtml ? 'yes' : 'no'}`,
    `ScanOLE2 ${config.scanOle2 ? 'yes' : 'no'}`,
    `MaxScanTime ${config.maxScanTimeMs}`,
  ];
  return lines.filter(Boolean).join('\n');
}

export function renderFreshclamConfig(config: FreshclamManagedConfig): string {
  const lines = [
    `Checks ${config.checks}`,
    `DatabaseOwner ${config.databaseOwner}`,
    `UpdateLogFile ${config.updateLogFile}`,
    config.daemon ? 'Daemon yes' : 'Daemon no',
    config.enabled ? '' : 'Foreground yes',
    `ConnectTimeout ${config.connectTimeoutSeconds}`,
    `ReceiveTimeout ${config.receiveTimeoutSeconds}`,
    ...config.databaseMirror.map((entry) => `DatabaseMirror ${entry}`),
    ...config.privateMirror.map((entry) => `PrivateMirror ${entry}`),
    config.notifyClamd ? `NotifyClamd ${config.notifyClamd}` : '',
    config.httpProxyServer ? `HTTPProxyServer ${config.httpProxyServer}` : '',
    config.httpProxyPort ? `HTTPProxyPort ${config.httpProxyPort}` : '',
    config.httpProxyUsername ? `HTTPProxyUsername ${config.httpProxyUsername}` : '',
    config.httpProxyPassword ? `HTTPProxyPassword ${config.httpProxyPassword}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export async function getClamavLiveMetrics(serviceId: string): Promise<ClamavLiveMetrics | null> {
  // The 'default' base layer has no running clamd to probe.
  if (serviceId === DEFAULT_SCOPE_ID) {
    return null;
  }
  const service = await getResolvedService(serviceId);
  const [pingResponse, versionResponse, statsResponse] = await Promise.allSettled([
    sendSimpleCommand(service.serviceId, 'PING'),
    sendSimpleCommand(service.serviceId, 'VERSION'),
    sendSimpleCommand(service.serviceId, 'STATS'),
  ]);

  const pingOk = pingResponse.status === 'fulfilled' && /^PONG$/i.test(pingResponse.value.trim());
  const versionText = versionResponse.status === 'fulfilled' ? versionResponse.value : null;
  const statsText = statsResponse.status === 'fulfilled' ? statsResponse.value : '';

  if (!pingOk && !versionText && !statsText) {
    return null;
  }

  const version = parseVersion(versionText);
  const stats = parseStats(statsText);

  return {
    serviceId: service.serviceId,
    serviceType: 'clamav',
    timestamp: new Date(),
    pingOk,
    versionText: version.versionText,
    engineVersion: version.engineVersion,
    databaseVersion: version.databaseVersion,
    databaseUpdatedAt: version.databaseUpdatedAt,
    ...stats,
  };
}

/**
 * Assemble a live snapshot from the raw `VERSION` + `STATS` clamd replies a
 * co-located agent shipped (agent mode) — robin-admin can't reach clamd on that
 * host, so the agent dials it locally and forwards the raw text. Reuses the same
 * parseVersion/parseStats as the direct probe; reachable when either reply came.
 */
export function buildClamavSnapshotFromRaw(
  serviceId: string,
  versionText: string | null,
  statsText: string
): ClamavLiveMetrics {
  const version = parseVersion(versionText);
  const stats = parseStats(statsText);
  return {
    serviceId,
    serviceType: 'clamav',
    timestamp: new Date(),
    pingOk: Boolean((versionText && versionText.trim()) || statsText.trim()),
    versionText: version.versionText,
    engineVersion: version.engineVersion,
    databaseVersion: version.databaseVersion,
    databaseUpdatedAt: version.databaseUpdatedAt,
    ...stats,
  };
}

export async function getClamavStatus(serviceId: string): Promise<ClamavStatus> {
  // The 'default' base layer has no fleet_services row / running server, so skip
  // the throwing resolver and report a safe not-applicable status.
  const isDefault = serviceId === DEFAULT_SCOPE_ID;
  const [service, config, live] = await Promise.all([
    isDefault ? Promise.resolve(null) : getResolvedService(serviceId),
    getClamavConfigState(serviceId),
    getClamavLiveMetrics(serviceId),
  ]);

  const fallbackStats = parseStats('');
  const version = parseVersion(null);
  const metrics = live ?? {
    serviceId: service?.serviceId ?? DEFAULT_SCOPE_ID,
    serviceType: 'clamav' as const,
    timestamp: new Date(),
    pingOk: false,
    versionText: version.versionText,
    engineVersion: version.engineVersion,
    databaseVersion: version.databaseVersion,
    databaseUpdatedAt: version.databaseUpdatedAt,
    ...fallbackStats,
  };

  return {
    ...metrics,
    serviceName: service?.name ?? (isDefault ? DEFAULT_SCOPE_NAME : null),
    endpoint: service ? clamdEndpointOf(service) : null,
    freshclam: config.freshclam,
    privateNetworkOnly: true,
  };
}

export async function reloadClamav(serviceId: string): Promise<string> {
  return sendSimpleCommand(serviceId, 'RELOAD');
}

export async function getClamavRawStats(serviceId: string): Promise<string> {
  return sendSimpleCommand(serviceId, 'STATS');
}

export async function scanBufferWithClamd(serviceId: string, buffer: Buffer, fileName: string): Promise<ClamavScanResult> {
  const service = await getResolvedService(serviceId);
  const startedAt = Date.now();
  const { socket } = await openClamdSocket(serviceId);

  const rawResponse = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    socket.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    socket.once('error', (error) => finish(() => reject(error)));
    socket.once('timeout', () => finish(() => reject(new Error('ClamAV scan timed out'))));
    socket.once('close', () => finish(() => resolve(Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim())));

    socket.write(Buffer.from('zINSTREAM\0', 'utf8'));
    for (let offset = 0; offset < buffer.length; offset += 64 * 1024) {
      const chunk = buffer.subarray(offset, Math.min(offset + 64 * 1024, buffer.length));
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(chunk.length, 0);
      socket.write(length);
      socket.write(chunk);
    }
    const terminator = Buffer.alloc(4);
    terminator.writeUInt32BE(0, 0);
    socket.end(terminator);
  });

  const viruses = rawResponse
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/:\s(.+)\sFOUND$/i);
      return match?.[1] ? [match[1]] : [];
    });

  return {
    serviceId: service.serviceId,
    serviceName: service.name,
    fileName,
    sizeBytes: buffer.length,
    clean: /:\sOK$/i.test(rawResponse),
    infected: viruses.length > 0,
    viruses,
    rawResponse,
    durationMs: Date.now() - startedAt,
    scannedAt: new Date().toISOString(),
  };
}
