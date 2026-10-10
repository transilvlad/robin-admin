import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, EyeOff, Minus } from 'lucide-react';
import { fleetCapabilitiesApi } from '../api/client';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import { FLEET_SERVICE_TYPES, getServiceTypeMeta, type FleetServiceType } from '../constants/serviceTypes';
import type { CapabilityMatrix, CapabilityState, SetupAgent, SetupChoice } from '../types';

/**
 * Fleet → Docs: a setup assistant. Pick a service and how it is reached; the
 * page shows what works, what is hidden and why, and what to configure. What
 * works comes from the server's capability rules, the same ones that hide
 * features in the rest of the UI, so the two can't disagree.
 */

const AGENT_CHOICES: Array<{ id: SetupAgent; label: string; detail: string }> = [
  { id: 'none', label: 'No agent', detail: 'robin-admin reaches the service over the network.' },
  { id: 'local', label: 'Agent on the host', detail: 'robin-agent runs on the service’s host, or inside its container.' },
  { id: 'container', label: 'Agent next to the container', detail: 'robin-agent reaches the service with docker/podman exec.' },
  { id: 'ssh', label: 'Agent over ssh', detail: 'robin-agent runs commands on the service’s host over ssh.' },
];

interface TypeGuide {
  /** Fleet → Services fields for this service, with example values. */
  fields: Array<{ label: string; value: string; when?: 'reachable' }>;
  /** What the service's host needs when an agent works it. */
  agentNeeds: ReactNode;
  /** Agent environment for this type, beyond the common enrolment lines. */
  agentEnv: string[];
  /** Service-specific limits worth knowing whatever the setup. */
  notes: ReactNode[];
}

const GUIDES: Record<FleetServiceType, TypeGuide> = {
  robin: {
    fields: [
      { label: 'API URL', value: 'http://robin.example:8090', when: 'reachable' },
      { label: 'Metrics URL', value: 'http://robin.example:8080', when: 'reachable' },
    ],
    agentNeeds: <>Robin’s metrics endpoint reachable from the agent (<code>ROBIN_AGENT_ROBIN_METRICS_URL</code>, default 127.0.0.1:8080).</>,
    agentEnv: ['ROBIN_AGENT_ROBIN_METRICS_URL=http://127.0.0.1:8080'],
    notes: [
      'Robin pulls its own config from the database; Config needs no agent.',
      'Queue and Delivery Test use the Robin API, so robin-admin must reach it.',
    ],
  },
  rspamd: {
    fields: [
      { label: 'Controller URL', value: 'http://rspamd.example:11334', when: 'reachable' },
      { label: 'Normal worker URL', value: 'http://rspamd.example:11333', when: 'reachable' },
    ],
    agentNeeds: <><code>rspamadm</code> and write access to <code>/etc/rspamd/local.d</code>. Managed files, DKIM keys and multimap maps land there.</>,
    agentEnv: ['ROBIN_AGENT_RSPAMD_URL=http://127.0.0.1:11334', 'ROBIN_AGENT_RSPAMD_PASSWORD=<controller password>'],
    notes: [
      'Set the controller password and the training directory in Fleet → Services → Edit.',
      'Scan, Training and Classifiers talk to Rspamd directly, so robin-admin must reach it.',
    ],
  },
  clamav: {
    fields: [{ label: 'API URL (clamd address)', value: 'tcp://clamav.example:3310', when: 'reachable' }],
    agentNeeds: <>clamd reachable from the agent (<code>ROBIN_AGENT_CLAMAV_ADDR</code>, default 127.0.0.1:3310) and write access to <code>/etc/clamav</code>.</>,
    agentEnv: ['ROBIN_AGENT_CLAMAV_ADDR=127.0.0.1:3310'],
    notes: [
      'clamd reads clamd.conf only at start: after a config change, restart it.',
      'Reload signatures and Scan talk to clamd directly.',
    ],
  },
  dovecot: {
    fields: [{ label: 'OpenMetrics URL', value: 'http://dovecot.example:9900/metrics', when: 'reachable' }],
    agentNeeds: <><code>doveadm</code> and <code>doveconf</code>, a readable stats-reader socket, and write access to <code>/etc/dovecot/conf.d</code>. Quota needs the quota plugin.</>,
    agentEnv: ['ROBIN_AGENT_DOVECOT_LOG_FILE=/var/log/dovecot.log'],
    notes: [
      'The managed config follows the Dovecot version the agent reports (2.3 or 2.4 syntax).',
      'OpenMetrics carries counters only: sessions, users and quota need an agent.',
    ],
  },
  postfix: {
    fields: [{ label: 'OpenMetrics URL', value: 'http://postfix.example:9154/metrics', when: 'reachable' }],
    agentNeeds: <><code>postqueue</code>, <code>postsuper</code>, <code>postcat</code>, <code>postconf</code> and <code>postfix</code>, and write access to <code>/etc/postfix</code>.</>,
    agentEnv: ['ROBIN_AGENT_POSTFIX_LOG_FILE=/var/log/mail.log'],
    notes: [
      'Postfix has no admin API: the queue browser and reload need an agent.',
      'Delivered, deferred, bounced and rejected counts come from the log the agent streams.',
    ],
  },
  redis: {
    fields: [{ label: 'Redis URL', value: 'redis://redis.example:6379/0', when: 'reachable' }],
    agentNeeds: <>Redis reachable from the agent (<code>ROBIN_AGENT_REDIS_ADDR</code>, default 127.0.0.1:6379).</>,
    agentEnv: ['ROBIN_AGENT_REDIS_ADDR=127.0.0.1:6379', 'ROBIN_AGENT_REDIS_LOG_FILE=/var/log/redis/redis-server.log'],
    notes: [
      'Config applies live with CONFIG SET and REWRITE over robin-admin’s own connection.',
      'Flush-style commands are never exposed.',
    ],
  },
  postgres: {
    fields: [{ label: 'Postgres DSN', value: 'postgresql://robin_admin@postgres.example:5432/postgres', when: 'reachable' }],
    agentNeeds: <><code>psql</code> on the agent host and a read-only DSN (<code>ROBIN_AGENT_POSTGRES_DSN</code>).</>,
    agentEnv: ['ROBIN_AGENT_POSTGRES_DSN=postgresql://monitor@127.0.0.1:5432/postgres', 'ROBIN_AGENT_POSTGRES_LOG_DIR=/var/log/postgresql'],
    notes: [
      'Config applies live with ALTER SYSTEM and pg_reload_conf over robin-admin’s own connection.',
      'Drop and truncate are never exposed.',
    ],
  },
  mariadb: {
    fields: [{ label: 'MariaDB DSN', value: 'mysql://robin_monitor:password@db.example:3306/', when: 'reachable' }],
    agentNeeds: <>The <code>mariadb</code> client where the server runs (a container already has one) and a monitoring user (<code>ROBIN_AGENT_MARIADB_DSN</code>). The password is passed in <code>MYSQL_PWD</code>, never on a command line.</>,
    agentEnv: [
      'ROBIN_AGENT_MARIADB_DSN=mysql://robin_monitor:password@127.0.0.1:3306/',
      'ROBIN_AGENT_EXEC_PREFIX=app-db=docker exec app-database',
      'ROBIN_AGENT_MARIADB_LOG_CONTAINER=app-database',
    ],
    notes: [
      'Config applies live with SET GLOBAL over robin-admin’s own connection, and is re-applied when a restart reverts it. Empty fields leave the server’s setting alone.',
      'Kill query/connection, ANALYZE TABLE and FLUSH STATUS only: drop, truncate and OPTIMIZE are never exposed.',
      'Monitoring user: GRANT PROCESS, REPLICATION CLIENT, SLAVE MONITOR, SHOW DATABASES ON *.*, plus REFERENCES on the databases to size (no read access to their data) and SELECT on performance_schema.* for statement digests.',
    ],
  },
};

function sameSetup(a: SetupChoice, b: SetupChoice): boolean {
  return a.agent === b.agent && a.reachable === b.reachable;
}

function setupLabel(setup: SetupChoice): string {
  const agent = AGENT_CHOICES.find((choice) => choice.id === setup.agent)?.label ?? setup.agent;
  if (setup.agent === 'none') return agent;
  return `${agent}${setup.reachable ? ', reachable' : ', agent only'}`;
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? 'bg-robin-orange text-white'
          : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-robin-gray-800 dark:text-gray-200 dark:hover:bg-robin-gray-700'
      }`}
    >
      {children}
    </button>
  );
}

function Section({ step, title, children }: { step?: number; title: string; children: ReactNode }) {
  return (
    <section className="card space-y-3 p-5 text-sm text-gray-600 dark:text-gray-300">
      <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-white">
        {step !== undefined && (
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-robin-orange/15 text-xs font-bold text-robin-orange">{step}</span>
        )}
        {title}
      </h2>
      {children}
    </section>
  );
}

function agentSnippet(type: FleetServiceType, agent: SetupAgent): string {
  const serviceId = `${type}-primary`;
  const lines = [
    'ROBIN_ADMIN_URL=https://robin-admin.example',
    'ROBIN_ENROLLMENT_TOKEN=<one-time token from Fleet → Agents>',
  ];
  if (agent === 'container') lines.push(`ROBIN_AGENT_EXEC_PREFIX=${serviceId}=docker exec ${type}`);
  if (agent === 'ssh') lines.push(`ROBIN_AGENT_EXEC_PREFIX=${serviceId}=ssh -o BatchMode=yes ${type}.example`);
  const env = GUIDES[type].agentEnv.map((line) => (agent === 'container' && line.includes('_LOG_FILE=')
    ? line.replace(/_LOG_FILE=.*/, `_LOG_CONTAINER=${type}`)
    : line));
  return [...lines, ...env].join('\n');
}

export function FleetDocsPage() {
  const [matrix, setMatrix] = useState<CapabilityMatrix | null>(null);
  const [error, setError] = useState('');
  const [type, setType] = useState<FleetServiceType>('postfix');
  const [agent, setAgent] = useState<SetupAgent>('container');
  const [reachable, setReachable] = useState(false);

  useEffect(() => {
    fleetCapabilitiesApi.matrix()
      .then((res) => setMatrix(res.data ?? null))
      .catch(() => setError('Could not load the capability rules'));
  }, []);

  const setup: SetupChoice = { agent, reachable: agent === 'none' ? true : reachable };
  const rules = useMemo(() => matrix?.rules.filter((rule) => rule.types.includes(type)) ?? [], [matrix, type]);
  const rows = matrix?.matrix[type] ?? [];
  const current = rows.find((row) => sameSetup(row.setup, setup))?.features ?? {};
  const works = rules.filter((rule) => current[rule.id]?.available);
  const hidden = rules.filter((rule) => current[rule.id] && !current[rule.id].available);
  const guide = GUIDES[type];
  const meta = getServiceTypeMeta(type);
  const fields = guide.fields.filter((field) => field.when !== 'reachable' || setup.reachable);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.fleetDocs}
        title="Fleet docs"
        description="Pick a service and how you'll run it to see what works, what stays hidden and why, and what to set up."
      />

      <Section step={1} title="Service">
        <div className="flex flex-wrap gap-2">
          {FLEET_SERVICE_TYPES.map((id) => {
            const Icon = getServiceTypeMeta(id).icon;
            return (
              <Chip key={id} active={type === id} onClick={() => setType(id)}>
                <Icon className="h-4 w-4" />
                {getServiceTypeMeta(id).label}
              </Chip>
            );
          })}
        </div>
      </Section>

      <Section step={2} title="Setup">
        <div className="grid gap-2 md:grid-cols-4">
          {AGENT_CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              aria-pressed={agent === choice.id}
              onClick={() => setAgent(choice.id)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                agent === choice.id
                  ? 'border-robin-orange bg-robin-orange/10'
                  : 'border-gray-200 hover:border-gray-300 dark:border-robin-gray-700 dark:hover:border-robin-gray-600'
              }`}
            >
              <div className="font-medium text-gray-900 dark:text-white">{choice.label}</div>
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{choice.detail}</div>
            </button>
          ))}
        </div>
        {agent !== 'none' && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={reachable}
              onChange={(event) => setReachable(event.target.checked)}
              className="h-4 w-4 rounded-sm border-gray-300 accent-robin-orange"
            />
            robin-admin can also reach {meta.label} over the network
          </label>
        )}
      </Section>

      {error && <div className="rounded-sm border border-red-200 bg-red-50 p-3 text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">{error}</div>}
      {!matrix && !error && <div className="flex justify-center py-8"><Spinner className="text-robin-orange" /></div>}

      {matrix && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Section title={`Works (${works.length})`}>
              <ul className="space-y-2">
                {works.map((rule) => (
                  <li key={rule.id} className="flex gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" aria-hidden="true" />
                    <span><strong className="text-gray-900 dark:text-white">{rule.label}</strong> <span className="text-gray-500 dark:text-gray-400">· {rule.surface}</span></span>
                  </li>
                ))}
              </ul>
            </Section>
            <Section title={`Hidden (${hidden.length})`}>
              {hidden.length === 0 ? <p>Nothing: every {meta.label} feature works in this setup.</p> : (
                <ul className="space-y-2">
                  {hidden.map((rule) => (
                    <li key={rule.id} className="flex gap-2">
                      <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
                      <span><strong className="text-gray-900 dark:text-white">{rule.label}</strong>: {current[rule.id]?.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>

          <Section step={3} title="Set it up">
            <ol className="list-decimal space-y-3 pl-5">
              <li>
                Add the service in <Link to="/fleet" className="text-robin-orange hover:underline">Fleet → Services</Link> as <strong>{meta.label}</strong>
                {fields.length > 0 ? ' with:' : ', leaving the endpoints blank.'}
                {fields.length > 0 && (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {fields.map((field) => (
                      <div key={field.label}>
                        <div className="text-[11px] font-medium text-gray-500 dark:text-gray-400">{field.label}</div>
                        <div className="mt-0.5 truncate rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 font-mono text-xs text-gray-800 dark:border-robin-gray-700 dark:bg-robin-gray-800 dark:text-gray-100">{field.value}</div>
                      </div>
                    ))}
                  </div>
                )}
              </li>
              {agent !== 'none' && (
                <>
                  <li>
                    Create an agent in <Link to="/fleet/agents" className="text-robin-orange hover:underline">Fleet → Agents</Link> and run it with:
                    <pre className="mt-2 overflow-x-auto rounded-md bg-gray-900 p-3 font-mono text-xs text-gray-100">{agentSnippet(type, agent)}</pre>
                    <p className="mt-2">It needs {guide.agentNeeds}</p>
                    {agent === 'ssh' && <p className="mt-1">Over ssh the agent runs commands but can&apos;t place files, so config stays with your own tooling.</p>}
                  </li>
                  <li>In the agent&apos;s <em>Services</em> panel, assign this service as a full agent (metrics, config and logs), or on just the axes you want it to own.</li>
                </>
              )}
            </ol>
          </Section>

          <Section title={`Every ${meta.label} setup`}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-xs">
                <thead>
                  <tr className="border-b border-gray-200 text-left dark:border-gray-700">
                    <th scope="col" className="py-2 pr-3 font-medium">Feature</th>
                    {rows.map((row) => (
                      <th key={setupLabel(row.setup)} scope="col" className={`px-2 py-2 font-medium ${sameSetup(row.setup, setup) ? 'text-robin-orange' : ''}`}>{setupLabel(row.setup)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {rules.map((rule) => (
                    <tr key={rule.id}>
                      <th scope="row" className="py-1.5 pr-3 text-left font-normal text-gray-700 dark:text-gray-200">{rule.label}</th>
                      {rows.map((row) => <MatrixCell key={setupLabel(row.setup)} state={row.features[rule.id]} />)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title={`Good to know about ${meta.label}`}>
            <ul className="list-disc space-y-1 pl-5">
              {guide.notes.map((note, index) => <li key={index}>{note}</li>)}
            </ul>
          </Section>

          {agent !== 'none' && (
            <Section title="Agent control limits">
              <ul className="list-disc space-y-1 pl-5">
                <li>Operational commands are queued in PostgreSQL, so API replicas that share the database can serve agent controls and queued commands survive robin-admin restarts until they expire.</li>
                <li>PostgreSQL is the durability boundary: if robin-admin cannot reach the database, commands cannot be queued or completed.</li>
                <li>The agent must be actively polling and advertising the action before robin-admin can run it.</li>
                <li>Delivery is retried until acknowledged, and duplicate command ids are skipped by the agent.</li>
                <li>If a result is lost after the agent already ran the command, robin-admin expires the command at its timeout; verify service state before retrying non-idempotent actions.</li>
                <li>Commands have short safety timeouts, and large command output is capped before it is posted back.</li>
              </ul>
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function MatrixCell({ state }: { state: CapabilityState | undefined }) {
  if (state?.available) {
    return <td className="px-2 py-1.5"><Check className="h-4 w-4 text-green-600 dark:text-green-400" aria-label="Works" /></td>;
  }
  return (
    <td className="px-2 py-1.5" title={state?.reason}>
      <Minus className="h-4 w-4 text-gray-400" aria-label={state?.reason ? `Hidden: ${state.reason}` : 'Hidden'} />
    </td>
  );
}
