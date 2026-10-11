/**
 * What each fleet service can do in its setup, as one rule table.
 *
 * A rule looks at facts about a service (how it is collected, which agent
 * works each axis and how that agent reaches the service, which endpoints are
 * set) and returns null when the feature works, or the reason it doesn't.
 * The UI hides a feature that doesn't work rather than showing it broken, and
 * the Fleet docs page evaluates the same rules for every setup, so the docs
 * can never promise what the UI hides.
 */
import { FLEET_SERVICE_TYPES as ALL_TYPES, type FleetServiceType } from './service-types.js';

export type AgentAccess = 'local' | 'container' | 'ssh' | 'other';

export interface AgentFacts {
  access: AgentAccess;
  /** Rendered config files can be placed where the service reads them. */
  fileDelivery: boolean;
  /** Command-channel actions whose tools exist where the service runs; null until reported. */
  actions: ReadonlySet<string> | null;
}

export interface CapabilityFacts {
  serviceType: FleetServiceType;
  metricsMode: 'direct' | 'agent';
  /** The agent collecting metrics (agent mode), which also runs operational commands. */
  metricsAgent: AgentFacts | null;
  /** The agent applying config: the named config agent, else the metrics agent. */
  configAgent: AgentFacts | null;
  /** Some log source is readable (a streaming log agent, a log URL, a mounted file). */
  logs: boolean;
  /** An agent is streaming the service's log right now (Postfix message counters). */
  logsLive: boolean;
  /** robin-admin can reach the endpoint the type is read from directly. */
  endpoint: boolean;
  /** Redis/PostgreSQL/MariaDB: robin-admin holds an admin connection string. */
  adminDsn: boolean;
  robinApi: boolean;
  robinQueueTable: boolean;
  robinConfigStore: boolean;
  rspamdController: boolean;
  rspamdNormal: boolean;
  rspamdTrainingDir: boolean;
  clamdAddress: boolean;
}

type Check = (facts: CapabilityFacts) => string | null;

export interface CapabilityRule {
  id: string;
  label: string;
  /** Where the feature lives in the UI, for the docs page. */
  surface: string;
  types: readonly FleetServiceType[];
  check: Check;
}

/** Types whose agent snapshots keep the collector's raw output (see getRawServiceMetrics). */
export const AGENT_RAW_TYPES: readonly FleetServiceType[] = ['clamav', 'dovecot', 'postfix', 'redis', 'postgres', 'mariadb'];

/** Types robin-admin manages over an admin connection string rather than files. */
const DSN_TYPES: readonly FleetServiceType[] = ['redis', 'postgres', 'mariadb'];

const FILE_CONFIG_TYPES = ['rspamd', 'dovecot', 'postfix', 'clamav'] as const satisfies readonly FleetServiceType[];

const DIRECT_ENDPOINT: Record<FleetServiceType, string> = {
  robin: 'the Robin metrics URL',
  rspamd: 'the Rspamd controller URL',
  clamav: 'the clamd address (tcp://host:3310)',
  dovecot: "Dovecot's OpenMetrics URL",
  postfix: 'a postfix_exporter metrics URL',
  redis: 'a redis:// URL (or REDIS_ADMIN_DSN)',
  postgres: 'a postgres:// DSN (or POSTGRES_ADMIN_DSN)',
  mariadb: 'a mysql:// or mariadb:// DSN (or MARIADB_ADMIN_DSN)',
};

function agentRuns(agent: AgentFacts | null, action: string, noAgent: string): string | null {
  if (!agent) return noAgent;
  if (!agent.actions) return "The agent hasn't reported what it can run yet";
  if (!agent.actions.has(action)) return `The agent can't run ${action} where the service runs (its tool is missing)`;
  return null;
}

const configFiles: Check = (f) => {
  if (!f.configAgent) return 'Needs an agent that applies config on the service host';
  if (!f.configAgent.fileDelivery) return 'An agent reaching the service over ssh cannot place config files';
  return null;
};

const needsAdminDsn: Check = (f) => (f.adminDsn ? null : `robin-admin needs ${DIRECT_ENDPOINT[f.serviceType]} to reach it directly`);

export const CAPABILITY_RULES: readonly CapabilityRule[] = [
  {
    id: 'metrics',
    label: 'Metrics',
    surface: 'Metrics page, dashboard card',
    types: ALL_TYPES,
    check: (f) => {
      if (f.metricsMode === 'agent') return f.metricsAgent ? null : 'Agent mode needs an assigned agent';
      return f.endpoint ? null : `Direct mode needs ${DIRECT_ENDPOINT[f.serviceType]}`;
    },
  },
  {
    id: 'raw',
    label: 'Raw metrics',
    surface: 'Metrics → Raw tab',
    types: ALL_TYPES,
    check: (f) => {
      if (f.metricsMode === 'agent') {
        if (!f.metricsAgent) return 'Agent mode needs an assigned agent';
        return AGENT_RAW_TYPES.includes(f.serviceType) ? null : 'The agent ships parsed metrics for this type, not the raw output';
      }
      return f.endpoint ? null : `Direct mode needs ${DIRECT_ENDPOINT[f.serviceType]}`;
    },
  },
  {
    id: 'logs',
    label: 'Logs',
    surface: 'Logs page',
    types: ALL_TYPES,
    check: (f) => (f.logs ? null : 'Needs a log agent, a <TYPE>_LOG_URL, or the log file mounted into robin-admin'),
  },
  {
    id: 'config',
    label: 'Managed config',
    surface: 'Config page',
    types: ALL_TYPES,
    check: (f) => {
      if (f.serviceType === 'robin') return f.robinConfigStore ? null : 'Robin Config needs the robin_config_store table';
      if (DSN_TYPES.includes(f.serviceType)) return needsAdminDsn(f);
      return configFiles(f);
    },
  },
  {
    id: 'configSync',
    label: 'Config sync',
    surface: 'Fleet → Services → Config sync',
    types: FILE_CONFIG_TYPES,
    check: configFiles,
  },
  {
    id: 'reload',
    label: 'Reload',
    surface: 'Config page → Reload (MariaDB: re-apply)',
    types: ALL_TYPES,
    check: (f) => {
      switch (f.serviceType) {
        case 'robin': return f.robinApi ? null : 'Needs the Robin API (ROBIN_API_ENABLED)';
        case 'clamav': return f.clamdAddress ? null : 'Needs the clamd address to send RELOAD';
        case 'redis':
        case 'postgres':
        case 'mariadb': return needsAdminDsn(f);
        default: return agentRuns(f.configAgent, `${f.serviceType}.reload`, 'Needs an agent on the service host to reload it');
      }
    },
  },
  {
    id: 'queue',
    label: 'Queue',
    surface: 'Robin → Queue',
    types: ['robin'],
    check: (f) => (!f.robinApi ? 'Needs the Robin API (ROBIN_API_ENABLED)' : f.robinQueueTable ? null : "Needs Robin's queue table in the database"),
  },
  {
    id: 'deliveryTest',
    label: 'Delivery test',
    surface: 'Robin → Delivery Test',
    types: ['robin'],
    check: (f) => (f.robinApi ? null : 'Needs the Robin API (ROBIN_API_ENABLED)'),
  },
  {
    id: 'scan',
    label: 'Scan',
    surface: 'Scan page',
    types: ['rspamd', 'clamav'],
    check: (f) => {
      if (f.serviceType === 'clamav') return f.clamdAddress ? null : 'robin-admin needs the clamd address to stream files to it';
      return f.rspamdNormal ? null : "robin-admin needs the Rspamd normal worker URL to reach it directly";
    },
  },
  {
    id: 'training',
    label: 'Training',
    surface: 'Rspamd → Training',
    types: ['rspamd'],
    check: (f) => {
      if (!f.rspamdController) return 'robin-admin needs the Rspamd controller URL to reach it directly';
      return f.rspamdTrainingDir ? null : 'Needs a training directory in the Rspamd settings';
    },
  },
  {
    id: 'classifiers',
    label: 'Classifiers',
    surface: 'Rspamd → Training → Classifiers',
    types: ['rspamd'],
    check: (f) => (f.rspamdController ? null : 'robin-admin needs the Rspamd controller URL to reach it directly'),
  },
  {
    id: 'rules',
    label: 'Rules',
    surface: 'Rspamd → Rules',
    types: ['rspamd'],
    check: configFiles,
  },
  {
    id: 'dkim',
    label: 'DKIM signing keys',
    surface: 'Rspamd → DKIM Keys',
    types: ['rspamd'],
    check: configFiles,
  },
  {
    id: 'sessions',
    label: 'Sessions',
    surface: 'Dovecot → Metrics → Sessions, session and user counts',
    types: ['dovecot'],
    check: (f) => agentRuns(f.metricsMode === 'agent' ? f.metricsAgent : null, 'dovecot.who', 'Needs Dovecot in agent mode (OpenMetrics has no session list)'),
  },
  {
    id: 'kick',
    label: 'Disconnect a user',
    surface: 'Dovecot → Metrics → Sessions',
    types: ['dovecot'],
    check: (f) => agentRuns(f.metricsMode === 'agent' ? f.metricsAgent : null, 'dovecot.kick', 'Needs Dovecot in agent mode'),
  },
  {
    id: 'quota',
    label: 'Quota',
    surface: 'Dovecot → Metrics → Quota',
    types: ['dovecot'],
    check: (f) => {
      const reason = agentRuns(f.metricsMode === 'agent' ? f.metricsAgent : null, 'dovecot.quota', 'Needs Dovecot in agent mode');
      // The agent probes doveadm's quota command, which exists only with the plugin loaded.
      return reason?.includes('tool is missing') ? 'Needs the Dovecot quota plugin (mail_plugins = quota)' : reason;
    },
  },
  {
    id: 'postfixQueue',
    label: 'Queue browser',
    surface: 'Postfix → Queue',
    types: ['postfix'],
    check: (f) => agentRuns(f.metricsMode === 'agent' ? f.metricsAgent : null, 'postfix.queue.list', 'Needs Postfix in agent mode (Postfix has no queue API)'),
  },
  {
    id: 'flush',
    label: 'Flush queue',
    surface: 'Postfix → Queue → Flush',
    types: ['postfix'],
    check: (f) => agentRuns(f.metricsMode === 'agent' ? f.metricsAgent : null, 'postfix.queue.flush', 'Needs Postfix in agent mode'),
  },
  {
    id: 'messageCounters',
    label: 'Message flow',
    surface: 'Postfix → Metrics → Message flow',
    types: ['postfix'],
    check: (f) => (f.logsLive ? null : "Needs an agent streaming Postfix's log (the counters come from it)"),
  },
  {
    id: 'deferredAge',
    label: 'Oldest deferred age',
    surface: 'Postfix → Metrics',
    types: ['postfix'],
    check: (f) => (f.metricsMode === 'agent' ? null : 'A postfix_exporter reports queue depth only'),
  },
  {
    id: 'admin',
    label: 'Admin tools',
    surface: 'Metrics → Slowlog, Clients (Redis); Activity, Locks, Tables, Statements (PostgreSQL); Processes, Transactions, Schemas, Statements (MariaDB)',
    types: DSN_TYPES,
    check: needsAdminDsn,
  },
];

export interface CapabilityState {
  available: boolean;
  /** Why the feature is hidden; absent when available. */
  reason?: string;
}

export type CapabilityMap = Record<string, CapabilityState>;

export function evaluateCapabilities(facts: CapabilityFacts): CapabilityMap {
  const out: CapabilityMap = {};
  for (const rule of CAPABILITY_RULES) {
    if (!rule.types.includes(facts.serviceType)) continue;
    const reason = rule.check(facts);
    out[rule.id] = reason ? { available: false, reason } : { available: true };
  }
  return out;
}

// ── Setups, for the docs page ────────────────────────────────────────────────

export type SetupAgent = 'none' | 'local' | 'container' | 'ssh';

export interface SetupChoice {
  /** Where an agent runs, if any: on the service's host, next to its container, or over ssh. */
  agent: SetupAgent;
  /** robin-admin can also reach the service's own endpoints over the network. */
  reachable: boolean;
}

/** Every action a type's agent can run, assuming the service's tools are installed. */
export const AGENT_ACTIONS_BY_TYPE: Partial<Record<FleetServiceType, readonly string[]>> = {
  postfix: ['postfix.queue.list', 'postfix.queue.show', 'postfix.queue.hold', 'postfix.queue.release', 'postfix.queue.requeue', 'postfix.queue.delete', 'postfix.queue.deliver', 'postfix.queue.flush', 'postfix.reload'],
  dovecot: ['dovecot.reload', 'dovecot.who', 'dovecot.kick', 'dovecot.quota', 'dovecot.user'],
  rspamd: ['rspamd.reload'],
};

/** The facts a setup implies, with everything it allows configured. */
export function setupFacts(serviceType: FleetServiceType, setup: SetupChoice): CapabilityFacts {
  const agent: AgentFacts | null = setup.agent === 'none'
    ? null
    : {
      access: setup.agent,
      fileDelivery: setup.agent !== 'ssh',
      actions: new Set(AGENT_ACTIONS_BY_TYPE[serviceType] ?? []),
    };
  const reachable = setup.reachable;
  return {
    serviceType,
    metricsMode: agent ? 'agent' : 'direct',
    metricsAgent: agent,
    configAgent: agent,
    logs: Boolean(agent),
    logsLive: Boolean(agent),
    endpoint: reachable,
    adminDsn: reachable,
    robinApi: reachable,
    robinQueueTable: true,
    robinConfigStore: true,
    rspamdController: reachable,
    rspamdNormal: reachable,
    rspamdTrainingDir: true,
    clamdAddress: reachable,
  };
}

export const SETUP_CHOICES: readonly SetupChoice[] = [
  { agent: 'none', reachable: true },
  { agent: 'local', reachable: true },
  { agent: 'local', reachable: false },
  { agent: 'container', reachable: true },
  { agent: 'container', reachable: false },
  { agent: 'ssh', reachable: true },
  { agent: 'ssh', reachable: false },
];
