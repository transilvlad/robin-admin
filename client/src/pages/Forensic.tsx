/**
 * Forensic (AFRF) raw reports workspace.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Filter,
  Mail,
  RefreshCw,
  Search,
  ShieldAlert,
  Siren,
} from 'lucide-react';
import { forensicApi } from '../api/client';
import { ActiveFilterChip } from '../components/ui/ActiveFilterChip';
import { Button } from '../components/ui/Button';
import { MetricCard } from '../components/ui/MetricCard';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { Table } from '../components/ui/Table';
import { appIcons } from '../constants/appIcons';
import type { ForensicReport, ForensicStats } from '../types';
import type { ForensicSortKey, SortDirection } from '../types/raw-reporting';
import { loadStoredBoolean, parseEnumParam, parseIntParam, saveStoredBoolean } from '../utils/pageState';

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const SORT_OPTIONS: { value: ForensicSortKey; label: string }[] = [
  { value: 'date', label: 'Newest evidence' },
  { value: 'incidents', label: 'Most incidents' },
  { value: 'type', label: 'Feedback type' },
  { value: 'domain', label: 'Reported domain' },
  { value: 'sourceIp', label: 'Source IP' },
];
const FILTERS_STORAGE_KEY = 'forensic-raw-filters-open';

export function ForensicPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const defaultStartDate = useMemo(() => getDefaultStartDate(), []);
  const defaultEndDate = useMemo(() => getToday(), []);

  const [reports, setReports] = useState<ForensicReport[]>([]);
  const [stats, setStats] = useState<ForensicStats | null>(null);
  const [feedbackTypes, setFeedbackTypes] = useState<string[]>([]);
  const [authFailureTypes, setAuthFailureTypes] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(() => parseIntParam(searchParams.get('page'), 1));
  const [pageSize, setPageSize] = useState(() => parseIntParam(searchParams.get('pageSize'), 50));
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [domain, setDomain] = useState(searchParams.get('domain') ?? '');
  const [feedbackType, setFeedbackType] = useState(searchParams.get('feedbackType') ?? '');
  const [authFailure, setAuthFailure] = useState(searchParams.get('authFailure') ?? '');
  const [sourceIp, setSourceIp] = useState(searchParams.get('sourceIp') ?? '');
  const [startDate, setStartDate] = useState(searchParams.get('startDate') ?? defaultStartDate);
  const [endDate, setEndDate] = useState(searchParams.get('endDate') ?? defaultEndDate);
  const [sortBy, setSortBy] = useState<ForensicSortKey>(
    () => parseEnumParam(searchParams.get('sortBy'), SORT_OPTIONS.map((option) => option.value), 'date'),
  );
  const [sortOrder, setSortOrder] = useState<SortDirection>(
    () => parseEnumParam(searchParams.get('sortOrder'), ['asc', 'desc'], 'desc'),
  );
  const [selectedReport, setSelectedReport] = useState<ForensicReport | null>(null);
  const [showFilters, setShowFilters] = useState(() => loadStoredBoolean(FILTERS_STORAGE_KEY, false));

  useEffect(() => {
    saveStoredBoolean(FILTERS_STORAGE_KEY, showFilters);
  }, [showFilters]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (domain) next.set('domain', domain);
    if (feedbackType) next.set('feedbackType', feedbackType);
    if (authFailure) next.set('authFailure', authFailure);
    if (sourceIp) next.set('sourceIp', sourceIp);
    if (startDate !== defaultStartDate) next.set('startDate', startDate);
    if (endDate !== defaultEndDate) next.set('endDate', endDate);
    if (page !== 1) next.set('page', String(page));
    if (pageSize !== 50) next.set('pageSize', String(pageSize));
    if (sortBy !== 'date') next.set('sortBy', sortBy);
    if (sortOrder !== 'desc') next.set('sortOrder', sortOrder);

    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [
    authFailure,
    defaultEndDate,
    defaultStartDate,
    domain,
    endDate,
    feedbackType,
    page,
    pageSize,
    searchParams,
    setSearchParams,
    sortBy,
    sortOrder,
    sourceIp,
    startDate,
  ]);

  const fetchReports = useCallback(async (showRefreshing = false) => {
    if (showRefreshing) setIsRefreshing(true);
    setIsLoading(true);
    try {
      const response = await forensicApi.listReports(page, pageSize, {
        domain: domain || undefined,
        feedbackType: feedbackType || undefined,
        authFailure: authFailure || undefined,
        sourceIp: sourceIp || undefined,
        startDate,
        endDate,
        sortBy,
        sortOrder,
      });
      setReports(response.data ?? []);
      setTotalPages(response.pagination?.totalPages ?? 1);
      setTotal(response.pagination?.total ?? 0);
      setError('');
    } catch {
      setError('Failed to load forensic reports');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [authFailure, domain, endDate, feedbackType, page, pageSize, sortBy, sortOrder, sourceIp, startDate]);

  const fetchReferenceData = useCallback(async () => {
    try {
      const [statsResponse, feedbackTypesResponse, authFailureTypesResponse] = await Promise.all([
        forensicApi.getStats(),
        forensicApi.getFeedbackTypes(),
        forensicApi.getAuthFailureTypes(),
      ]);
      setStats(statsResponse.data ?? null);
      setFeedbackTypes(feedbackTypesResponse.data ?? []);
      setAuthFailureTypes(authFailureTypesResponse.data ?? []);
    } catch {
      setError((current) => current || 'Failed to load forensic workspace data');
    }
  }, []);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  useEffect(() => {
    fetchReferenceData();
  }, [fetchReferenceData]);

  const refreshAll = () => {
    fetchReports(true);
    fetchReferenceData();
  };

  const clearFilters = () => {
    setDomain('');
    setFeedbackType('');
    setAuthFailure('');
    setSourceIp('');
    setStartDate(defaultStartDate);
    setEndDate(defaultEndDate);
    setPage(1);
  };

  const openDetail = async (report: ForensicReport) => {
    try {
      const response = await forensicApi.getReport(report.id);
      if (response.data) {
        setSelectedReport(response.data);
      }
    } catch {
      setError('Failed to load forensic report details');
    }
  };

  // Deep link from issue evidence: /forensic?reportId=123.
  const deepLinkReportId = searchParams.get('reportId');
  useEffect(() => {
    if (!deepLinkReportId) return;
    const id = Number.parseInt(deepLinkReportId, 10);
    if (!Number.isFinite(id)) return;

    let cancelled = false;
    forensicApi.getReport(id)
      .then((response) => {
        if (!cancelled && response.data) setSelectedReport(response.data);
      })
      .catch(() => setError('Failed to load the linked forensic report'));
    return () => { cancelled = true; };
  }, [deepLinkReportId]);

  const activeFilterCount = [
    domain,
    feedbackType,
    authFailure,
    sourceIp,
    startDate !== defaultStartDate,
    endDate !== defaultEndDate,
  ].filter(Boolean).length;

  const columns = [
    {
      key: 'received_date',
      header: 'Date',
      render: (report: ForensicReport) => formatDateTime(report.received_date || report.created_at),
    },
    {
      key: 'feedback_type',
      header: 'Feedback',
      render: (report: ForensicReport) => <TypePill value={report.feedback_type} />,
    },
    {
      key: 'reported_domain',
      header: 'Domain',
      render: (report: ForensicReport) => report.reported_domain || '-',
    },
    {
      key: 'auth_failure',
      header: 'Auth failure',
      render: (report: ForensicReport) => report.auth_failure || '-',
    },
    {
      key: 'source_ip',
      header: 'Source IP',
      className: 'font-mono',
      render: (report: ForensicReport) => report.source_ip || '-',
    },
    {
      key: 'subject',
      header: 'Subject',
      className: 'max-w-[260px] truncate',
      render: (report: ForensicReport) => report.subject || '-',
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.forensicRaw}
        title="Forensic reports"
        description="Inspect auth-failure evidence, pivot by source IP or failure mode, and keep the raw headers close to the analyst workflow."
        actions={
          <>
            <Button variant="secondary" onClick={() => setShowFilters((open) => !open)}>
              <Filter className="h-4 w-4" />
              {showFilters ? 'Hide filters' : 'Show filters'}
            </Button>
            <Button variant="secondary" onClick={refreshAll} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={<Mail className="h-5 w-5" />}
          label="Reports imported"
          value={(stats?.totalReports ?? 0).toLocaleString()}
          sub={`${stats?.last24Hours ?? 0} received in the last 24 hours`}
          tone="info"
        />
        <MetricCard
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Auth-failure modes"
          value={(stats?.byAuthFailure.length ?? 0).toLocaleString()}
          sub={authFailure ? `Focused on ${authFailure}` : 'Distinct failure categories observed'}
          tone="danger"
        />
        <MetricCard
          icon={<Siren className="h-5 w-5" />}
          label="Top reported domain"
          value={stats?.topDomains?.[0]?.domain || '-'}
          sub={stats?.topDomains?.[0] ? `${stats.topDomains[0].count.toLocaleString()} reports` : 'No domain evidence yet'}
          tone="warning"
        />
        <MetricCard
          icon={<ShieldAlert className="h-5 w-5" />}
          label="Top source IP"
          value={<span className="font-mono text-base md:text-lg">{stats?.topSourceIps?.[0]?.ip || '-'}</span>}
          sub={stats?.topSourceIps?.[0] ? `${stats.topSourceIps[0].count.toLocaleString()} reports` : 'No source IP evidence yet'}
          tone="success"
        />
      </div>

      {stats && (stats.byFeedbackType.length > 0 || stats.byAuthFailure.length > 0) && (
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="card p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Feedback types</h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  Quick pivots across the AFRF categories present in the imported set.
                </p>
              </div>
              {feedbackType && (
                <button
                  onClick={() => {
                    setFeedbackType('');
                    setPage(1);
                  }}
                  className="text-sm font-medium text-robin-orange hover:underline"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {stats.byFeedbackType.map((entry) => (
                <QuickFilterButton
                  key={entry.type}
                  active={feedbackType === entry.type}
                  onClick={() => {
                    setFeedbackType(entry.type);
                    setPage(1);
                  }}
                >
                  {entry.type} ({entry.count})
                </QuickFilterButton>
              ))}
            </div>
          </div>

          <div className="card p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Authentication failures</h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  Surface the most common failure reasons without leaving the evidence list.
                </p>
              </div>
              {authFailure && (
                <button
                  onClick={() => {
                    setAuthFailure('');
                    setPage(1);
                  }}
                  className="text-sm font-medium text-robin-orange hover:underline"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {stats.byAuthFailure.map((entry) => (
                <QuickFilterButton
                  key={entry.type}
                  active={authFailure === entry.type}
                  onClick={() => {
                    setAuthFailure(entry.type);
                    setPage(1);
                  }}
                >
                  {entry.type} ({entry.count})
                </QuickFilterButton>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="card p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Evidence list</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {total.toLocaleString()} reports match the current filters.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <label className="text-sm text-gray-500 dark:text-gray-400">
              Sort
              <select
                value={sortBy}
                onChange={(event) => {
                  setSortBy(event.target.value as ForensicSortKey);
                  setPage(1);
                }}
                className="input mt-1 min-w-[170px]"
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-sm text-gray-500 dark:text-gray-400">
              Direction
              <select
                value={sortOrder}
                onChange={(event) => {
                  setSortOrder(event.target.value as SortDirection);
                  setPage(1);
                }}
                className="input mt-1 min-w-[120px]"
              >
                <option value="desc">Descending</option>
                <option value="asc">Ascending</option>
              </select>
            </label>

            <label className="text-sm text-gray-500 dark:text-gray-400">
              Items per page
              <select
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
                className="input mt-1 min-w-[120px]"
              >
                {PAGE_SIZE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {activeFilterCount > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {domain && <ActiveFilterChip label={`Domain: ${domain}`} onClear={() => { setDomain(''); setPage(1); }} />}
            {feedbackType && (
              <ActiveFilterChip label={`Feedback: ${feedbackType}`} onClear={() => { setFeedbackType(''); setPage(1); }} />
            )}
            {authFailure && (
              <ActiveFilterChip label={`Failure: ${authFailure}`} onClear={() => { setAuthFailure(''); setPage(1); }} />
            )}
            {sourceIp && <ActiveFilterChip label={`IP: ${sourceIp}`} onClear={() => { setSourceIp(''); setPage(1); }} />}
            {startDate !== defaultStartDate && (
              <ActiveFilterChip label={`From: ${startDate}`} onClear={() => { setStartDate(defaultStartDate); setPage(1); }} />
            )}
            {endDate !== defaultEndDate && (
              <ActiveFilterChip label={`To: ${endDate}`} onClear={() => { setEndDate(defaultEndDate); setPage(1); }} />
            )}
            <button onClick={clearFilters} className="text-sm font-medium text-robin-orange hover:underline">
              Clear all
            </button>
          </div>
        )}

        {showFilters && (
          <div className="mt-4 grid gap-4 border-t border-gray-100 pt-4 dark:border-robin-gray-800 md:grid-cols-2 xl:grid-cols-4">
            <FilterField label="Domain">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  value={domain}
                  onChange={(event) => {
                    setDomain(event.target.value);
                    setPage(1);
                  }}
                  placeholder="Filter by domain"
                  className="input w-full pl-10"
                />
              </div>
            </FilterField>

            <FilterField label="Source IP">
              <input
                type="text"
                value={sourceIp}
                onChange={(event) => {
                  setSourceIp(event.target.value);
                  setPage(1);
                }}
                placeholder="Filter by source IP"
                className="input w-full"
              />
            </FilterField>

            <FilterField label="Feedback type">
              <select
                value={feedbackType}
                onChange={(event) => {
                  setFeedbackType(event.target.value);
                  setPage(1);
                }}
                className="input w-full"
              >
                <option value="">All types</option>
                {feedbackTypes.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </FilterField>

            <FilterField label="Auth failure">
              <select
                value={authFailure}
                onChange={(event) => {
                  setAuthFailure(event.target.value);
                  setPage(1);
                }}
                className="input w-full"
              >
                <option value="">All failures</option>
                {authFailureTypes.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </FilterField>

            <FilterField label="Start date">
              <input
                type="date"
                value={startDate}
                onChange={(event) => {
                  setStartDate(event.target.value);
                  setPage(1);
                }}
                className="input w-full"
              />
            </FilterField>

            <FilterField label="End date">
              <input
                type="date"
                value={endDate}
                onChange={(event) => {
                  setEndDate(event.target.value);
                  setPage(1);
                }}
                className="input w-full"
              />
            </FilterField>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-sm border border-red-200 bg-red-50 p-3 text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="card p-4">
        <Table
          columns={columns}
          data={reports}
          keyField="id"
          isLoading={isLoading}
          emptyMessage="No forensic reports found for the current filters"
          onRowClick={openDetail}
          pagination={{
            page,
            totalPages,
            total,
            onPageChange: setPage,
          }}
        />
      </div>

      <Modal
        isOpen={!!selectedReport}
        onClose={() => setSelectedReport(null)}
        title="Forensic report details"
        size="xl"
      >
        {selectedReport && (
          <div className="space-y-5">
            <div className="grid gap-4 text-sm md:grid-cols-3">
              <DetailStat label="Feedback type" value={selectedReport.feedback_type} />
              <DetailStat label="Auth failure" value={selectedReport.auth_failure || '-'} />
              <DetailStat label="Received" value={formatDateTime(selectedReport.received_date)} />
              <DetailStat label="Reported domain" value={selectedReport.reported_domain || '-'} />
              <DetailStat label="Source IP" value={selectedReport.source_ip || '-'} mono />
              <DetailStat label="Incidents" value={selectedReport.incidents.toLocaleString()} />
            </div>

            <section className="rounded-lg border border-gray-200 p-4 dark:border-robin-gray-700">
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4" />
                <h3 className="font-semibold">Original message context</h3>
              </div>
              <div className="mt-4 grid gap-4 text-sm md:grid-cols-2">
                <DetailStat label="Mail from" value={selectedReport.original_mail_from || '-'} mono />
                <DetailStat label="Recipient" value={selectedReport.original_rcpt_to || '-'} mono />
                <div className="md:col-span-2">
                  <DetailStat label="Subject" value={selectedReport.subject || '-'} />
                </div>
              </div>
            </section>

            <section className="rounded-lg border border-gray-200 p-4 dark:border-robin-gray-700">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                <h3 className="font-semibold">Authentication evidence</h3>
              </div>
              <div className="mt-4 grid gap-4 text-sm md:grid-cols-2">
                {selectedReport.dkim_domain && <DetailStat label="DKIM domain" value={selectedReport.dkim_domain} />}
                {selectedReport.dkim_selector && <DetailStat label="DKIM selector" value={selectedReport.dkim_selector} />}
                {selectedReport.spf_dns && (
                  <div className="md:col-span-2">
                    <DetailStat label="SPF DNS" value={selectedReport.spf_dns} mono />
                  </div>
                )}
              </div>
              {selectedReport.authentication_results && (
                <div className="mt-4">
                  <div className="text-xs font-medium text-gray-500 dark:text-gray-400">
                    Authentication-Results
                  </div>
                  <pre className="mt-2 overflow-x-auto rounded-lg bg-gray-100 p-3 text-xs dark:bg-robin-gray-800">
                    {selectedReport.authentication_results}
                  </pre>
                </div>
              )}
            </section>

            {selectedReport.original_headers && (
              <section className="rounded-lg border border-gray-200 p-4 dark:border-robin-gray-700">
                <div className="text-sm font-semibold">Original headers</div>
                <pre className="mt-3 max-h-72 overflow-auto rounded-lg bg-gray-100 p-3 text-xs dark:bg-robin-gray-800">
                  {selectedReport.original_headers}
                </pre>
              </section>
            )}

            {selectedReport.user_agent && (
              <div className="text-xs text-gray-500 dark:text-gray-400">Reported by: {selectedReport.user_agent}</div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}


function QuickFilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
        active
          ? 'border-robin-orange bg-robin-orange text-white'
          : 'border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-robin-gray-600 dark:text-gray-200 dark:hover:bg-robin-gray-800'
      }`}
    >
      {children}
    </button>
  );
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function DetailStat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-robin-gray-800">
      <div className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`mt-1 font-medium text-gray-900 dark:text-white ${mono ? 'font-mono text-xs' : ''}`}>{value}</div>
    </div>
  );
}

function TypePill({ value }: { value: string }) {
  const tone =
    value === 'abuse'
      ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
      : value === 'auth-failure'
        ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400'
        : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';

  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{value}</span>;
}

function formatDateTime(dateStr: string | null | undefined) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString();
}

function getDefaultStartDate(): string {
  const date = new Date();
  date.setDate(date.getDate() - 30);
  return date.toISOString().split('T')[0];
}

function getToday(): string {
  return new Date().toISOString().split('T')[0];
}
