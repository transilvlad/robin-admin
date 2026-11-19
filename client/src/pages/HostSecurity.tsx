import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { hostSecurityApi } from '../api/client';
import { PageHeader } from '../components/ui/PageHeader';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import { useAuth } from '../context/AuthContext';
import type { HostSecurityCounter, HostSecurityDiffItem, HostSecurityKnownAddress, HostSecuritySectionName } from '../types/host-security';

const sectionLabels: Record<HostSecuritySectionName, string> = {
  sshKeys: 'Authorized SSH keys', sshd: 'SSH settings', accounts: 'Login accounts',
  privilegedGroups: 'Privileged groups', sudoers: 'Sudo rules', cron: 'Scheduled jobs',
  systemd: 'Enabled units', listeners: 'Network listeners', firewall: 'Firewall',
  patching: 'Security maintenance', integrity: 'File integrity',
};

function Badges({ values }: { values: string[] }) {
  return <div className="flex flex-wrap gap-2">{values.map(value =>
    <span key={value} className="rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-100">{value}</span>)}</div>;
}

function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error instanceof Error ? error.message : String(error)}</p>;
}

function localTime(value: string) {
  return new Date(value).toLocaleString();
}

export function FleetSecurityPage() {
  const [cursor, setCursor] = useState<string>();
  const hosts = useQuery({ queryKey: ['host-security', 'hosts', cursor], queryFn: async () => (await hostSecurityApi.hosts(cursor)).data });
  return <div className="space-y-6">
    <PageHeader icon={appIcons.hostSecurity} title="Host security" description="Baseline drift, sign-ins, and security maintenance across Fleet hosts." />
    <Link to="/fleet/security/known-addresses" className="text-robin-orange hover:underline">Known addresses</Link>
    <ErrorNotice error={hosts.error} />
    {hosts.isPending ? <Spinner /> : null}
    {hosts.data?.items.length === 0 && <p>No hosts have reported security telemetry.</p>}
    <div className="divide-y rounded-lg border border-gray-200 dark:border-gray-700">
      {hosts.data?.items.map(host => <article key={host.hostId} className="space-y-2 p-4">
        <Link className="font-medium text-robin-orange hover:underline" to={`/fleet/security/${encodeURIComponent(host.hostId)}`}>{host.name}</Link>
        <Badges values={[
          ...(host.baselinePending ? ['Baseline pending'] : []),
          ...(host.unapprovedDrift ? [`${host.unapprovedDrift} unapproved changes`] : []),
          ...(host.passwordLoginEnabled ? ['Password login enabled'] : []),
          ...(host.unknownLogins24h ? [`${host.unknownLogins24h} unknown-address logins in 24 hours`] : []),
          ...(host.patchAgeDays != null ? [`Security upgrades pending for ${host.patchAgeDays} days`] : []),
          ...(host.stale ? ['Telemetry stale'] : []),
        ]} />
        <p className="text-sm text-gray-500 dark:text-gray-400">Last receipt {localTime(host.lastReceivedAt)}</p>
      </article>)}
    </div>
    <div className="flex gap-2">
      {cursor && <Button variant="secondary" onClick={() => setCursor(undefined)}>First page</Button>}
      {hosts.data?.nextCursor && <Button variant="secondary" onClick={() => setCursor(hosts.data?.nextCursor ?? undefined)}>Next page</Button>}
    </div>
  </div>;
}

function describeChange(item: HostSecurityDiffItem) {
  if (item.section === 'sshKeys') {
    const key = item.after ?? item.before;
    if (key) return `Key ${key.fingerprint}${key.comment ? ` (${key.comment})` : ''} ${item.change} for ${key.user}`;
  }
  return `${item.itemId} ${item.change}`;
}

function FailedAuthChart({ counters }: { counters: HostSecurityCounter[] }) {
  const samples = [...counters].reverse().map(item => ({
    minute: item.minute, failures: item.invalidUser + item.failedKey + item.failedPassword,
  }));
  const max = Math.max(1, ...samples.map(sample => sample.failures));
  return <div aria-label="Failed authentication attempts per reported minute" role="img" className="flex h-16 items-end gap-px">
    {samples.map(sample => <div key={sample.minute} className="min-w-0 flex-1 bg-robin-orange" style={{ height: `${Math.max(2, sample.failures / max * 100)}%` }} title={`${localTime(sample.minute)} · ${sample.failures}`} />)}
  </div>;
}

export function HostSecurityPage() {
  const { hostId = '' } = useParams();
  const { user } = useAuth();
  const client = useQueryClient();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [diffLimit, setDiffLimit] = useState(100);
  const [openSections, setOpenSections] = useState<Partial<Record<HostSecuritySectionName, boolean>>>({});
  const [sectionLimits, setSectionLimits] = useState<Partial<Record<HostSecuritySectionName, number>>>({});
  const security = useQuery({
    queryKey: ['host-security', 'host', hostId],
    queryFn: async () => {
      const [snapshot, diff, events, counters] = await Promise.all([
        hostSecurityApi.snapshot(hostId), hostSecurityApi.diff(hostId), hostSecurityApi.events(hostId), hostSecurityApi.counters(hostId),
      ]);
      return { snapshot: snapshot.data, diff: diff.data, events: events.data?.items ?? [], counters: counters.data?.items ?? [] };
    },
  });
  const current = security.data;
  const approve = async (itemIds?: string[]) => {
    if (!current?.diff) return;
    try {
      setBusy(true);
      setError(null);
      await hostSecurityApi.approve(hostId, {
        snapshotId: current.diff.snapshotId, baselineRevision: current.diff.baselineRevision,
        itemIds, reason: reason.trim() || undefined,
      });
      setReason('');
    } catch (failure) {
      setError(failure);
    } finally {
      await client.invalidateQueries({ queryKey: ['host-security'] });
      setBusy(false);
    }
  };
  return <div className="space-y-6">
    <PageHeader icon={appIcons.hostSecurity} title="Host security details" description={hostId} />
    <Link to="/fleet/security" className="text-robin-orange hover:underline">All security hosts</Link>
    <ErrorNotice error={error ?? security.error} />
    {security.isPending && <Spinner />}
    {current?.snapshot && current.diff && <>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Baseline changes</h2>
        {current.diff.baselinePending && <Badges values={['Baseline pending']} />}
        {!current.diff.items.length && <p>No differences from the baseline.</p>}
        {user?.role === 'admin' && <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">Approval reason
            <input value={reason} onChange={event => setReason(event.target.value)} maxLength={512} className="rounded border border-gray-400 bg-transparent px-2 py-1" />
          </label>
          <Button disabled={busy || (!current.diff.baselinePending && !current.diff.items.length)} onClick={() => void approve()}>
            {current.diff.baselinePending ? 'Approve baseline' : 'Approve all readable changes'}
          </Button>
        </div>}
        <ul className="space-y-2">
          {current.diff.items.slice(0, diffLimit).map(item => <li key={item.id} className="rounded border border-gray-200 p-3 dark:border-gray-700">
            <p className="font-medium">{describeChange(item)}</p>
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer">Investigate</summary>
              <pre className="mt-2 overflow-auto whitespace-pre-wrap">{JSON.stringify({ before: item.before, after: item.after }, null, 2)}</pre>
            </details>
            {user?.role === 'admin' && <Button variant="secondary" disabled={busy || current.snapshot?.sections[item.section].status !== 'ok'} onClick={() => void approve([item.id])}>Approve</Button>}
          </li>)}
        </ul>
        {current.diff.items.length > diffLimit && <Button variant="secondary" onClick={() => setDiffLimit(diffLimit + 100)}>Show more changes</Button>}
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Current snapshot</h2>
        <p className="text-sm">Observed {localTime(current.snapshot.observedAt)}</p>
        {(Object.keys(sectionLabels) as HostSecuritySectionName[]).map(name => {
          const section = current.snapshot!.sections[name];
          const limit = sectionLimits[name] ?? 100;
          return <details key={name} className="rounded border border-gray-200 p-3 dark:border-gray-700" onToggle={event => {
            const open = event.currentTarget.open;
            setOpenSections(previous => ({ ...previous, [name]: open }));
          }}>
            <summary className="cursor-pointer">{sectionLabels[name]} · {section.items.length} · {section.status.replace(/_/g, ' ')}{!section.complete && ' (incomplete)'}</summary>
            {openSections[name] && <dl className="mt-3 space-y-3">
              {section.items.slice(0, limit).map(item => <div key={item.id}><dt className="font-medium">{item.id}</dt>
                <dd className="break-words text-sm">{Object.entries(item.value).map(([key, value]) => value == null ? null :
                  <div key={key}><span className="font-medium">{key}</span> {Array.isArray(value) ? value.join(', ') : String(value)}</div>)}</dd>
              </div>)}
            </dl>}
            {openSections[name] && section.items.length > limit && <Button variant="secondary" onClick={() => setSectionLimits(previous => ({ ...previous, [name]: limit + 100 }))}>Show more items</Button>}
          </details>;
        })}
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Failed authentication</h2>
        {current.counters.length ? <FailedAuthChart counters={current.counters} /> : <p>No authentication counters reported.</p>}
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Recent security events</h2>
        {current.events.length ? <ul className="space-y-2">{current.events.map(event => <li key={event.id} className="rounded border border-gray-200 p-3 text-sm dark:border-gray-700">
          <p className="font-medium">{event.type.replace(/_/g, ' ')} · {localTime(event.observedAt)}</p>
          <p className="break-words">{event.line}</p>
        </li>)}</ul> : <p>No recent events.</p>}
      </section>
    </>}
  </div>;
}

export function HostSecurityAddressesPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [entry, setEntry] = useState<HostSecurityKnownAddress>({ id: '', network: '', label: '', expiresAt: null });
  const [cursor, setCursor] = useState<string>();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const addresses = useQuery({ queryKey: ['host-security', 'addresses', cursor], queryFn: async () => (await hostSecurityApi.addresses(cursor)).data });
  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setEntry({ id: '', network: '', label: '', expiresAt: null });
      await queryClient.invalidateQueries({ queryKey: ['host-security', 'addresses'] });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { id, ...value } = entry;
    void change(() => hostSecurityApi.saveAddress(value, id || undefined));
  }
  const fieldStyle = 'rounded border border-gray-400 bg-transparent px-2 py-1';
  return <div className="space-y-6">
    <PageHeader icon={appIcons.hostSecurity} title="Known addresses" description="Classify successful sign-ins from trusted IP addresses and networks." />
    <Link to="/fleet/security" className="text-robin-orange hover:underline">All security hosts</Link>
    <ErrorNotice error={error ?? addresses.error} />
    {user?.role === 'admin' && <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <label className="grid gap-1">IP address or CIDR<input className={fieldStyle} required value={entry.network} onChange={e => setEntry({ ...entry, network: e.target.value })} /></label>
      <label className="grid gap-1">Label<input className={fieldStyle} required maxLength={128} value={entry.label} onChange={e => setEntry({ ...entry, label: e.target.value })} /></label>
      <label className="grid gap-1">Expiry (UTC)<input type="datetime-local" className={fieldStyle} value={entry.expiresAt?.slice(0, 16) ?? ''} onChange={e => setEntry({ ...entry, expiresAt: e.target.value ? `${e.target.value}:00Z` : null })} /></label>
      <Button type="submit" disabled={busy}>{entry.id ? 'Save address' : 'Add address'}</Button>
      {entry.id && <Button type="button" variant="secondary" onClick={() => setEntry({ id: '', network: '', label: '', expiresAt: null })}>Cancel</Button>}
    </form>}
    {addresses.isPending && <Spinner />}
    {addresses.data?.items.length === 0 && <p>No known addresses are configured.</p>}
    <ul className="divide-y rounded border border-gray-200 dark:border-gray-700">
      {addresses.data?.items.map(address => <li key={address.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
        <p><strong>{address.label}</strong> · {address.network}{address.expiresAt && ` · Expires ${localTime(address.expiresAt)}`}</p>
        {user?.role === 'admin' && <div className="flex gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => setEntry(address)}>Edit</Button>
          <Button variant="secondary" disabled={busy} onClick={() => void change(() => hostSecurityApi.deleteAddress(address.id))}>Remove</Button>
        </div>}
      </li>)}
    </ul>
    <div className="flex gap-2">
      {cursor && <Button variant="secondary" onClick={() => setCursor(undefined)}>First page</Button>}
      {addresses.data?.nextCursor && <Button variant="secondary" onClick={() => setCursor(addresses.data?.nextCursor ?? undefined)}>Next page</Button>}
    </div>
  </div>;
}
