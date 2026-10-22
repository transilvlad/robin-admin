import { getFleetServiceById } from '../db/queries/fleet-services.js';
import { commandAgentFor, runAgentCommand, type AgentCommandAction } from './agent-commands.js';

export interface CyrusSession {
  pid: string;
  service: string;
  host: string;
  ip: string;
  user: string;
  mailbox: string;
  state: string;
}

export interface CyrusQuotaRow {
  root: string;
  user: string;
  storageUsedKiB: number;
  storageLimitKiB: number | null;
  storagePercent: number | null;
  messages: number;
  folders: number;
}

export interface CyrusQuotaResult {
  available: boolean;
  reason: string | null;
  rows: CyrusQuotaRow[];
}

export interface CyrusLiveMetrics {
  serviceId: string;
  serviceType: 'cyrus';
  timestamp: Date;
  reachable: boolean;
  imapConnections: number;
  activeConnections: number;
  authSuccess: number;
  authFailure: number;
  loginCount: number;
  imapCommands: number;
  lmtpConnections: number;
  mailDeliveries: number;
  lmtpRecipients: number;
  lmtpBytes: number;
  userCount: number;
  mailboxCount: number;
  quotaCommitment: number;
  sessionCount: number;
  rawStats: string;
}

type CyrusCounters = Omit<CyrusLiveMetrics, 'serviceId' | 'serviceType' | 'timestamp' | 'reachable' | 'rawStats' | 'sessionCount'>;

export function parseCyrusPrometheus(raw: string): CyrusCounters {
  const out: CyrusCounters = {
    imapConnections: 0,
    activeConnections: 0,
    authSuccess: 0,
    authFailure: 0,
    loginCount: 0,
    imapCommands: 0,
    lmtpConnections: 0,
    mailDeliveries: 0,
    lmtpRecipients: 0,
    lmtpBytes: 0,
    userCount: 0,
    mailboxCount: 0,
    quotaCommitment: 0,
  };
  const fields: Record<string, keyof CyrusCounters> = {
    cyrus_imap_connections_total: 'imapConnections',
    cyrus_imap_active_connections: 'activeConnections',
    cyrus_lmtp_connections_total: 'lmtpConnections',
    cyrus_lmtp_received_messages_total: 'mailDeliveries',
    cyrus_lmtp_received_recipients_total: 'lmtpRecipients',
    cyrus_lmtp_received_bytes_total: 'lmtpBytes',
    cyrus_usage_users: 'userCount',
    cyrus_usage_mailboxes: 'mailboxCount',
    cyrus_usage_quota_commitment: 'quotaCommitment',
  };
  for (const line of raw.split(/\r?\n/)) {
    const match = line.trim().match(/^(cyrus_[a-zA-Z0-9_:]+)(?:\{((?:[^"}]|"(?:\\.|[^"\\])*")*)\})?\s+([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)(?:\s+\d+)?\s*$/);
    if (!match) continue;
    const [, name, labels = '', value] = match;
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    const field = fields[name];
    if (field) out[field] += n;
    if (name === 'cyrus_imap_authenticate_total') {
      const result = labels.match(/(?:^|,)\s*(?:result|status|success)\s*=\s*"([^" ]*)"/)?.[1]?.toLowerCase();
      if (['no', 'false', 'failure', 'failed', 'fail', 'error', '0'].includes(result ?? '')) out.authFailure += n;
      else out.authSuccess += n;
    } else if (/^cyrus_imap_.*_total$/.test(name) && name !== 'cyrus_imap_connections_total') out.imapCommands += n;
  }
  out.loginCount = out.authSuccess;
  return out;
}

export function parseCyrusProc(raw: string): CyrusSession[] {
  return raw.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)(?:\s+\[([^\]]*)\])?(?:\s+(.*))?$/);
    if (!match) return [];
    const [, pid, service, host, ip = '', rest = ''] = match;
    const tokens = rest.trim().split(/\s+/).filter(Boolean);
    const isState = (token: string) => /^(?:idle|login|logout|authenticat(?:e|ing)|unauthenticated|connected|waiting|accepting|sasl|noop|capability|starttls|select|examine|fetch|uid|append|store|search|list|lsub|status|namespace|subscribe|unsubscribe|expunge|close|check|copy|move|create|delete|rename|setacl|getacl|id|compress|enable|done|quit|lhlo|mail|rcpt|data|rset)$/i.test(token);
    const user = tokens[0] && !isState(tokens[0]) ? tokens.shift()! : '';
    const mailbox = tokens[0] && !isState(tokens[0]) ? tokens.shift()! : '';
    return [{ pid, service, host, ip, user, mailbox, state: tokens.join(' ') }];
  });
}

export function parseCyrusQuota(raw: string): CyrusQuotaRow[] {
  const roots = new Map<string, CyrusQuotaRow>();
  for (const line of raw.split(/\r?\n/)) {
    const match = line.trim().match(/^(?:(\d+)\s+(\d+(?:\.\d+)?)\s+)?(\d+)\s+(STORAGE|MESSAGE|X-ANNOTATION-STORAGE|X-NUM-FOLDERS)\s+(.+)$/);
    if (!match) continue;
    const [, limit, percent, used, resource, root] = match;
    const row = roots.get(root) ?? { root, user: root.replace(/^user\//, ''), storageUsedKiB: 0, storageLimitKiB: null, storagePercent: null, messages: 0, folders: 0 };
    if (resource === 'STORAGE') {
      row.storageUsedKiB = Number(used);
      row.storageLimitKiB = limit === undefined ? null : Number(limit);
      row.storagePercent = percent === undefined ? null : Number(percent);
    } else if (resource === 'MESSAGE') row.messages = Number(used);
    else if (resource === 'X-NUM-FOLDERS') row.folders = Number(used);
    roots.set(root, row);
  }
  return [...roots.values()];
}

export function buildCyrusSnapshotFromRaw(serviceId: string, prometheus: string, proc = ''): CyrusLiveMetrics {
  return { serviceId, serviceType: 'cyrus', timestamp: new Date(), reachable: true, ...parseCyrusPrometheus(prometheus), sessionCount: parseCyrusProc(proc).length, rawStats: prometheus.slice(0, 8000) };
}

async function runCyrus(serviceId: string, action: AgentCommandAction, args: Record<string, unknown> = {}): Promise<string> {
  const service = await getFleetServiceById(serviceId);
  if (!service || service.serviceType !== 'cyrus') throw new Error('Cyrus service not found');
  const agentId = commandAgentFor(service, 'metrics');
  if (service.collectionMode !== 'agent' || !agentId) throw new Error('This Cyrus service needs a metrics agent');
  return runAgentCommand(agentId, service, action, args);
}

export async function listCyrusSessions(serviceId: string): Promise<CyrusSession[]> {
  return parseCyrusProc(await runCyrus(serviceId, 'cyrus.sessions'));
}

export async function getCyrusQuota(serviceId: string, user?: string): Promise<CyrusQuotaResult> {
  return { available: true, reason: null, rows: parseCyrusQuota(await runCyrus(serviceId, 'cyrus.quota', user ? { user } : {})) };
}

export async function lookupCyrusUser(serviceId: string, user: string): Promise<Record<string, string> | null> {
  try {
    const path = (await runCyrus(serviceId, 'cyrus.user', { user })).trim();
    return path ? { path } : null;
  } catch (error) {
    if (/Invalid mailbox name:/i.test((error as Error).message)) return null;
    throw error;
  }
}
