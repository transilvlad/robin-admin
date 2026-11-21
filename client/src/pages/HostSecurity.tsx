import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Clock3, FileCheck2, FileDiff, ListTree, LogIn, RefreshCw, Server } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { hostSecurityApi } from '../api/client';
import { HostSecurityChanges } from '../components/fleet/HostSecurityChanges';
import { HostSecuritySignIns } from '../components/fleet/HostSecuritySignIns';
import {
  CoverageBadge, SecurityBadge, SecurityError, SecurityPagination, SecurityTime, hostSecuritySectionLabels,
  securityFieldLabel, securityFieldValue, useSecurityPagination,
} from '../components/fleet/hostSecurityUi';
import { Button } from '../components/ui/Button';
import { MetricCard } from '../components/ui/MetricCard';
import { MetricTabs, type MetricTab } from '../components/ui/MetricTabs';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { Table, type Column } from '../components/ui/Table';
import { appIcons } from '../constants/appIcons';
import type { HostSecurityPosture, HostSecuritySectionName, HostSecuritySnapshot, HostSecurityStatus } from '../types/host-security';

const sectionNames = Object.keys(hostSecuritySectionLabels) as HostSecuritySectionName[];

function hostSecurityPath(hostId: string) {
  return '/fleet/security/' + encodeURIComponent(hostId);
}

const fleetColumns: Column<HostSecurityPosture>[] = [
  {
    key: 'name', header: 'Host',
    render: host => <Link className="font-medium text-robin-orange hover:underline" to={hostSecurityPath(host.hostId)}>{host.name}</Link>,
  },
  {
    key: 'lastReceivedAt', header: 'Security telemetry',
    render: host => (
      <div className="space-y-1">
        <SecurityBadge tone={host.stale ? 'warning' : 'success'}>{host.stale ? 'Stale' : 'Current'}</SecurityBadge>
        <p className="whitespace-nowrap text-xs text-gray-500 dark:text-gray-400"><SecurityTime value={host.lastReceivedAt} /></p>
      </div>
    ),
  },
  {
    key: 'baseline', header: 'Baseline',
    render: host => {
      const reviewLabel = host.baselinePending ? 'Review baseline' : `${host.unapprovedDrift} to review`;
      return (
        <div className="flex flex-wrap gap-1">
          {host.baselinePending || host.unapprovedDrift > 0 ? (
            <Link className="rounded-full hover:underline" to={hostSecurityPath(host.hostId)} aria-label={`${reviewLabel} for ${host.name}`}>
              <SecurityBadge tone={host.baselinePending ? 'info' : 'warning'}>{reviewLabel}</SecurityBadge>
            </Link>
          ) : <span className="text-gray-500 dark:text-gray-400">No reported changes</span>}
          {host.coverageGapCount > 0 && (
            <SecurityBadge tone="neutral">{host.coverageGapCount} coverage {host.coverageGapCount === 1 ? 'gap' : 'gaps'}</SecurityBadge>
          )}
        </div>
      );
    },
  },
  {
    key: 'unknownLogins24h', header: 'Unknown sign-ins (24h)',
    render: host => host.unknownLogins24h > 0
      ? <SecurityBadge tone="warning">{host.unknownLogins24h}</SecurityBadge>
      : <span className="tabular-nums text-gray-500 dark:text-gray-400">0</span>,
  },
  {
    key: 'passwordLoginEnabled', header: 'SSH password login',
    render: host => {
      if (host.passwordLoginEnabled == null) return <span className="text-gray-500 dark:text-gray-400">Unknown</span>;
      return host.passwordLoginEnabled ? <SecurityBadge tone="warning">Enabled</SecurityBadge> : 'Disabled';
    },
  },
  {
    key: 'patchAgeDays', header: 'Security updates',
    render: host => host.patchAgeDays == null ? <span className="text-gray-500 dark:text-gray-400">—</span>
      : <span className="whitespace-nowrap tabular-nums">Pending {host.patchAgeDays}d</span>,
  },
];

export function FleetSecurityPage() {
  const pagination = useSecurityPagination();
  const hosts = useQuery({
    queryKey: ['host-security', 'hosts', pagination.cursor],
    queryFn: async () => (await hostSecurityApi.hosts(pagination.cursor)).data,
  });

  return (
    <div className="space-y-6">
      <PageHeader icon={appIcons.hostSecurity} title="Host security" description="Review baseline changes, sign-ins, and security updates across Fleet hosts." actions={
        <>
          <Button variant="secondary" onClick={() => void hosts.refetch()} disabled={hosts.isFetching}>
            <RefreshCw aria-hidden="true" className="h-4 w-4" /> Refresh
          </Button>
          <Link className="btn btn-secondary" to="/fleet/security/known-addresses">Known addresses</Link>
        </>
      } />
      <section aria-label="Security hosts" className="card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-robin-gray-700">
          <Server aria-hidden="true" className="h-4 w-4 text-gray-500" />
          <h2 className="font-semibold">Reporting hosts</h2>
        </div>
        {hosts.error && <div className="p-4"><SecurityError error={hosts.error} label="Could not load security hosts" retry={() => void hosts.refetch()} isRetrying={hosts.isFetching} /></div>}
        {(hosts.isPending || hosts.data) && (
          <Table columns={fleetColumns} data={hosts.data?.items ?? []} keyField="hostId" scrollLabel="Reporting hosts"
            isLoading={hosts.isPending} emptyMessage={pagination.page === 1 ? 'No hosts have reported security telemetry.' : 'No hosts on this page.'} />
        )}
        {hosts.isSuccess && pagination.page === 1 && hosts.data?.items.length === 0 && (
          <p className="px-4 pb-6 text-center text-sm text-gray-500 dark:text-gray-400">
            Enable host security collection on an enrolled Linux agent to populate this list.
          </p>
        )}
        <SecurityPagination pagination={pagination} nextCursor={hosts.data?.nextCursor} busy={hosts.isFetching} />
      </section>
    </div>
  );
}

const tabs = [
  { id: 'changes', label: 'Changes', icon: FileDiff },
  { id: 'sign-ins', label: 'Sign-ins', icon: LogIn },
  { id: 'inventory', label: 'Inventory', icon: ListTree },
] as const satisfies readonly MetricTab<string>[];
type SecurityTab = typeof tabs[number]['id'];

export function HostSecurityPage() {
  const { hostId = '' } = useParams();
  return <HostSecurityDetails key={hostId} hostId={hostId} />;
}

function HostSecurityDetails({ hostId }: { hostId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = tabs.find(entry => entry.id === searchParams.get('tab'))?.id ?? 'changes';
  const inventorySection = sectionNames.find(name => name === searchParams.get('section'));
  const snapshot = useQuery({
    queryKey: ['host-security', 'host', hostId, 'snapshot'],
    queryFn: async () => (await hostSecurityApi.snapshot(hostId)).data,
  });
  const diff = useQuery({
    queryKey: ['host-security', 'host', hostId, 'diff'],
    queryFn: async () => (await hostSecurityApi.diff(hostId)).data,
  });
  const currentSnapshot = snapshot.data;
  const currentDiff = diff.data;
  const coverage = currentSnapshot ? sectionNames.map(name => ({
    name, status: currentSnapshot.sections[name].status, complete: currentSnapshot.sections[name].complete,
  })) : [];
  const gaps = coverage.filter(section => section.status !== 'ok' || !section.complete);
  const changes = currentSnapshot && currentDiff?.snapshotId === currentSnapshot.id
    ? currentDiff.items.filter(item => currentSnapshot.sections[item.section].status === 'ok')
    : undefined;
  const readyCount = changes?.length ?? 0;
  const changeTab = (next: SecurityTab) => {
    setSearchParams(previous => {
      const params = new URLSearchParams(previous);
      if (next === 'changes') params.delete('tab');
      else params.set('tab', next);
      params.delete('section');
      return params;
    }, { replace: true });
  };

  return (
    <div className="space-y-5">
      <Link className="inline-flex items-center gap-2 text-sm font-medium text-robin-orange hover:underline" to="/fleet/security">
        <ArrowLeft aria-hidden="true" className="h-4 w-4" /> All security hosts
      </Link>
      <PageHeader icon={appIcons.hostSecurity} title={snapshot.data?.name ?? 'Host security details'} description={
        <span>Agent ID <code className="break-all">{hostId}</code></span>
      } actions={
        <Button variant="secondary" onClick={() => { void snapshot.refetch(); void diff.refetch(); }} disabled={snapshot.isFetching || diff.isFetching}>
          <RefreshCw aria-hidden="true" className="h-4 w-4" /> Refresh posture
        </Button>
      } />
      <SecurityError error={snapshot.error} label="Could not load the current snapshot" retry={() => void snapshot.refetch()} isRetrying={snapshot.isFetching} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard icon={<Clock3 className="h-5 w-5" />} label="Security telemetry"
          value={snapshot.data?.stale === undefined ? 'Unknown' : snapshot.data.stale ? 'Stale' : 'Current'}
          tone={snapshot.data?.stale ? 'warning' : 'neutral'}
          sub={snapshot.data?.lastReceivedAt && <>Last received <SecurityTime value={snapshot.data.lastReceivedAt} /></>} />
        <MetricCard icon={<FileDiff className="h-5 w-5" />} label="Baseline"
          value={currentDiff?.baselinePending ? 'Pending' : !changes ? 'Unknown' : readyCount || 'No reported changes'}
          tone={currentDiff?.baselinePending || readyCount ? 'warning' : 'neutral'}
          sub={currentDiff?.baselinePending ? 'First snapshot awaits approval' : readyCount ? `${readyCount === 1 ? 'Change' : 'Changes'} ready for review` : undefined} />
        <MetricCard icon={<FileCheck2 className="h-5 w-5" />} label="Inventory coverage"
          value={coverage.length ? `${coverage.length - gaps.length} of ${coverage.length}` : 'Unknown'}
          tone={gaps.length ? 'warning' : 'neutral'}
          sub={coverage.length > 0 && (gaps.length ? `${gaps.length} coverage ${gaps.length === 1 ? 'gap' : 'gaps'}` : 'Sections collected completely')} />
      </div>
      <MetricTabs tabs={tabs} activeTab={tab} onChange={changeTab} />
      {tab === 'changes' && (
        <div className="space-y-4">
          {gaps.length > 0 && <HostSecurityCoverageGaps gaps={gaps} />}
          <SecurityError error={diff.error} label="Could not load baseline changes" retry={() => void diff.refetch()} isRetrying={diff.isFetching} />
          {diff.isPending && <div className="card flex justify-center p-8"><Spinner label="Loading baseline changes" /></div>}
          {currentDiff && <HostSecurityChanges hostId={hostId} hostName={currentSnapshot?.name ?? hostId} diff={currentDiff}
            changes={changes} canSetBaseline={!!changes && coverage.some(section => section.status === 'ok')} completeCoverage={gaps.length === 0} />}
        </div>
      )}
      {tab === 'sign-ins' && <HostSecuritySignIns hostId={hostId} />}
      {tab === 'inventory' && (
        <>
          {snapshot.isPending && <div className="card flex justify-center p-8"><Spinner label="Loading host inventory" /></div>}
          {currentSnapshot && <HostSecurityInventory key={inventorySection ?? ''} snapshot={currentSnapshot} selectedSection={inventorySection} />}
        </>
      )}
    </div>
  );
}

function HostSecurityCoverageGaps({ gaps }: {
  gaps: { name: HostSecuritySectionName; status: HostSecurityStatus; complete: boolean }[];
}) {
  return (
    <section aria-labelledby="coverage-gaps-heading" className="card overflow-hidden">
      <h2 id="coverage-gaps-heading" className="border-b border-gray-200 px-4 py-3 font-semibold dark:border-robin-gray-700">Coverage gaps</h2>
      <ul className="divide-y divide-gray-200 dark:divide-robin-gray-700">
        {gaps.map(({ name, status, complete }) => (
          <li key={name} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className="font-medium">{hostSecuritySectionLabels[name]}</span>
                <CoverageBadge status={status} complete={complete} />
              </div>
              <p className="text-gray-600 dark:text-gray-300">
                {status === 'ok' ? 'Review covers reported items only.' : 'Approval is blocked until the agent can read this section.'}
              </p>
            </div>
            <Link className="text-robin-orange hover:underline" to={{ search: `?tab=inventory&section=${name}` }}
              aria-label={`View ${hostSecuritySectionLabels[name]} inventory`}>View inventory</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HostSecurityInventory({ snapshot, selectedSection }: { snapshot: HostSecuritySnapshot; selectedSection?: HostSecuritySectionName }) {
  return (
    <section aria-labelledby="host-inventory-heading" className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-3 dark:border-robin-gray-700">
        <h2 id="host-inventory-heading" className="font-semibold">Current snapshot</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">Observed <SecurityTime value={snapshot.observedAt} /></p>
      </div>
      <div className="divide-y divide-gray-200 dark:divide-robin-gray-700">
        {sectionNames.map(name => (
          <InventorySection key={name} name={name} section={snapshot.sections[name]} highlighted={selectedSection === name} />
        ))}
      </div>
    </section>
  );
}

function InventorySection({ name, section, highlighted }: {
  name: HostSecuritySectionName; section: HostSecuritySnapshot['sections'][HostSecuritySectionName]; highlighted: boolean;
}) {
  const [expanded, setExpanded] = useState(highlighted);
  const [limit, setLimit] = useState(100);
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!highlighted) return;
    details.current?.querySelector('summary')?.focus({ preventScroll: true });
    details.current?.scrollIntoView?.({ block: 'nearest' });
  }, [highlighted]);
  return (
    <details ref={details} open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer px-4 py-3 hover:bg-gray-50 dark:hover:bg-robin-gray-900/40">
        <span className="ml-2 inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium">{hostSecuritySectionLabels[name]}</span>
          <CoverageBadge status={section.status} complete={section.complete} />
          <span className="text-sm text-gray-500 dark:text-gray-400">{section.items.length} items</span>
        </span>
      </summary>
      {expanded && (
        <div className="space-y-3 px-4 pb-4">
          {section.items.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">{section.status === 'ok' && section.complete ? 'No items found.' : 'No items reported.'}</p>
          )}
          {section.items.slice(0, limit).map(item => (
            <div key={item.id} className="rounded-lg border border-gray-200 p-3 dark:border-robin-gray-700">
              <p className="break-all font-mono text-sm font-medium">{item.id}</p>
              <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                {Object.entries(item.value).map(([field, value]) => (
                  <div key={field} className="min-w-0">
                    <dt className="text-xs text-gray-500 dark:text-gray-400">{securityFieldLabel(field)}</dt>
                    <dd className="wrap-break-word">{securityFieldValue(value)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
          {section.items.length > limit && <Button variant="secondary" size="sm" onClick={() => setLimit(limit + 100)}>Show more items</Button>}
        </div>
      )}
    </details>
  );
}
