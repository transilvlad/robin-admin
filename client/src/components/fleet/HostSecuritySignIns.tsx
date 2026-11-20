import { lazy, Suspense, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, hostSecurityApi } from '../../api/client';
import type { HostSecurityCounter, HostSecurityEvent } from '../../types/host-security';
import type { TelemetryRangeData } from '../../types/telemetry';
import { Spinner } from '../ui/Spinner';
import { Table, type Column } from '../ui/Table';
import { SecurityBadge, SecurityError, SecurityPagination, SecurityTime, useSecurityPagination } from './hostSecurityUi';

const TimeSeriesChart = lazy(() => import('../telemetry/TimeSeriesChart').then(module => ({ default: module.TimeSeriesChart })));

const failureTypes = [
  { key: 'invalidUser', label: 'Invalid user' },
  { key: 'failedKey', label: 'Failed key' },
  { key: 'failedPassword', label: 'Failed password' },
] as const;

function retryFeed(failures: number, error: Error) {
  return failures < 2 && (!(error instanceof ApiError) || error.status === 0 || error.status >= 500);
}

function authenticationChartData(counters: HostSecurityCounter[]): TelemetryRangeData {
  const observed = [...counters].reverse();
  const timestamps: number[] = [];
  const minutes: (HostSecurityCounter | null)[] = [];
  function add(time: number, counter: HostSecurityCounter | null) {
    timestamps.push(time);
    minutes.push(counter);
  }
  for (const counter of observed) {
    const time = Date.parse(counter.minute) / 1000;
    const previous = timestamps[timestamps.length - 1];
    if (previous !== undefined && time - previous > 60) add(previous + 60, null);
    add(time, counter);
  }
  if (timestamps.length === 1) {
    const only = timestamps[0];
    timestamps.unshift(only - 60);
    minutes.unshift(null);
    add(only + 60, null);
  }
  return {
    start: timestamps[0] ?? 0,
    end: timestamps[timestamps.length - 1] ?? 0,
    step: 60,
    timestamps,
    truncated: false,
    series: failureTypes.map(({ key, label }) => ({
      name: label, labels: {}, values: minutes.map(counter => counter?.[key] ?? null),
    })),
  };
}

const counterColumns: Column<HostSecurityCounter>[] = [
  { key: 'minute', header: 'Minute', render: counter => <SecurityTime value={counter.minute} /> },
  ...failureTypes.map(({ key, label }) => ({ key, header: label, className: 'tabular-nums', render: (counter: HostSecurityCounter) => counter[key] })),
  { key: 'successful', header: 'Accepted sign-ins', className: 'tabular-nums' },
  { key: 'distinctFailedSources', header: 'Distinct failed sources', className: 'tabular-nums' },
];

const eventColumns: Column<HostSecurityEvent>[] = [
  {
    key: 'type', header: 'Event',
    render: event => (
      <div className="space-y-1">
        <p className="font-medium capitalize">{event.type === 'login' ? 'Sign-in' : event.type.replace(/_/g, ' ')}</p>
        {event.type === 'login' && event.sourceIp && (
          <SecurityBadge tone={event.knownAddressId ? 'success' : 'warning'}>{event.knownAddressId ? 'Known address' : 'Unknown address'}</SecurityBadge>
        )}
      </div>
    ),
  },
  {
    key: 'actor', header: 'Account and source',
    render: event => (
      <div>
        <p>{event.user ?? '—'}</p>
        {event.sourceIp && <p className="font-mono text-xs text-gray-500 dark:text-gray-400">{event.sourceIp}</p>}
      </div>
    ),
  },
  { key: 'observedAt', header: 'Observed', className: 'whitespace-nowrap', render: event => <SecurityTime value={event.observedAt} /> },
  {
    key: 'line', header: 'Evidence',
    render: event => (
      <details className="min-w-32">
        <summary className="cursor-pointer font-medium text-robin-orange">View evidence</summary>
        <dl className="mt-2 space-y-2 text-xs">
          {event.authMethod && <div><dt className="font-medium">Authentication method</dt><dd>{event.authMethod}</dd></div>}
          {event.keyFingerprint && <div><dt className="font-medium">Key fingerprint</dt><dd className="wrap-anywhere font-mono">{event.keyFingerprint}</dd></div>}
          <div><dt className="font-medium">Masked log line</dt><dd className="wrap-anywhere font-mono">{event.line}</dd></div>
        </dl>
      </details>
    ),
  },
];

export function HostSecuritySignIns({ hostId }: { hostId: string }) {
  const [signInsOnly, setSignInsOnly] = useState(false);
  const pagination = useSecurityPagination();
  const events = useQuery({
    queryKey: ['host-security', 'host', hostId, 'events', signInsOnly, pagination.cursor],
    queryFn: async () => (await hostSecurityApi.events(hostId, { signInsOnly, cursor: pagination.cursor })).data,
    retry: retryFeed,
  });
  const counters = useQuery({
    queryKey: ['host-security', 'host', hostId, 'counters'],
    queryFn: async () => (await hostSecurityApi.counters(hostId)).data,
    retry: retryFeed,
  });
  const chart = useMemo(() => counters.data?.items.length ? authenticationChartData(counters.data.items) : null, [counters.data]);

  return (
    <div className="space-y-4">
      <section aria-labelledby="authentication-heading" className="card space-y-4 p-4">
        <div>
          <h2 id="authentication-heading" className="font-semibold">Failed authentication</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Latest 60 reported minutes. Gaps indicate missing samples.</p>
        </div>
        <SecurityError error={counters.error} label="Could not load authentication counts" retry={() => void counters.refetch()} isRetrying={counters.isFetching} />
        {counters.isPending && <div className="flex justify-center py-6"><Spinner label="Loading authentication counts" /></div>}
        {counters.data?.items.length === 0 && <p className="py-5 text-center text-sm text-gray-500 dark:text-gray-400">No authentication counters reported.</p>}
        {chart && counters.data && <>
          <Suspense fallback={<div className="flex h-52 items-center justify-center"><Spinner label="Loading authentication chart" /></div>}>
            <TimeSeriesChart data={chart} unit="count" min={0} height={220} decimals={0} legendMode="max" />
          </Suspense>
          <details className="rounded-lg border border-gray-200 dark:border-robin-gray-700">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">View minute counts</summary>
            <Table columns={counterColumns} data={counters.data.items} keyField="minute" scrollLabel="Authentication counts by minute" />
          </details>
        </>}
      </section>
      <section aria-labelledby="security-events-heading" className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-robin-gray-700">
          <h2 id="security-events-heading" className="font-semibold">Recent security events</h2>
          <select aria-label="Event type" className="input w-auto" value={signInsOnly ? 'login' : 'all'} onChange={event => {
            setSignInsOnly(event.target.value === 'login');
            pagination.reset();
          }}>
            <option value="all">All events</option>
            <option value="login">Sign-ins only</option>
          </select>
        </div>
        {events.error && <div className="p-4"><SecurityError error={events.error} label="Could not load security events" retry={() => void events.refetch()} isRetrying={events.isFetching} /></div>}
        {(events.isPending || events.data) && (
          <Table columns={eventColumns} data={events.data?.items ?? []} keyField="id" scrollLabel="Recent security events"
            isLoading={events.isPending} emptyMessage={signInsOnly ? 'No sign-ins reported.' : 'No recent events.'} />
        )}
        <SecurityPagination pagination={pagination} nextCursor={events.data?.nextCursor} busy={events.isFetching} />
      </section>
    </div>
  );
}
