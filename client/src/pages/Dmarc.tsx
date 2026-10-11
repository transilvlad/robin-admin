/**
 * DMARC raw reports workspace.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  BarChart3,
  Filter,
  Mail,
  RefreshCw,
  Search,
  Users,
} from 'lucide-react';
import { dmarcApi } from '../api/client';
import { DonutChart, LollipopChart } from '../components/charts';
import { ActiveFilterChip } from '../components/ui/ActiveFilterChip';
import { Button } from '../components/ui/Button';
import { MetricCard } from '../components/ui/MetricCard';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { Table } from '../components/ui/Table';
import { appIcons } from '../constants/appIcons';
import type { DmarcChartData, DmarcReport, DmarcReportDetail, DmarcReporter, DmarcStats } from '../types';
import { DMARC_CHART_COLORS, DMARC_CHART_LABELS, RECORD_TYPE_COLORS, RECORD_TYPE_LABELS } from '../types';
import type { DmarcSortKey, SortDirection } from '../types/raw-reporting';
import { loadStoredBoolean, parseEnumParam, parseIntParam, saveStoredBoolean } from '../utils/pageState';

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const TOP_REPORTER_LIMIT = 8;
const SORT_OPTIONS: { value: DmarcSortKey; label: string }[] = [
  { value: 'date', label: 'Newest report' },
  { value: 'total', label: 'Largest report volume' },
  { value: 'errors', label: 'Most failed messages' },
  { value: 'reporter', label: 'Reporter' },
  { value: 'domain', label: 'Domain' },
  { value: 'policy', label: 'Policy' },
];
const FILTERS_STORAGE_KEY = 'dmarc-raw-filters-open';

export function DmarcPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const defaultStartDate = useMemo(() => getDefaultStartDate(), []);
  const defaultEndDate = useMemo(() => getToday(), []);

  const [reports, setReports] = useState<DmarcReport[]>([]);
  const [chartData, setChartData] = useState<DmarcChartData[]>([]);
  const [reporters, setReporters] = useState<DmarcReporter[]>([]);
  const [stats, setStats] = useState<DmarcStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(() => parseIntParam(searchParams.get('page'), 1));
  const [pageSize, setPageSize] = useState(() => parseIntParam(searchParams.get('pageSize'), 50));
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [domain, setDomain] = useState(searchParams.get('domain') ?? '');
  const [reporterId, setReporterId] = useState<number | undefined>(() => {
    const value = parseIntParam(searchParams.get('reporterId'), 0);
    return value > 0 ? value : undefined;
  });
  const [startDate, setStartDate] = useState(searchParams.get('startDate') ?? defaultStartDate);
  const [endDate, setEndDate] = useState(searchParams.get('endDate') ?? defaultEndDate);
  const [sortBy, setSortBy] = useState<DmarcSortKey>(
    () => parseEnumParam(searchParams.get('sortBy'), SORT_OPTIONS.map((option) => option.value), 'date'),
  );
  const [sortOrder, setSortOrder] = useState<SortDirection>(
    () => parseEnumParam(searchParams.get('sortOrder'), ['asc', 'desc'], 'desc'),
  );
  const [selectedReport, setSelectedReport] = useState<DmarcReportDetail | null>(null);
  const [activeTab, setActiveTab] = useState(0);
  const [showFilters, setShowFilters] = useState(() => loadStoredBoolean(FILTERS_STORAGE_KEY, false));
  const [showAllReporters, setShowAllReporters] = useState(false);
  const [reporterSearch, setReporterSearch] = useState('');

  useEffect(() => {
    saveStoredBoolean(FILTERS_STORAGE_KEY, showFilters);
  }, [showFilters]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (domain) next.set('domain', domain);
    if (reporterId) next.set('reporterId', String(reporterId));
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
    page,
    pageSize,
    reporterId,
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
      const response = await dmarcApi.listReports(page, pageSize, {
        domain: domain || undefined,
        reporterId,
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
      setError('Failed to load DMARC reports');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [domain, endDate, page, pageSize, reporterId, sortBy, sortOrder, startDate]);

  const fetchChartData = useCallback(async () => {
    try {
      const response = await dmarcApi.getChartData(startDate, endDate, domain || undefined);
      setChartData(response.data ?? []);
    } catch {
      setError((current) => current || 'Failed to load DMARC chart data');
    }
  }, [domain, endDate, startDate]);

  const fetchReferenceData = useCallback(async () => {
    try {
      const [reportersResponse, statsResponse] = await Promise.all([
        dmarcApi.getReporters(),
        dmarcApi.getStats(),
      ]);
      setReporters(reportersResponse.data ?? []);
      setStats(statsResponse.data ?? null);
    } catch {
      setError((current) => current || 'Failed to load DMARC workspace data');
    }
  }, []);

  useEffect(() => {
    fetchReports();
    fetchChartData();
  }, [fetchChartData, fetchReports]);

  useEffect(() => {
    fetchReferenceData();
  }, [fetchReferenceData]);

  const clearFilters = () => {
    setDomain('');
    setReporterId(undefined);
    setStartDate(defaultStartDate);
    setEndDate(defaultEndDate);
    setPage(1);
  };

  const refreshAll = () => {
    fetchReports(true);
    fetchChartData();
    fetchReferenceData();
  };

  const openDetail = async (report: DmarcReport) => {
    try {
      const response = await dmarcApi.getReport(report.id);
      if (response.data) {
        const firstRecordType = response.data.records.find((record) => record.recordType >= 0)?.recordType ?? 0;
        setSelectedReport(response.data);
        setActiveTab(firstRecordType);
      }
    } catch {
      setError('Failed to load DMARC report details');
    }
  };

  // Deep link from an issue's evidence: /dmarc?reportId=123 opens that
  // report directly, so "prove it" is one click rather than a manual
  // hunt through the list.
  const deepLinkReportId = searchParams.get('reportId');
  useEffect(() => {
    if (!deepLinkReportId) return;
    const id = Number.parseInt(deepLinkReportId, 10);
    if (!Number.isFinite(id)) return;

    let cancelled = false;
    dmarcApi.getReport(id)
      .then((response) => {
        if (cancelled || !response.data) return;
        const firstRecordType = response.data.records.find((record) => record.recordType >= 0)?.recordType ?? 0;
        setSelectedReport(response.data);
        setActiveTab(firstRecordType);
      })
      .catch(() => setError('Failed to load the linked DMARC report'));
    return () => { cancelled = true; };
  }, [deepLinkReportId]);

  const totalsByType = useMemo(() => {
    return chartData.reduce(
      (acc, day) => {
        day.values.forEach((value, index) => {
          acc[index] = (acc[index] || 0) + value;
        });
        return acc;
      },
      // Length matches DMARC_CHART_LABELS (compliant / auth-unaligned / benign / actionable).
      DMARC_CHART_LABELS.map(() => 0),
    );
  }, [chartData]);

  const totalMessagesInChart = totalsByType.reduce((sum, value) => sum + value, 0);
  const selectedReporter = reporters.find((reporter) => reporter.id === reporterId) ?? null;
  const activeFilterCount = [domain, reporterId, startDate !== defaultStartDate, endDate !== defaultEndDate].filter(Boolean).length;
  const quickReporters = useMemo(() => {
    if (reporters.length <= TOP_REPORTER_LIMIT) {
      return reporters;
    }
    const topReporters = reporters.slice(0, TOP_REPORTER_LIMIT);
    if (!selectedReporter || topReporters.some((reporter) => reporter.id === selectedReporter.id)) {
      return topReporters;
    }
    return [...topReporters.slice(0, TOP_REPORTER_LIMIT - 1), selectedReporter];
  }, [reporters, selectedReporter]);
  const quickReporterIds = useMemo(() => new Set(quickReporters.map((reporter) => reporter.id)), [quickReporters]);
  const normalizedReporterSearch = reporterSearch.trim().toLowerCase();
  const expandedReporters = useMemo(() => {
    const filtered = reporters.filter((reporter) => (
      normalizedReporterSearch.length === 0
      || reporter.displayName.toLowerCase().includes(normalizedReporterSearch)
      || reporter.name.toLowerCase().includes(normalizedReporterSearch)
    ));
    if (normalizedReporterSearch.length > 0) {
      return filtered;
    }
    return filtered.filter((reporter) => !quickReporterIds.has(reporter.id));
  }, [normalizedReporterSearch, quickReporterIds, reporters]);
  const remainingReporterCount = Math.max(reporters.length - quickReporters.length, 0);

  const columns = [
    {
      key: 'dateBegin',
      header: 'Date',
      render: (report: DmarcReport) => formatDate(report.dateBegin),
    },
    { key: 'reporterName', header: 'Reporter' },
    { key: 'domain', header: 'Domain' },
    {
      key: 'totalCount',
      header: 'Messages',
      className: 'text-right',
      render: (report: DmarcReport) => report.totalCount.toLocaleString(),
    },
    {
      key: 'errorCount',
      header: 'Failed',
      className: 'text-right',
      render: (report: DmarcReport) => (
        <span className={report.errorCount > 0 ? 'text-red-600 dark:text-red-400' : ''}>
          {report.errorCount.toLocaleString()}
        </span>
      ),
    },
    { key: 'policy', header: 'Policy' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.dmarcRaw}
        title="DMARC Reports"
        description="Review aggregate reports, pivot by reporter or domain, and drill into the raw message evidence behind current DMARC posture."
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
          sub={`${stats?.recentReports ?? 0} seen in the last 7 days`}
          tone="info"
        />
        <MetricCard
          icon={<BarChart3 className="h-5 w-5" />}
          label="Messages covered"
          value={(stats?.totalMessages ?? 0).toLocaleString()}
          sub={`${totalMessagesInChart.toLocaleString()} visible in the active chart window`}
          tone="success"
        />
        <MetricCard
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Failed messages"
          value={(stats?.errorMessages ?? 0).toLocaleString()}
          sub="Policy-evaluated failures across imported reports"
          tone="danger"
        />
        <MetricCard
          icon={<Users className="h-5 w-5" />}
          label="Reporting organizations"
          value={reporters.length.toLocaleString()}
          sub={selectedReporter ? `Focused on ${selectedReporter.displayName}` : 'All reporters visible'}
          tone="warning"
        />
      </div>

      {reporters.length > 0 && (
        <div className="card p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400">
                Reporter quick filters
              </h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Jump into the busiest reporting sources first, then expand into the long tail only when needed.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {reporters.length > quickReporters.length && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowAllReporters((open) => !open)}
                >
                  {showAllReporters ? 'Hide more reporters' : `More reporters (${remainingReporterCount})`}
                </Button>
              )}
              {selectedReporter && (
                <button
                  onClick={() => {
                    setReporterId(undefined);
                    setPage(1);
                  }}
                  className="text-sm font-medium text-robin-orange hover:underline"
                >
                  Clear reporter focus
                </button>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <QuickFilterButton active={!reporterId} onClick={() => { setReporterId(undefined); setPage(1); }}>
              All reporters
            </QuickFilterButton>
            {quickReporters.map((reporter) => (
              <QuickFilterButton
                key={reporter.id}
                active={reporter.id === reporterId}
                onClick={() => {
                  setReporterId(reporter.id);
                  setPage(1);
                }}
              >
                <span className="flex items-center gap-2">
                  <span>{reporter.displayName}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${
                    reporter.id === reporterId
                      ? 'bg-white/20 text-white'
                      : 'bg-gray-100 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300'
                  }`}>
                    {reporter.reportCount.toLocaleString()}
                  </span>
                </span>
              </QuickFilterButton>
            ))}
          </div>

          {(showAllReporters || normalizedReporterSearch.length > 0) && (
            <div className="mt-4 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white">More reporters</h3>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    Sorted by report count, highest first.
                  </p>
                </div>
                <div className="relative w-full lg:w-80">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                  <input
                    type="text"
                    value={reporterSearch}
                    onChange={(event) => setReporterSearch(event.target.value)}
                    placeholder="Search reporters"
                    className="input w-full pl-10"
                  />
                </div>
              </div>
              <div className="mt-4 max-h-64 overflow-y-auto">
                {expandedReporters.length > 0 ? (
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {expandedReporters.map((reporter) => (
                      <button
                        key={reporter.id}
                        onClick={() => {
                          setReporterId(reporter.id);
                          setPage(1);
                        }}
                        className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                          reporter.id === reporterId
                            ? 'border-robin-orange bg-robin-orange/10 text-robin-orange'
                            : 'border-gray-200 text-gray-700 hover:bg-gray-50 dark:border-robin-gray-700 dark:text-gray-200 dark:hover:bg-robin-gray-800'
                        }`}
                      >
                        <span className="truncate pr-3">{reporter.displayName}</span>
                        <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">
                          {reporter.reportCount.toLocaleString()}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
                    No reporters match this search.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.95fr)]">
        <div className="card p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Daily volume</h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Message-classification trend across the selected reporting window.
              </p>
            </div>
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
              {startDate} to {endDate}
            </span>
          </div>
          <div className="mt-4">
            <LollipopChart
              data={chartData}
              colors={DMARC_CHART_COLORS}
              labels={DMARC_CHART_LABELS}
              height={280}
            />
          </div>
        </div>

        <div className="card p-4">
          <div>
            <h2 className="text-lg font-semibold">DMARC outcome mix</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Distribution of report volume across DMARC outcomes for the window.
            </p>
          </div>
          <div className="mt-4 flex justify-center">
            <DonutChart
              values={totalsByType}
              colors={DMARC_CHART_COLORS}
              labels={DMARC_CHART_LABELS}
              size={190}
              strokeWidth={34}
            />
          </div>
          <div className="mt-4 space-y-2">
            {DMARC_CHART_LABELS.map((label, index) => (
              <div key={label} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-robin-gray-800">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: DMARC_CHART_COLORS[index] }} />
                  <span>{label}</span>
                </div>
                <span className="font-medium">{(totalsByType[index] || 0).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Evidence list</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {total.toLocaleString()} reports match the current scope.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <label className="text-sm text-gray-500 dark:text-gray-400">
              Sort
              <select
                value={sortBy}
                onChange={(event) => {
                  setSortBy(event.target.value as DmarcSortKey);
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
            {domain && (
              <ActiveFilterChip label={`Domain: ${domain}`} onClear={() => { setDomain(''); setPage(1); }} />
            )}
            {selectedReporter && (
                <ActiveFilterChip
                  label={`Reporter: ${selectedReporter.displayName} (${selectedReporter.reportCount.toLocaleString()})`}
                  onClear={() => { setReporterId(undefined); setPage(1); }}
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
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Domain</label>
              <div className="relative mt-1">
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
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Reporter</label>
              <select
                value={reporterId ?? ''}
                onChange={(event) => {
                  setReporterId(event.target.value ? Number(event.target.value) : undefined);
                  setPage(1);
                }}
                className="input mt-1 w-full"
              >
                  <option value="">All reporters</option>
                  {reporters.map((reporter) => (
                    <option key={reporter.id} value={reporter.id}>
                      {reporter.displayName} ({reporter.reportCount.toLocaleString()})
                    </option>
                  ))}
                </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Start date</label>
              <input
                type="date"
                value={startDate}
                onChange={(event) => {
                  setStartDate(event.target.value);
                  setPage(1);
                }}
                className="input mt-1 w-full"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">End date</label>
              <input
                type="date"
                value={endDate}
                onChange={(event) => {
                  setEndDate(event.target.value);
                  setPage(1);
                }}
                className="input mt-1 w-full"
              />
            </div>
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
          emptyMessage="No DMARC reports found for the current filters"
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
        title="DMARC report details"
        size="xl"
      >
        {selectedReport && (
          <div className="space-y-5">
            <div className="grid gap-4 text-sm md:grid-cols-4">
              <DetailStat label="Reporter" value={selectedReport.report.reporterName || selectedReport.report.orgName} />
              <DetailStat label="Domain" value={selectedReport.report.domain} />
              <DetailStat
                label="Date range"
                value={`${formatDate(selectedReport.report.dateBegin)} to ${formatDate(selectedReport.report.dateEnd)}`}
              />
              <DetailStat label="Policy" value={selectedReport.report.policy} />
            </div>

            <div className="flex flex-wrap gap-2">
              {selectedReport.summary.map((entry) => (
                <div
                  key={entry.type}
                  className="rounded-full px-3 py-1 text-sm font-medium"
                  style={{
                    backgroundColor: `${RECORD_TYPE_COLORS[entry.type]}20`,
                    color: RECORD_TYPE_COLORS[entry.type],
                  }}
                >
                  {RECORD_TYPE_LABELS[entry.type]}: {entry.msgCount.toLocaleString()}
                </div>
              ))}
            </div>

            <div className="border-b border-gray-200 dark:border-robin-gray-700">
              <div className="flex flex-wrap gap-4">
                {RECORD_TYPE_LABELS.map((label, index) => {
                  const count = selectedReport.records.filter((record) => record.recordType === index).length;
                  return (
                    <button
                      key={label}
                      onClick={() => setActiveTab(index)}
                      className={`border-b-2 px-1 py-2 text-sm font-medium transition-colors ${
                        activeTab === index
                          ? 'border-robin-orange text-robin-orange'
                          : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                      }`}
                    >
                      {label} <span className="text-xs opacity-70">({count})</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="max-h-104 overflow-auto">
              <table className="table w-full text-sm">
                <thead>
                  <tr>
                    <th>Source IP</th>
                    <th>Count</th>
                    <th>Disposition</th>
                    <th>DKIM</th>
                    <th>SPF</th>
                    <th>Header from</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedReport.records
                    .filter((record) => record.recordType === activeTab)
                    .map((record) => (
                      <tr key={record.id}>
                        <td className="font-mono">{record.sourceIp}</td>
                        <td>{record.count.toLocaleString()}</td>
                        <td>{record.disposition}</td>
                        <td>
                          <OutcomePill value={record.dkim} />
                        </td>
                        <td>
                          <OutcomePill value={record.spf} />
                        </td>
                        <td>{record.headerFrom || '-'}</td>
                      </tr>
                    ))}
                  {selectedReport.records.filter((record) => record.recordType === activeTab).length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-gray-500 dark:text-gray-400">
                        No records in this classification bucket.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
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

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-robin-gray-800">
      <div className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</div>
      <div className="mt-1 font-medium text-gray-900 dark:text-white">{value}</div>
    </div>
  );
}

function OutcomePill({ value }: { value: string }) {
  const positive = value === 'pass';
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        positive
          ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
          : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
      }`}
    >
      {value}
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
