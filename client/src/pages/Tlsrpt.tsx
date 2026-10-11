/**
 * TLS-RPT raw reports workspace.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  Filter,
  Lock,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { tlsrptApi } from '../api/client';
import { ActiveFilterChip } from '../components/ui/ActiveFilterChip';
import { Button } from '../components/ui/Button';
import { MetricCard } from '../components/ui/MetricCard';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { Table } from '../components/ui/Table';
import { appIcons } from '../constants/appIcons';
import type { TlsrptChartData, TlsrptDomain, TlsrptReport, TlsrptReportDetail, TlsrptStats } from '../types';
import type { SortDirection, TlsrptSortKey } from '../types/raw-reporting';
import { loadStoredBoolean, parseEnumParam, parseIntParam, saveStoredBoolean } from '../utils/pageState';

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const SORT_OPTIONS: { value: TlsrptSortKey; label: string }[] = [
  { value: 'date', label: 'Newest report' },
  { value: 'failure', label: 'Most failed sessions' },
  { value: 'success', label: 'Most successful sessions' },
  { value: 'organization', label: 'Organization' },
  { value: 'report', label: 'Report ID' },
];
const FILTERS_STORAGE_KEY = 'tlsrpt-raw-filters-open';

export function TlsrptPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const defaultStartDate = useMemo(() => getDefaultStartDate(), []);
  const defaultEndDate = useMemo(() => getToday(), []);

  const [reports, setReports] = useState<TlsrptReport[]>([]);
  const [chartData, setChartData] = useState<TlsrptChartData[]>([]);
  const [domains, setDomains] = useState<TlsrptDomain[]>([]);
  const [stats, setStats] = useState<TlsrptStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(() => parseIntParam(searchParams.get('page'), 1));
  const [pageSize, setPageSize] = useState(() => parseIntParam(searchParams.get('pageSize'), 50));
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [domain, setDomain] = useState(searchParams.get('domain') ?? '');
  const [organization, setOrganization] = useState(searchParams.get('organization') ?? '');
  const [startDate, setStartDate] = useState(searchParams.get('startDate') ?? defaultStartDate);
  const [endDate, setEndDate] = useState(searchParams.get('endDate') ?? defaultEndDate);
  const [sortBy, setSortBy] = useState<TlsrptSortKey>(
    () => parseEnumParam(searchParams.get('sortBy'), SORT_OPTIONS.map((option) => option.value), 'date'),
  );
  const [sortOrder, setSortOrder] = useState<SortDirection>(
    () => parseEnumParam(searchParams.get('sortOrder'), ['asc', 'desc'], 'desc'),
  );
  const [selectedReport, setSelectedReport] = useState<TlsrptReportDetail | null>(null);
  const [showFilters, setShowFilters] = useState(() => loadStoredBoolean(FILTERS_STORAGE_KEY, false));

  useEffect(() => {
    saveStoredBoolean(FILTERS_STORAGE_KEY, showFilters);
  }, [showFilters]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (domain) next.set('domain', domain);
    if (organization) next.set('organization', organization);
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
    defaultEndDate,
    defaultStartDate,
    domain,
    endDate,
    organization,
    page,
    pageSize,
    searchParams,
    setSearchParams,
    sortBy,
    sortOrder,
    startDate,
  ]);

  const fetchReports = useCallback(async (showRefreshing = false) => {
    if (showRefreshing) setIsRefreshing(true);
    setIsLoading(true);
    try {
      const response = await tlsrptApi.listReports(page, pageSize, {
        domain: domain || undefined,
        organization: organization || undefined,
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
      setError('Failed to load TLS-RPT reports');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [domain, endDate, organization, page, pageSize, sortBy, sortOrder, startDate]);

  const fetchReferenceData = useCallback(async () => {
    try {
      const [chartResponse, domainsResponse, statsResponse] = await Promise.all([
        tlsrptApi.getChartData(startDate, endDate, domain || undefined),
        tlsrptApi.getDomains(),
        tlsrptApi.getStats(),
      ]);
      setChartData(chartResponse.data ?? []);
      setDomains(domainsResponse.data ?? []);
      setStats(statsResponse.data ?? null);
    } catch {
      setError((current) => current || 'Failed to load TLS-RPT workspace data');
    }
  }, [domain, endDate, startDate]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  useEffect(() => {
    fetchReferenceData();
  }, [fetchReferenceData]);

  const clearFilters = () => {
    setDomain('');
    setOrganization('');
    setStartDate(defaultStartDate);
    setEndDate(defaultEndDate);
    setPage(1);
  };

  const refreshAll = () => {
    fetchReports(true);
    fetchReferenceData();
  };

  const openDetail = async (report: TlsrptReport) => {
    try {
      const response = await tlsrptApi.getReport(report.id);
      if (response.data) {
        setSelectedReport(response.data);
      }
    } catch {
      setError('Failed to load TLS-RPT report details');
    }
  };

  // Deep link from issue evidence: /tlsrpt?reportId=123.
  const deepLinkReportId = searchParams.get('reportId');
  useEffect(() => {
    if (!deepLinkReportId) return;
    const id = Number.parseInt(deepLinkReportId, 10);
    if (!Number.isFinite(id)) return;

    let cancelled = false;
    tlsrptApi.getReport(id)
      .then((response) => {
        if (!cancelled && response.data) setSelectedReport(response.data);
      })
      .catch(() => setError('Failed to load the linked TLS-RPT report'));
    return () => { cancelled = true; };
  }, [deepLinkReportId]);

  const totals = useMemo(
    () => chartData.reduce(
      (acc, day) => ({
        success: acc.success + day.success,
        failure: acc.failure + day.failure,
      }),
      { success: 0, failure: 0 },
    ),
    [chartData],
  );
  const successRate =
    totals.success + totals.failure > 0
      ? ((totals.success / (totals.success + totals.failure)) * 100).toFixed(1)
      : '0.0';
  const maxSessions = Math.max(...chartData.map((day) => day.success + day.failure), 1);
  const activeFilterCount = [domain, organization, startDate !== defaultStartDate, endDate !== defaultEndDate].filter(Boolean).length;

  const columns = [
    {
      key: 'date_begin',
      header: 'Date',
      render: (report: TlsrptReport) => formatDate(report.date_begin),
    },
    {
      key: 'organization_name',
      header: 'Organization',
      render: (report: TlsrptReport) => report.organization_name || 'Unknown',
    },
    {
      key: 'report_id',
      header: 'Report ID',
      className: 'max-w-[220px] truncate',
    },
    {
      key: 'total_success',
      header: 'Success',
      className: 'text-right',
      render: (report: TlsrptReport) => (
        <span className="text-green-600 dark:text-green-400">{report.total_success.toLocaleString()}</span>
      ),
    },
    {
      key: 'total_failure',
      header: 'Failure',
      className: 'text-right',
      render: (report: TlsrptReport) => (
        <span className={report.total_failure > 0 ? 'text-red-600 dark:text-red-400' : ''}>
          {report.total_failure.toLocaleString()}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.tlsrptRaw}
        title="TLSRPT Reports"
        description="Track TLS transport outcomes, isolate failing organizations or domains, and drill into the raw policy evidence reported by senders."
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
          icon={<Lock className="h-5 w-5" />}
          label="Reports imported"
          value={(stats?.totalReports ?? 0).toLocaleString()}
          sub={`${stats?.last24Hours ?? 0} received in the last 24 hours`}
          tone="info"
        />
        <MetricCard
          icon={<CheckCircle2 className="h-5 w-5" />}
          label="Successful sessions"
          value={(stats?.totalSuccess ?? 0).toLocaleString()}
          sub={`${successRate}% success in the active chart window`}
          tone="success"
        />
        <MetricCard
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Failed sessions"
          value={(stats?.totalFailure ?? 0).toLocaleString()}
          sub={stats?.topFailureTypes?.[0] ? `Top issue: ${stats.topFailureTypes[0].type}` : 'No failure evidence imported yet'}
          tone="danger"
        />
        <MetricCard
          icon={<ShieldCheck className="h-5 w-5" />}
          label="Policy domains"
          value={domains.length.toLocaleString()}
          sub={domain ? `Focused on ${domain}` : 'All reporting domains visible'}
          tone="warning"
        />
      </div>

      {domains.length > 0 && (
        <div className="card p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Domain quick filters</h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Jump directly to the busiest reporting domains without opening the full filter panel.
              </p>
            </div>
            {domain && (
              <button
                onClick={() => {
                  setDomain('');
                  setPage(1);
                }}
                className="text-sm font-medium text-robin-orange hover:underline"
              >
                Clear domain focus
              </button>
            )}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <QuickFilterButton active={!domain} onClick={() => { setDomain(''); setPage(1); }}>
              All domains
            </QuickFilterButton>
            {domains.slice(0, 12).map((entry) => (
              <QuickFilterButton
                key={entry.domain}
                active={domain === entry.domain}
                onClick={() => {
                  setDomain(entry.domain);
                  setPage(1);
                }}
              >
                {entry.domain} ({entry.count})
              </QuickFilterButton>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.9fr)]">
        <div className="card p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Outcome trend</h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Successful and failed TLS sessions grouped by reporting day.
              </p>
            </div>
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
              {startDate} to {endDate}
            </span>
          </div>

          {chartData.length > 0 ? (
            <div className="mt-4">
              <div className="h-56 flex items-end gap-2">
                {chartData.map((day) => {
                  const totalSessions = day.success + day.failure;
                  const height = Math.max((totalSessions / maxSessions) * 100, 3);
                  const successPct = totalSessions > 0 ? (day.success / totalSessions) * 100 : 100;

                  return (
                    <div key={day.date} className="group relative flex-1" style={{ height: `${height}%` }}>
                      <div className="absolute inset-x-0 bottom-0 flex h-full flex-col overflow-hidden rounded-t-md">
                        <div className="bg-red-500" style={{ height: `${100 - successPct}%` }} />
                        <div className="bg-green-500" style={{ height: `${successPct}%` }} />
                      </div>
                      <div className="absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 rounded-sm bg-gray-900 px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
                        {day.date}: {day.success.toLocaleString()} OK / {day.failure.toLocaleString()} fail
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
                <span className="inline-flex items-center gap-1">
                  <span className="h-2.5 w-2.5 rounded-full bg-green-500" />
                  Success
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
                  Failure
                </span>
              </div>
            </div>
          ) : (
            <div className="mt-4 rounded-lg border border-dashed border-gray-300 px-4 py-10 text-center text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
              No TLS-RPT history has been imported for this window yet.
            </div>
          )}
        </div>

        <div className="card p-4">
          <div>
            <h2 className="text-lg font-semibold">Failure signals</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              The most common TLS-RPT failure buckets seen across the imported reports.
            </p>
          </div>
          <div className="mt-4 space-y-2">
            {(stats?.topFailureTypes ?? []).length > 0 ? (
              stats?.topFailureTypes.map((failure) => (
                <div key={failure.type} className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-robin-gray-800">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm font-medium">{failure.type}</span>
                    <span className="text-sm text-red-600 dark:text-red-400">{failure.count.toLocaleString()}</span>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-dashed border-gray-300 px-4 py-10 text-center text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
                Failure types will appear here once TLS-RPT reports are available.
              </div>
            )}
          </div>
        </div>
      </div>

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
                  setSortBy(event.target.value as TlsrptSortKey);
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
            {organization && (
              <ActiveFilterChip
                label={`Organization: ${organization}`}
                onClear={() => { setOrganization(''); setPage(1); }}
              />
            )}
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
                  placeholder="Filter by policy domain"
                  className="input w-full pl-10"
                />
              </div>
            </FilterField>

            <FilterField label="Organization">
              <input
                type="text"
                value={organization}
                onChange={(event) => {
                  setOrganization(event.target.value);
                  setPage(1);
                }}
                placeholder="Filter by organization"
                className="input w-full"
              />
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
          emptyMessage="No TLS-RPT reports found for the current filters"
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
        title="TLS-RPT report details"
        size="xl"
      >
        {selectedReport && (
          <div className="space-y-5">
            <div className="grid gap-4 text-sm md:grid-cols-4">
              <DetailStat label="Organization" value={selectedReport.report.organization_name || 'Unknown'} />
              <DetailStat label="Report ID" value={selectedReport.report.report_id} />
              <DetailStat
                label="Date range"
                value={`${formatDate(selectedReport.report.date_begin)} to ${formatDate(selectedReport.report.date_end)}`}
              />
              <DetailStat label="Contact" value={selectedReport.report.contact_info || '-'} />
            </div>

            <div className="flex flex-wrap gap-3">
              <StatusBadge tone="green">{selectedReport.report.total_success.toLocaleString()} successful</StatusBadge>
              <StatusBadge tone="red">{selectedReport.report.total_failure.toLocaleString()} failed</StatusBadge>
            </div>

            <div className="space-y-4">
              <div className="text-lg font-semibold">Policies ({selectedReport.policies.length})</div>
              {selectedReport.policies.length === 0 && (
                <div className="rounded-lg border border-dashed border-gray-300 px-4 py-10 text-center text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
                  No policies were stored with this report.
                </div>
              )}
              {selectedReport.policies.map((policy) => (
                <section key={policy.id} className="rounded-lg border border-gray-200 p-4 dark:border-robin-gray-700">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="text-lg font-semibold">{policy.policy_domain}</div>
                      <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">{policy.policy_type}</div>
                    </div>
                    <div className="flex gap-3 text-sm">
                      <StatusBadge tone="green">{policy.success_count.toLocaleString()} OK</StatusBadge>
                      <StatusBadge tone="red">{policy.failure_count.toLocaleString()} fail</StatusBadge>
                    </div>
                  </div>

                  {policy.mx_host && (
                    <div className="mt-3 text-sm text-gray-500 dark:text-gray-400">MX host: {policy.mx_host}</div>
                  )}

                  {policy.policy_string && policy.policy_string.length > 0 && (
                    <pre className="mt-3 overflow-x-auto rounded-lg bg-gray-100 p-3 text-xs dark:bg-robin-gray-800">
                      {policy.policy_string.join('\n')}
                    </pre>
                  )}

                  {policy.failures.length > 0 && (
                    <div className="mt-4 overflow-auto">
                      <table className="table w-full text-xs">
                        <thead>
                          <tr>
                            <th>Result type</th>
                            <th>Sending IP</th>
                            <th>Receiving MX</th>
                            <th>Count</th>
                            <th>Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {policy.failures.map((failure) => (
                            <tr key={failure.id}>
                              <td>{failure.result_type}</td>
                              <td className="font-mono">{failure.sending_mta_ip || '-'}</td>
                              <td>{failure.receiving_mx_hostname || '-'}</td>
                              <td>{failure.failed_session_count.toLocaleString()}</td>
                              <td>{failure.failure_reason_code || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              ))}
            </div>
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

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-robin-gray-800">
      <div className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</div>
      <div className="mt-1 break-all font-medium text-gray-900 dark:text-white">{value}</div>
    </div>
  );
}

function StatusBadge({ tone, children }: { tone: 'green' | 'red'; children: ReactNode }) {
  return (
    <span
      className={`rounded-full px-3 py-1 text-sm font-medium ${
        tone === 'green'
          ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
          : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
      }`}
    >
      {children}
    </span>
  );
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString();
}

function getDefaultStartDate(): string {
  const date = new Date();
  date.setDate(date.getDate() - 30);
  return date.toISOString().split('T')[0];
}

function getToday(): string {
  return new Date().toISOString().split('T')[0];
}
