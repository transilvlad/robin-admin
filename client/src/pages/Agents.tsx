import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, RefreshCw, Trash2 } from 'lucide-react';
import { agentsApi, configApi, fleetServicesApi, ApiError } from '../api/client';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { PageHeader } from '../components/ui/PageHeader';
import { appIcons } from '../constants/appIcons';
import { normalizeBasePath } from '../utils/basePath';
import { useConfirm } from '../context/ConfirmContext';
import type { AgentServiceResponsibility, CreatedFleetAgent, FleetAgent, FleetAgentStatus, FleetService } from '../types';

const STATUS_STYLES: Record<FleetAgentStatus, string> = {
  online: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  offline: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
};

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/** Forward duration until a future timestamp, e.g. "24h". */
function expiresIn(iso: string): string {
  const secs = Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

type DeployMethod = 'docker' | 'compose' | 'systemd' | 'manual';
const DEPLOY_METHODS: { key: DeployMethod; label: string }[] = [
  { key: 'docker', label: 'Docker' },
  { key: 'compose', label: 'Compose' },
  { key: 'systemd', label: 'systemd' },
  { key: 'manual', label: 'Manual' },
];

interface AgentDeployConfig {
  agentImage: string;
  agentInstallUrl: string;
  agentReleaseUrl: string;
  agentDeployGuideUrl: string;
}

export function agentDeploymentTarget(origin: string, basePath: string): { url: string; insecure: boolean } {
  const url = new URL(normalizeBasePath(basePath), origin);
  return { url: url.href.replace(/\/$/, ''), insecure: ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) };
}

function buildInstallSnippet(method: DeployMethod, baseUrl: string, id: string, token: string, insecure: boolean, deploy: AgentDeployConfig): string {
  if (method === 'docker') {
    return [
      'docker run -d --name robin-agent --restart unless-stopped \\',
      `  -e ROBIN_ADMIN_URL=${baseUrl} \\`,
      `  -e ROBIN_AGENT_ID=${id} \\`,
      `  -e ROBIN_ENROLLMENT_TOKEN=${token} \\`,
      ...(insecure ? ['  -e ROBIN_AGENT_INSECURE=1 \\'] : []),
      '  -v robin-agent-state:/var/lib/robin-agent \\',
      `  ${deploy.agentImage}`,
    ].join('\n');
  }
  if (method === 'compose') {
    return [
      '# docker-compose.yaml',
      'services:',
      '  robin-agent:',
      `    image: ${deploy.agentImage}`,
      '    restart: unless-stopped',
      '    environment:',
      `      ROBIN_ADMIN_URL: ${baseUrl}`,
      `      ROBIN_AGENT_ID: ${id}`,
      `      ROBIN_ENROLLMENT_TOKEN: ${token}`,
      ...(insecure ? ['      ROBIN_AGENT_INSECURE: "1"'] : []),
      '    volumes:',
      '      - robin-agent-state:/var/lib/robin-agent',
      'volumes:',
      '  robin-agent-state:',
    ].join('\n');
  }
  if (method === 'systemd') {
    return [
      `curl -fsSL ${deploy.agentInstallUrl} \\`,
      `  | sudo ROBIN_ADMIN_URL=${baseUrl} \\`,
      `         ROBIN_AGENT_ID=${id} \\`,
      `         ROBIN_ENROLLMENT_TOKEN=${token} \\`,
      `         ${insecure ? 'ROBIN_AGENT_INSECURE=1 ' : ''}sh`,
    ].join('\n');
  }
  // manual / air-gapped — download + verify + install, then wire it into
  // systemd by hand. Mirrors exactly what install.sh does on a host that CAN
  // run it; use this on one that can't (no outbound access at all). A bare
  // foreground run isn't shown here on purpose — it dies with the terminal
  // and never restarts, so it's not a real deployment.
  return [
    '# Match your OS/arch: linux-amd64 | linux-arm64 | darwin-amd64 | darwin-arm64',
    `curl -fsSLO ${deploy.agentReleaseUrl}/robin-agent-linux-amd64`,
    `curl -fsSLO ${deploy.agentReleaseUrl}/SHA256SUMS.agent`,
    'sha256sum -c --ignore-missing SHA256SUMS.agent',
    'sudo install -m 0755 robin-agent-linux-amd64 /usr/local/bin/robin-agent',
    '',
    '# Env file + systemd unit (what install.sh would write for you if it could reach GitHub):',
    'sudo install -d -m 0750 /etc/robin-agent',
    'sudo tee /etc/robin-agent/agent.env > /dev/null <<EOF',
    `ROBIN_ADMIN_URL=${baseUrl}`,
    `ROBIN_AGENT_ID=${id}`,
    `ROBIN_ENROLLMENT_TOKEN=${token}`,
    ...(insecure ? ['ROBIN_AGENT_INSECURE=1'] : []),
    'EOF',
    'sudo chmod 0600 /etc/robin-agent/agent.env',
    '',
    "sudo tee /etc/systemd/system/robin-agent.service > /dev/null <<'UNIT'",
    '[Unit]',
    'Description=robin-agent (robin-admin fleet agent)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    'EnvironmentFile=/etc/robin-agent/agent.env',
    'Environment=ROBIN_AGENT_STATE=/var/lib/robin-agent/state.json',
    'ExecStart=/usr/local/bin/robin-agent',
    'Restart=always',
    'RestartSec=5',
    'StateDirectory=robin-agent',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'UNIT',
    'sudo systemctl daemon-reload',
    'sudo systemctl enable --now robin-agent.service',
  ].join('\n');
}

export function AgentsPage() {
  const confirm = useConfirm();
  const [agents, setAgents] = useState<FleetAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // The enrollment token is shown ONCE, right after create/rotate.
  const [enrollment, setEnrollment] = useState<{ agent: FleetAgent; token: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [deployMethod, setDeployMethod] = useState<DeployMethod>('docker');
  // Service assignment (which services this agent collects).
  const [managing, setManaging] = useState<FleetAgent | null>(null);
  const [assigned, setAssigned] = useState<AgentServiceResponsibility[]>([]);
  const [allServices, setAllServices] = useState<FleetService[]>([]);
  const [assignId, setAssignId] = useState('');
  const [logAssignId, setLogAssignId] = useState('');
  const [configAssignId, setConfigAssignId] = useState('');
  const [svcBusy, setSvcBusy] = useState(false);
  const [deployConfig, setDeployConfig] = useState<AgentDeployConfig | null>(null);

  const loadServices = useCallback(async (agent: FleetAgent) => {
    setSvcBusy(true);
    try {
      const [mine, all] = await Promise.all([agentsApi.listServices(agent.agentId), fleetServicesApi.list()]);
      setAssigned(mine.data ?? []);
      setAllServices(all.data ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load services');
    } finally {
      setSvcBusy(false);
    }
  }, []);

  const openManage = (agent: FleetAgent) => {
    setManaging(agent);
    setAssignId('');
    setLogAssignId('');
    setConfigAssignId('');
    void loadServices(agent);
  };

  const handleAssign = async () => {
    if (!managing || !assignId) return;
    setSvcBusy(true);
    setError('');
    try {
      await agentsApi.assignService(managing.agentId, assignId);
      setAssignId('');
      await loadServices(managing);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to assign service');
    } finally {
      setSvcBusy(false);
    }
  };

  const handleAssignLog = async () => {
    if (!managing || !logAssignId) return;
    setSvcBusy(true);
    setError('');
    try {
      await agentsApi.assignLogService(managing.agentId, logAssignId);
      setLogAssignId('');
      await loadServices(managing);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to assign log service');
    } finally {
      setSvcBusy(false);
    }
  };

  const handleAssignConfig = async () => {
    if (!managing || !configAssignId) return;
    setSvcBusy(true);
    setError('');
    try {
      await agentsApi.assignConfigService(managing.agentId, configAssignId);
      setConfigAssignId('');
      await loadServices(managing);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to assign config service');
    } finally {
      setSvcBusy(false);
    }
  };

  // Detach this agent from EVERY axis it holds for the service — full-agent
  // metrics switch back to direct, plus any config-only / logs-only assignment.
  const handleRelease = async (svc: AgentServiceResponsibility) => {
    if (!managing) return;
    setSvcBusy(true);
    setError('');
    try {
      if (svc.collectMetrics) {
        await agentsApi.releaseService(managing.agentId, svc.serviceId);
      }
      if (svc.configAgentId === managing.agentId) {
        await agentsApi.releaseConfigService(managing.agentId, svc.serviceId);
      }
      if (svc.logAgentId === managing.agentId) {
        await agentsApi.releaseLogService(managing.agentId, svc.serviceId);
      }
      await loadServices(managing);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to release service');
    } finally {
      setSvcBusy(false);
    }
  };

  const load = useCallback(async () => {
    try {
      const [res, config] = await Promise.all([agentsApi.list(), configApi.get()]);
      if (!config.data) throw new Error('Agent deployment settings missing');
      setAgents(res.data ?? []);
      setDeployConfig({
        agentImage: config.data.agentImage,
        agentInstallUrl: config.data.agentInstallUrl,
        agentReleaseUrl: config.data.agentReleaseUrl,
        agentDeployGuideUrl: config.data.agentDeployGuideUrl,
      });
      setError('');
    } catch (err) {
      setDeployConfig(null);
      setError(err instanceof Error ? err.message : 'Failed to load agents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 15000);
    return () => clearInterval(interval);
  }, [load]);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || !deployConfig || creating) return;
    setCreating(true);
    setError('');
    try {
      const res = await agentsApi.create({ name: trimmed });
      const created = res.data as CreatedFleetAgent;
      setEnrollment({ agent: created.agent, token: created.enrollment.token, expiresAt: created.enrollment.expiresAt });
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create agent');
    } finally {
      setCreating(false);
    }
  };

  const handleRotate = async (agent: FleetAgent) => {
    if (!deployConfig) return;
    setBusyId(agent.agentId);
    setError('');
    try {
      const res = await agentsApi.rotateEnrollment(agent.agentId);
      setEnrollment({ agent, token: res.data!.enrollment.token, expiresAt: res.data!.enrollment.expiresAt });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to rotate enrollment token');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (agent: FleetAgent) => {
    if (!(await confirm(`Delete agent "${agent.name}"? Its services fall back to direct mode and it must re-enroll to return.`))) return;
    setBusyId(agent.agentId);
    setError('');
    try {
      await agentsApi.remove(agent.agentId);
      if (enrollment?.agent.agentId === agent.agentId) setEnrollment(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete agent');
    } finally {
      setBusyId(null);
    }
  };

  const enrollmentCardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (enrollment) {
      enrollmentCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [enrollment]);

  const { url: baseUrl, insecure } = useMemo(() => agentDeploymentTarget(window.location.origin, import.meta.env.BASE_URL), []);
  const installSnippet = useMemo(
    () => (enrollment && deployConfig ? buildInstallSnippet(deployMethod, baseUrl, enrollment.agent.agentId, enrollment.token, insecure, deployConfig) : ''),
    [enrollment, baseUrl, deployMethod, insecure, deployConfig]
  );

  const copySnippet = async () => {
    try {
      await navigator.clipboard?.writeText(installSnippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; ignore */
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.fleetAgents}
        title="Fleet agents"
        actions={<Button variant="secondary" onClick={() => void load()}><RefreshCw className="h-4 w-4" /> Refresh</Button>}
      />

      {error && (
        <div role="alert" className="rounded-sm border border-red-200 bg-red-50 p-3 text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">{error}</div>
      )}

      <div className="card p-4">
        <h2 className="text-lg font-semibold">Add an agent</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Name the host or container this agent will run on (e.g. <code>mta-inbound-1</code>). You'll get a one-time enrollment command.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
            placeholder="Agent name"
            className="flex-1 min-w-[220px] rounded-sm border border-gray-300 px-3 py-2 text-sm dark:border-robin-gray-700 dark:bg-robin-gray-900"
          />
          <Button onClick={() => void handleCreate()} isLoading={creating} disabled={!name.trim() || !deployConfig}>Create agent</Button>
        </div>
      </div>

      {enrollment && deployConfig && (
        <div ref={enrollmentCardRef} className="card border-robin-orange/40 p-4">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold">Enroll <strong>{enrollment.agent.name}</strong></h2>
            <button onClick={() => setEnrollment(null)} className="text-sm text-gray-500 hover:underline">Dismiss</button>
          </div>
          <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
            This enrollment token is shown once and expires in {expiresIn(enrollment.expiresAt)} — it won't be shown again after you
            dismiss or leave this page. If that happens, use <strong>{enrollment.agent.status === 'pending' ? 'Get install command' : 'New token'}</strong> on
            its row below to get a fresh one. Pick how you'll deploy it, then run this on the host:
          </p>
          <div className="mt-3 flex flex-wrap gap-1">
            {DEPLOY_METHODS.map((m) => (
              <button
                key={m.key}
                onClick={() => setDeployMethod(m.key)}
                className={`rounded-sm px-3 py-1 text-sm font-medium transition-colors ${deployMethod === m.key ? 'bg-robin-orange text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-robin-gray-700 dark:text-gray-200 dark:hover:bg-robin-gray-600'}`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="relative mt-3">
            <pre className="overflow-x-auto rounded-sm bg-gray-900 p-4 text-xs text-gray-100">{installSnippet}</pre>
            <button onClick={() => void copySnippet()} className="absolute right-2 top-2 flex items-center gap-1 rounded-sm bg-white/10 px-2 py-1 text-xs text-white hover:bg-white/20">
              <Copy className="h-3 w-3" /> {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {insecure && <>Self-signed target: <code>ROBIN_AGENT_INSECURE=1</code> is included — drop it once robin-admin has a trusted certificate. </>}
            Exec-only services (Postfix, Dovecot, Cyrus IMAP) need their tooling on the host (<code>postqueue</code>, <code>doveadm</code>, <code>cyr_info</code>, <code>quota</code>, <code>mbpath</code>); network services (Redis/Postgres/MariaDB) usually stay in direct mode, unless robin-admin cannot reach them (a loopback-only MariaDB: give the agent <code>ROBIN_AGENT_MARIADB_DSN</code>).{' '}
            <a href={deployConfig.agentDeployGuideUrl} target="_blank" rel="noreferrer" className="text-robin-orange hover:underline">Deployment guide →</a>
          </p>
        </div>
      )}

      <div className="card p-4">
        <h2 className="text-lg font-semibold">Agents</h2>
        {loading ? (
          <div className="flex justify-center py-8"><Spinner className="text-robin-orange" /></div>
        ) : agents.length === 0 ? (
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">No agents yet. Add one above to manage a remote host.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Agent</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Status</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Host</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Discovered</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Last seen</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {agents.map((agent) => (
                  <tr key={agent.agentId}>
                    <td className="px-3 py-2">
                      <div className="font-medium">{agent.name}</div>
                      <div className="font-mono text-xs text-gray-400">{agent.agentId.slice(0, 12)}{agent.agentVersion ? ` · v${agent.agentVersion}` : ''}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[agent.status]}`}>{agent.status}</span>
                    </td>
                    <td className="px-3 py-2">
                      {agent.hostname ?? '—'}
                      {agent.os && <span className="text-gray-400"> · {agent.os}/{agent.arch}</span>}
                    </td>
                    <td className="px-3 py-2">
                      {agent.discovered.length === 0 ? (
                        <span className="text-gray-400">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {agent.discovered.map((d, i) => (
                            <span key={`${d.serviceType}-${i}`} className="rounded-sm bg-gray-100 px-1.5 py-0.5 text-xs dark:bg-robin-gray-700" title={d.detail}>{d.serviceType}</span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{relativeTime(agent.lastSeenAt)}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="secondary" onClick={() => openManage(agent)}>Services</Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void handleRotate(agent)}
                          isLoading={busyId === agent.agentId}
                          disabled={!deployConfig}
                          title={agent.status === 'pending' ? 'Show the install command again (issues a fresh token)' : 'Issue a fresh enrollment token to re-enroll this agent'}
                        >
                          {agent.status === 'pending' ? 'Get install command' : 'New token'}
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => void handleDelete(agent)} disabled={busyId === agent.agentId}><Trash2 className="h-4 w-4" /></Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {managing && (
        <div className="card border-robin-orange/40 p-4">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold">Responsibilities of <strong>{managing.name}</strong></h2>
            <button onClick={() => setManaging(null)} className="text-sm text-gray-500 hover:underline">Close</button>
          </div>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Each axis — <span className="font-medium">metrics</span>, <span className="font-medium">config</span>, <span className="font-medium">logs</span> — is chosen per service, independently. Use the agent only where robin-admin can't reach the service directly; leave the rest on their direct endpoints so nothing depends 100% on the agent.
            {' '}<span className="font-medium">Full agent</span> takes all three (agent mode). <span className="font-medium">Config only</span> / <span className="font-medium">Logs only</span> take just that axis while metrics stay direct.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="flex flex-wrap gap-2">
              <select
                value={assignId}
                onChange={(e) => setAssignId(e.target.value)}
                className="min-w-[160px] flex-1 rounded-sm border border-gray-300 px-3 py-2 text-sm dark:border-robin-gray-700 dark:bg-robin-gray-900"
              >
                <option value="">Full agent…</option>
                {allServices.filter((s) => (s.collectionMode ?? 'direct') !== 'agent').map((s) => (
                  <option key={s.serviceId} value={s.serviceId}>{s.name} ({s.serviceType})</option>
                ))}
              </select>
              <Button onClick={() => void handleAssign()} isLoading={svcBusy} disabled={!assignId}>Assign</Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <select
                value={configAssignId}
                onChange={(e) => setConfigAssignId(e.target.value)}
                className="min-w-[160px] flex-1 rounded-sm border border-gray-300 px-3 py-2 text-sm dark:border-robin-gray-700 dark:bg-robin-gray-900"
              >
                <option value="">Config only…</option>
                {allServices.filter((s) => s.serviceType !== 'cyrus' && s.configAgentId !== managing.agentId && (s.collectionMode ?? 'direct') !== 'agent').map((s) => (
                  <option key={s.serviceId} value={s.serviceId}>{s.name} ({s.serviceType})</option>
                ))}
              </select>
              <Button variant="secondary" onClick={() => void handleAssignConfig()} isLoading={svcBusy} disabled={!configAssignId}>Assign config</Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <select
                value={logAssignId}
                onChange={(e) => setLogAssignId(e.target.value)}
                className="min-w-[160px] flex-1 rounded-sm border border-gray-300 px-3 py-2 text-sm dark:border-robin-gray-700 dark:bg-robin-gray-900"
              >
                <option value="">Logs only…</option>
                {allServices.filter((s) => s.logAgentId !== managing.agentId && (s.collectionMode ?? 'direct') !== 'agent').map((s) => (
                  <option key={s.serviceId} value={s.serviceId}>{s.name} ({s.serviceType})</option>
                ))}
              </select>
              <Button variant="secondary" onClick={() => void handleAssignLog()} isLoading={svcBusy} disabled={!logAssignId}>Assign logs</Button>
            </div>
          </div>
          <div className="mt-4">
            {assigned.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">No services assigned yet.</p>
            ) : (
              <ul className="divide-y divide-gray-200 dark:divide-gray-700">
                {assigned.map((s) => (
                  <li key={s.serviceId} className="flex items-center justify-between gap-3 py-2">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{s.name}</span>
                      <span className="text-xs text-gray-400">· {s.serviceType}</span>
                      {s.collectMetrics && <span className="rounded-sm bg-sky-500/15 px-1.5 py-0.5 text-[11px] font-medium text-sky-500">metrics</span>}
                      {s.collectConfig && <span className="rounded-sm bg-violet-500/15 px-1.5 py-0.5 text-[11px] font-medium text-violet-500">config</span>}
                      {s.collectLogs && <span className="rounded-sm bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-500">logs</span>}
                      {!s.collectMetrics && <span className="text-[11px] text-gray-400">(direct metrics)</span>}
                    </span>
                    <Button size="sm" variant="secondary" onClick={() => void handleRelease(s)} disabled={svcBusy}>
                      {s.collectMetrics ? 'Release' : 'Stop logs'}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
