/**
 * Sending services across domains, classified separately from acknowledged forwarding.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ExternalLink,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  X,
} from 'lucide-react';
import { PageHeader } from '../components/ui/PageHeader';
import { Table, type Column } from '../components/ui/Table';
import { reportingApi } from '../api/client';
import { TimeframeControl } from '../components/reporting/TimeframeControl';
import { useTimeframe } from '../components/reporting/useTimeframe';
import {
  BucketBadge,
  ComplianceBar,
  formatCount,
  formatDate,
  formatRate,
  ReportingEmptyState,
  TimeframeBanner,
} from '../components/reporting/primitives';
import type {
  SourceAggregate,
  SourceBucket,
  SourceBucketCounts,
  SourceReviewState,
  SourceSort,
  TimeframeInfo,
} from '../types/reporting';
import {
  FAILURE_REASON_LABELS,
  SOURCE_BUCKET_HINTS,
  SOURCE_BUCKET_LABELS,
} from '../types/reporting';

const BUCKET_ORDER: (SourceBucket | 'all')[] = [
  'non_compliant',
  'threat_unknown',
  'forwarder',
  'capable',
  'all',
];

const IDENTITY_KIND_LABELS: Record<string, string> = {
  provider: 'Known provider',
  rdns_domain: 'Identified by reverse DNS',
  network: 'Unidentified — grouped by network block',
  address: 'Unidentified — single address',
};

const REVIEW_ACTIONS: { state: SourceReviewState; label: string }[] = [
  { state: 'authorized', label: 'Mark authorised' },
  { state: 'forwarder', label: 'Mark forwarder' },
  { state: 'threat', label: 'Mark threat' },
  { state: 'pending', label: 'Clear' },
];

const PAGE_SIZE = 50;

export default function SourcesPage() {
  const { query, from, to, setRange, clear } = useTimeframe();

  const [bucket, setBucket] = useState<SourceBucket | 'all'>('non_compliant');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [sort, setSort] = useState<SourceSort>('actionable');
  const [page, setPage] = useState(1);

  const [sources, setSources] = useState<SourceAggregate[]>([]);
  const [buckets, setBuckets] = useState<SourceBucketCounts | null>(null);
  const [timeframe, setTimeframe] = useState<TimeframeInfo | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<SourceAggregate | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await reportingApi.getSources({
        ...query,
        bucket,
        search: search || undefined,
        sort,
        direction: sort === 'name' ? 'asc' : 'desc',
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      setSources(res.data ?? []);
      setBuckets(res.meta?.buckets ?? null);
      setTimeframe(res.meta?.timeframe ?? null);
      setTotal(res.pagination?.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sources');
      setSources([]);
    } finally {
      setLoading(false);
    }
  }, [query, bucket, search, sort, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [bucket, search, sort, from, to]);

  const resolveNames = async () => {
    setResolving(true);
    try {
      await reportingApi.resolveSources();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve source names');
    } finally {
      setResolving(false);
    }
  };

  const applyReview = async (source: SourceAggregate, state: SourceReviewState) => {
    try {
      await reportingApi.reviewSource(source.key, state);
      setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update source');
    }
  };

  const columns = useMemo<Column<SourceAggregate>[]>(
    () => [
      {
        key: 'displayName',
        header: 'Service',
        render: (s) => (
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-medium">
              <span className="truncate">{s.displayName}</span>
              {s.fcrdnsVerified && (
                <ShieldCheck
                  className="h-3.5 w-3.5 shrink-0 text-green-500"
                  aria-label="Forward-confirmed reverse DNS"
                />
              )}
            </div>
            <div className="truncate text-xs text-gray-500 dark:text-gray-400">
              {IDENTITY_KIND_LABELS[s.identityKind] ?? s.identityKind}
              {s.ptr ? ` · ${s.ptr}` : ''}
            </div>
          </div>
        ),
      },
      {
        key: 'ipCount',
        header: 'IPs',
        render: (s) => (
          <div>
            <div>{formatCount(s.ipCount)}</div>
            {s.ipCount === 1 && (
              <div className="font-mono text-xs text-gray-500 dark:text-gray-400">{s.ips[0]}</div>
            )}
          </div>
        ),
      },
      {
        key: 'volume',
        header: 'Volume',
        render: (s) => formatCount(s.breakdown.totalVolume),
      },
      {
        key: 'compliance',
        header: 'DMARC',
        render: (s) => (
          <div>
            <div
              className={
                s.complianceRate >= 0.98
                  ? 'text-green-600 dark:text-green-400'
                  : s.complianceRate >= 0.9
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-red-600 dark:text-red-400'
              }
            >
              {formatRate(s.complianceRate)}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {formatCount(s.breakdown.compliantVolume)} of{' '}
              {formatCount(s.breakdown.totalVolume)}
            </div>
          </div>
        ),
      },
      { key: 'dkim', header: 'DKIM', render: (s) => formatRate(s.dkimRate, 1) },
      { key: 'spf', header: 'SPF', render: (s) => formatRate(s.spfRate, 1) },
      {
        key: 'actionable',
        header: 'Needs attention',
        render: (s) =>
          s.breakdown.actionableFailureVolume > 0 ? (
            <span className="font-medium text-red-600 dark:text-red-400">
              {formatCount(s.breakdown.actionableFailureVolume)}
            </span>
          ) : (
            <span className="text-gray-400">0</span>
          ),
      },
      { key: 'domains', header: 'Domains', render: (s) => formatCount(s.domainCount) },
      { key: 'bucket', header: 'Status', render: (s) => <BucketBadge bucket={s.bucket} /> },
    ],
    []
  );

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Server}
        title="Sources"
        description="Every service sending mail as your domains, grouped across the whole fleet. Work the non-compliant and unknown buckets; forwarders are benign by definition."
        actions={
          <button
            className="btn btn-secondary"
            onClick={resolveNames}
            disabled={resolving}
            title="Re-run reverse DNS and provider matching to put names to IP addresses"
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${resolving ? 'animate-spin' : ''}`} />
            Identify sources
          </button>
        }
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

      <div className="flex flex-wrap gap-2">
        {BUCKET_ORDER.map((b) => {
          const count = buckets ? buckets[b] : undefined;
          const active = bucket === b;
          return (
            <button
              key={b}
              onClick={() => setBucket(b)}
              title={b === 'all' ? 'Every source' : SOURCE_BUCKET_HINTS[b]}
              className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                active
                  ? 'border-robin-orange bg-robin-orange/10 text-robin-orange'
                  : 'border-gray-200 hover:border-gray-300 dark:border-robin-gray-700 dark:hover:border-robin-gray-600'
              }`}
            >
              <div className="font-medium">
                {b === 'all' ? 'All sources' : SOURCE_BUCKET_LABELS[b]}
              </div>
              <div className="text-xs opacity-70">
                {count === undefined ? '—' : formatCount(count)}
              </div>
            </button>
          );
        })}
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
              placeholder="Search by service name, PTR or IP…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </form>
          <label className="text-sm text-gray-500 dark:text-gray-400">
            Sort
            <select
              className="input ml-2 w-auto py-1.5 text-sm"
              value={sort}
              onChange={(e) => setSort(e.target.value as SourceSort)}
            >
              <option value="actionable">Needs attention</option>
              <option value="volume">Volume</option>
              <option value="compliance">Compliance (lowest first)</option>
              <option value="domains">Domains served</option>
              <option value="name">Name</option>
            </select>
          </label>
        </div>

        {!loading && sources.length === 0 && timeframe ? (
          <ReportingEmptyState
            timeframe={timeframe}
            noun={
              bucket === 'all'
                ? 'sources'
                : `${SOURCE_BUCKET_LABELS[bucket as SourceBucket].toLowerCase()} sources`
            }
            filtered={Boolean(search)}
          />
        ) : (
          <Table
            columns={columns}
            data={sources}
            keyField="key"
            isLoading={loading}
            onRowClick={setSelected}
            pagination={{
              page,
              total,
              totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
              onPageChange: setPage,
            }}
          />
        )}
      </div>

      {selected && (
        <SourceDetail
          source={selected}
          onClose={() => setSelected(null)}
          onReview={applyReview}
          timeframeQueryString={new URLSearchParams(
            Object.entries(query).filter(([, v]) => v) as [string, string][]
          ).toString()}
        />
      )}
    </div>
  );
}

function SourceDetail({
  source,
  onClose,
  onReview,
  timeframeQueryString,
}: {
  source: SourceAggregate;
  onClose: () => void;
  onReview: (source: SourceAggregate, state: SourceReviewState) => void;
  timeframeQueryString: string;
}) {
  const reasons = Object.entries(source.breakdown.byReason).filter(([, v]) => v > 0);
  const explorerParams = new URLSearchParams(timeframeQueryString);
  explorerParams.set('search', source.ips[0] ?? source.displayName);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose}>
      <aside
        className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-xl dark:bg-robin-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold">{source.displayName}</div>
            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {IDENTITY_KIND_LABELS[source.identityKind] ?? source.identityKind}
            </div>
            <div className="mt-2">
              <BucketBadge bucket={source.bucket} />
            </div>
          </div>
          <button className="btn btn-secondary p-2" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-6">
          <ComplianceBar breakdown={source.breakdown} />
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">DMARC compliance</dt>
            <dd className="font-medium">
              {formatRate(source.complianceRate)}{' '}
              <span className="text-xs font-normal text-gray-500">
                ({formatCount(source.breakdown.compliantVolume)} /{' '}
                {formatCount(source.breakdown.totalVolume)})
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">Needs attention</dt>
            <dd className="font-medium">
              {formatCount(source.breakdown.actionableFailureVolume)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">DKIM aligned</dt>
            <dd className="font-medium">{formatRate(source.dkimRate, 1)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">SPF aligned</dt>
            <dd className="font-medium">{formatRate(source.spfRate, 1)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">First seen</dt>
            <dd className="font-medium">{formatDate(source.firstSeen)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">Last seen</dt>
            <dd className="font-medium">{formatDate(source.lastSeen)}</dd>
          </div>
        </dl>

        {reasons.length > 0 && (
          <section className="mt-6">
            <h3 className="text-sm font-semibold">Why receivers said mail failed</h3>
            <ul className="mt-2 space-y-1 text-sm">
              {reasons.map(([reason, volume]) => (
                <li key={reason} className="flex justify-between gap-4">
                  <span className="text-gray-600 dark:text-gray-300">
                    {FAILURE_REASON_LABELS[reason as keyof typeof FAILURE_REASON_LABELS] ?? reason}
                  </span>
                  <span className="font-medium">{formatCount(volume)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {source.authDocsUrl && (
          <a
            href={source.authDocsUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-6 inline-flex items-center gap-2 text-sm text-robin-orange hover:underline"
          >
            <ExternalLink className="h-4 w-4" />
            How to authenticate mail from {source.provider ?? source.displayName}
          </a>
        )}

        <section className="mt-6">
          <h3 className="text-sm font-semibold">
            Domains it sends for ({formatCount(source.domainCount)})
          </h3>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {source.domains.slice(0, 40).map((d) => (
              <Link
                key={d}
                to={`/reporting/domains/${encodeURIComponent(d)}?${timeframeQueryString}`}
                className="rounded-sm bg-gray-100 px-2 py-0.5 text-xs hover:bg-gray-200 dark:bg-robin-gray-700 dark:hover:bg-robin-gray-600"
              >
                {d}
              </Link>
            ))}
            {source.domainCount > 40 && (
              <span className="px-2 py-0.5 text-xs text-gray-500">
                +{formatCount(source.domainCount - 40)} more
              </span>
            )}
          </div>
        </section>

        <section className="mt-6">
          <h3 className="text-sm font-semibold">
            IP addresses ({formatCount(source.ipCount)})
          </h3>
          <div className="mt-2 max-h-40 overflow-y-auto font-mono text-xs text-gray-600 dark:text-gray-300">
            {source.ips.slice(0, 100).map((ip) => (
              <div key={ip}>{ip}</div>
            ))}
            {source.ipCount > 100 && <div>+{formatCount(source.ipCount - 100)} more</div>}
          </div>
        </section>

        <section className="mt-6 border-t border-gray-200 pt-4 dark:border-robin-gray-700">
          <h3 className="text-sm font-semibold">Your decision</h3>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Applies to this service across every domain it sends for. Current:{' '}
            <span className="font-medium">{source.reviewState}</span>
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {REVIEW_ACTIONS.map((a) => (
              <button
                key={a.state}
                className="btn btn-secondary text-sm"
                disabled={source.reviewState === a.state}
                onClick={() => onReview(source, a.state)}
              >
                {a.label}
              </button>
            ))}
          </div>
        </section>

        <Link
          to={`/reporting/explorer?${explorerParams.toString()}`}
          className="mt-6 inline-flex items-center gap-2 text-sm text-robin-orange hover:underline"
        >
          Inspect the underlying records in Explorer
        </Link>
      </aside>
    </div>
  );
}
