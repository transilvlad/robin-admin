/**
 * Domains compared with the selected reporting window's aggregate baseline.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Globe, Search } from 'lucide-react';
import { MetricCard } from '../components/ui/MetricCard';
import { PageHeader } from '../components/ui/PageHeader';
import { Table, type Column } from '../components/ui/Table';
import { reportingApi } from '../api/client';
import { TimeframeControl } from '../components/reporting/TimeframeControl';
import { useTimeframe } from '../components/reporting/useTimeframe';
import {
  formatCount,
  formatDate,
  formatRate,
  ReportingEmptyState,
  TimeframeBanner,
} from '../components/reporting/primitives';
import type { DomainAggregate, DomainSort, TimeframeInfo } from '../types/reporting';

const PAGE_SIZE = 50;

/** How far below the fleet baseline a domain must sit before it is flagged. */
const DEVIATION_THRESHOLD = 0.02;

export default function DomainsPage() {
  const navigate = useNavigate();
  const { query, from, to, setRange, clear } = useTimeframe();

  const [domains, setDomains] = useState<DomainAggregate[]>([]);
  const [timeframe, setTimeframe] = useState<TimeframeInfo | null>(null);
  const [fleetRate, setFleetRate] = useState<number | null>(null);
  const [fleetVolume, setFleetVolume] = useState(0);
  const [fleetActionable, setFleetActionable] = useState(0);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<DomainSort>('actionable');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [onlyDeviating, setOnlyDeviating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // Fleet baseline is served in the same response's meta (see routes/reporting.ts),
      // so this no longer fires a full Overview aggregate on every sort/search/page.
      const res = await reportingApi.getDomains({
        ...query,
        search: search || undefined,
        sort,
        direction: sort === 'domain' ? 'asc' : 'desc',
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      setDomains(res.data ?? []);
      setTimeframe(res.meta?.timeframe ?? null);
      setTotal(res.pagination?.total ?? 0);
      setFleetRate(res.meta?.fleet?.complianceRate ?? null);
      setFleetVolume(res.meta?.fleet?.totalVolume ?? 0);
      setFleetActionable(res.meta?.fleet?.actionableFailureVolume ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load domains');
      setDomains([]);
    } finally {
      setLoading(false);
    }
  }, [query, search, sort, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [search, sort, from, to]);

  const deviates = useCallback(
    (d: DomainAggregate) =>
      fleetRate !== null &&
      d.breakdown.totalVolume > 0 &&
      d.complianceRate < fleetRate - DEVIATION_THRESHOLD,
    [fleetRate]
  );

  const visible = useMemo(
    () => (onlyDeviating ? domains.filter(deviates) : domains),
    [domains, onlyDeviating, deviates]
  );

  const columns = useMemo<Column<DomainAggregate>[]>(
    () => [
      {
        key: 'domain',
        header: 'Domain',
        render: (d) => (
          <div>
            <div className="font-medium">{d.domain}</div>
            {deviates(d) && (
              <div className="text-xs text-amber-600 dark:text-amber-400">
                {((fleetRate! - d.complianceRate) * 100).toFixed(2)} pts below the fleet
              </div>
            )}
          </div>
        ),
      },
      { key: 'volume', header: 'Volume', render: (d) => formatCount(d.breakdown.totalVolume) },
      {
        key: 'compliance',
        header: 'DMARC compliance',
        render: (d) => (
          <div>
            <div
              className={
                fleetRate !== null && d.complianceRate < fleetRate - DEVIATION_THRESHOLD
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-green-600 dark:text-green-400'
              }
            >
              {formatRate(d.complianceRate)}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {formatCount(d.breakdown.compliantVolume)} of{' '}
              {formatCount(d.breakdown.totalVolume)}
            </div>
          </div>
        ),
      },
      {
        key: 'actionable',
        header: 'Needs attention',
        render: (d) =>
          d.breakdown.actionableFailureVolume > 0 ? (
            <span className="font-medium text-red-600 dark:text-red-400">
              {formatCount(d.breakdown.actionableFailureVolume)}
            </span>
          ) : (
            <span className="text-gray-400">0</span>
          ),
      },
      {
        key: 'forwarded',
        header: 'Forwarded',
        render: (d) => (
          <span className="text-gray-500 dark:text-gray-400">
            {formatCount(d.breakdown.benignRelayVolume)}
          </span>
        ),
      },
      {
        key: 'policy',
        header: 'Policy',
        render: (d) => (
          <span className="rounded-sm bg-gray-100 px-2 py-0.5 text-xs dark:bg-robin-gray-700">
            p={d.policy ?? '—'}
          </span>
        ),
      },
      { key: 'sources', header: 'Sending IPs', render: (d) => formatCount(d.sourceCount) },
      { key: 'last', header: 'Last report', render: (d) => formatDate(d.lastReportAt) },
    ],
    [deviates, fleetRate]
  );

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Globe}
        title="Domains"
        description="Fleet conformance. Domains are measured against the fleet's own baseline, so the outliers surface instead of every domain being graded against an arbitrary target."
      />

      <TimeframeControl
        timeframe={timeframe}
        from={from}
        to={to}
        onChange={setRange}
        onClear={clear}
      />

      {timeframe && <TimeframeBanner timeframe={timeframe} />}

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard
          label="Fleet baseline compliance"
          value={formatRate(fleetRate)}
          tone={fleetRate !== null && fleetRate >= 0.98 ? 'success' : 'warning'}
          toneValue
          sub={`across ${formatCount(total)} domains and ${formatCount(fleetVolume)} messages`}
        />
        <MetricCard
          label="Domains below baseline"
          value={formatCount(domains.filter(deviates).length)}
          tone={domains.some(deviates) ? 'warning' : 'success'}
          toneValue
          sub={`more than ${(DEVIATION_THRESHOLD * 100).toFixed(0)} pts under the fleet rate (this page)`}
        />
        <MetricCard
          label="Unexplained failures"
          value={formatCount(fleetActionable)}
          tone={fleetActionable > 0 ? 'danger' : 'success'}
          toneValue
          sub="fleet-wide, excluding receiver-declared forwarding"
        />
      </div>

      <div className="card space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <form
            className="relative flex-1 min-w-[220px]"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(searchInput.trim());
            }}
          >
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              className="input pl-9"
              placeholder="Search domains…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </form>
          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            <input
              type="checkbox"
              checked={onlyDeviating}
              onChange={(e) => setOnlyDeviating(e.target.checked)}
              className="h-4 w-4 accent-robin-orange"
            />
            Only below baseline
          </label>
          <label className="text-sm text-gray-500 dark:text-gray-400">
            Sort
            <select
              className="input ml-2 w-auto py-1.5 text-sm"
              value={sort}
              onChange={(e) => setSort(e.target.value as DomainSort)}
            >
              <option value="actionable">Needs attention</option>
              <option value="compliance">Compliance (lowest first)</option>
              <option value="volume">Volume</option>
              <option value="domain">Name</option>
            </select>
          </label>
        </div>

        {!loading && visible.length === 0 && timeframe ? (
          <ReportingEmptyState
            timeframe={timeframe}
            noun="domains"
            filtered={Boolean(search) || onlyDeviating}
          />
        ) : (
          <Table
            columns={columns}
            data={visible}
            keyField="domain"
            isLoading={loading}
            onRowClick={(d) =>
              navigate(
                `/reporting/domains/${encodeURIComponent(d.domain)}?${new URLSearchParams(
                  Object.entries(query).filter(([, v]) => v) as [string, string][]
                ).toString()}`
              )
            }
            pagination={{
              page,
              total,
              totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
              onPageChange: setPage,
            }}
          />
        )}
      </div>
    </div>
  );
}
