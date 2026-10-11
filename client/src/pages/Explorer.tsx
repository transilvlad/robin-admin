/**
 * Explorer — record-level evidence viewer.
 *
 * Record-level evidence stays one click away from reporting summaries. Every row
 * carries the same classification used by the aggregate views, so headline
 * numbers can always be checked against the records behind them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, Search, Table2 } from 'lucide-react';
import { PageHeader } from '../components/ui/PageHeader';
import { Table, type Column } from '../components/ui/Table';
import { reportingApi } from '../api/client';
import { TimeframeControl } from '../components/reporting/TimeframeControl';
import { useTimeframe } from '../components/reporting/useTimeframe';
import {
  formatCount,
  formatDate,
  ReportingEmptyState,
  TimeframeBanner,
} from '../components/reporting/primitives';
import type {
  ComplianceClass,
  RecordRow,
  RecordSort,
  TimeframeInfo,
} from '../types/reporting';
import { COMPLIANCE_CLASS_LABELS, FAILURE_REASON_LABELS } from '../types/reporting';

const PAGE_SIZE = 100;

const CLASS_CLASSES: Record<ComplianceClass, string> = {
  compliant: 'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300',
  authenticated_unaligned:
    'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300',
};

type Tri = '' | 'true' | 'false';

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function ExplorerPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { query, from, to, setRange, clear } = useTimeframe();

  const domain = searchParams.get('domain') ?? '';
  const reporter = searchParams.get('reporter') ?? '';
  const search = searchParams.get('search') ?? '';
  const complianceClass = (searchParams.get('class') ?? '') as ComplianceClass | '';
  const disposition = searchParams.get('disposition') ?? '';
  const reason = searchParams.get('reason') ?? '';
  const spfAligned = (searchParams.get('spfAligned') ?? '') as Tri;
  const dkimAligned = (searchParams.get('dkimAligned') ?? '') as Tri;

  const [searchInput, setSearchInput] = useState(search);
  const [sort, setSort] = useState<RecordSort>('volume');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [timeframe, setTimeframe] = useState<TimeframeInfo | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  const setFilter = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(searchParams);
      if (value) next.set(key, value);
      else next.delete(key);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  const filters = useMemo(
    () => ({
      ...query,
      domain: domain || undefined,
      reporter: reporter || undefined,
      search: search || undefined,
      class: (complianceClass || undefined) as ComplianceClass | undefined,
      disposition: disposition || undefined,
      reason: reason || undefined,
      spfAligned: spfAligned === '' ? undefined : spfAligned === 'true',
      dkimAligned: dkimAligned === '' ? undefined : dkimAligned === 'true',
    }),
    [query, domain, reporter, search, complianceClass, disposition, reason, spfAligned, dkimAligned]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await reportingApi.getRecords({
        ...filters,
        sort,
        direction: sort === 'domain' || sort === 'source' ? 'asc' : 'desc',
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      setRows(res.data ?? []);
      setTimeframe(res.meta?.timeframe ?? null);
      setTotal(res.pagination?.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load records');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [filters, sort, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [filters, sort]);

  useEffect(() => {
    setSearchInput(search);
  }, [search]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const res = await reportingApi.getRecords({
        ...filters,
        sort,
        direction: 'desc',
        limit: 1000,
        offset: 0,
      });
      const header = [
        'domain', 'source_ip', 'count', 'class', 'detail', 'reason', 'benign_relay',
        'disposition', 'dkim_aligned', 'spf_aligned', 'dkim_result', 'spf_result',
        'dkim_domain', 'spf_domain', 'header_from', 'envelope_from', 'reporter',
        'date_begin', 'date_end',
      ];
      const lines = [header.join(',')];
      for (const r of res.data ?? []) {
        lines.push(
          [
            r.domain, r.sourceIp, r.count, r.classification.class, r.classification.detail,
            r.classification.reason, r.classification.benignRelay, r.disposition, r.dkim,
            r.spf, r.dkimResult, r.spfResult, r.dkimDomain, r.spfDomain, r.headerFrom,
            r.envelopeFrom, r.reporter, r.dateBegin, r.dateEnd,
          ].map(csvCell).join(',')
        );
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dmarc-records-${timeframe?.from?.slice(0, 10) ?? 'export'}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const columns = useMemo<Column<RecordRow>[]>(
    () => [
      {
        key: 'domain',
        header: 'Domain',
        render: (r) => (
          <div>
            <div className="font-medium">{r.domain}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">{r.reporter ?? '—'}</div>
          </div>
        ),
      },
      {
        key: 'source',
        header: 'Source IP',
        render: (r) => <span className="font-mono text-xs">{r.sourceIp}</span>,
      },
      { key: 'count', header: 'Messages', render: (r) => formatCount(r.count) },
      {
        key: 'class',
        header: 'Result',
        render: (r) => (
          <div className="space-y-1">
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                CLASS_CLASSES[r.classification.class]
              }`}
            >
              {COMPLIANCE_CLASS_LABELS[r.classification.class]}
            </span>
            {r.classification.reason !== 'none' && (
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {FAILURE_REASON_LABELS[r.classification.reason]}
                {r.classification.benignRelay ? ' (benign)' : ''}
              </div>
            )}
          </div>
        ),
      },
      {
        key: 'auth',
        header: 'Alignment',
        render: (r) => (
          <div className="text-xs">
            <div>
              DKIM <Verdict value={r.dkim} /> <span className="text-gray-400">/ raw {r.dkimResult ?? '—'}</span>
            </div>
            <div>
              SPF <Verdict value={r.spf} /> <span className="text-gray-400">/ raw {r.spfResult ?? '—'}</span>
            </div>
          </div>
        ),
      },
      {
        key: 'identifiers',
        header: 'Identifiers',
        render: (r) => (
          <div className="text-xs text-gray-500 dark:text-gray-400">
            <div>from: {r.headerFrom ?? '—'}</div>
            <div>d=: {r.dkimDomain ?? '—'}</div>
            <div>spf: {r.spfDomain ?? r.envelopeFrom ?? '—'}</div>
          </div>
        ),
      },
      { key: 'disposition', header: 'Applied', render: (r) => r.disposition ?? '—' },
      {
        key: 'date',
        header: 'Window',
        render: (r) => (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {formatDate(r.dateBegin)}
          </span>
        ),
      },
    ],
    []
  );

  const anyFilter =
    Boolean(domain || reporter || search || complianceClass || disposition || reason) ||
    spfAligned !== '' ||
    dkimAligned !== '';

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Table2}
        title="Explorer"
        description="Every aggregate record, filterable and exportable. Use this to verify any number shown elsewhere in reporting against the evidence receivers actually sent."
        actions={
          <button className="btn btn-secondary" onClick={exportCsv} disabled={exporting || total === 0}>
            <Download className="mr-2 h-4 w-4" />
            {exporting ? 'Exporting…' : 'Export CSV'}
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

      <div className="card space-y-4 p-4">
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter('search', searchInput.trim());
          }}
        >
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            className="input pl-9"
            placeholder="Search by domain, source IP, header from, DKIM domain…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </form>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Domain">
            <input
              className="input py-1.5 text-sm"
              value={domain}
              placeholder="any"
              onChange={(e) => setFilter('domain', e.target.value.trim())}
            />
          </Field>
          <Field label="Reporter">
            <input
              className="input py-1.5 text-sm"
              value={reporter}
              placeholder="any"
              onChange={(e) => setFilter('reporter', e.target.value.trim())}
            />
          </Field>
          <Field label="Result">
            <select
              className="input py-1.5 text-sm"
              value={complianceClass}
              onChange={(e) => setFilter('class', e.target.value)}
            >
              <option value="">Any</option>
              {(Object.keys(COMPLIANCE_CLASS_LABELS) as ComplianceClass[]).map((c) => (
                <option key={c} value={c}>
                  {COMPLIANCE_CLASS_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Override reason">
            <select
              className="input py-1.5 text-sm"
              value={reason}
              onChange={(e) => setFilter('reason', e.target.value)}
            >
              <option value="">Any</option>
              {Object.entries(FAILURE_REASON_LABELS)
                .filter(([k]) => k !== 'none')
                .map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="DKIM aligned">
            <TriSelect value={dkimAligned} onChange={(v) => setFilter('dkimAligned', v)} />
          </Field>
          <Field label="SPF aligned">
            <TriSelect value={spfAligned} onChange={(v) => setFilter('spfAligned', v)} />
          </Field>
          <Field label="Policy applied">
            <select
              className="input py-1.5 text-sm"
              value={disposition}
              onChange={(e) => setFilter('disposition', e.target.value)}
            >
              <option value="">Any</option>
              <option value="none">none</option>
              <option value="quarantine">quarantine</option>
              <option value="reject">reject</option>
            </select>
          </Field>
          <Field label="Sort">
            <select
              className="input py-1.5 text-sm"
              value={sort}
              onChange={(e) => setSort(e.target.value as RecordSort)}
            >
              <option value="volume">Messages</option>
              <option value="date">Date</option>
              <option value="domain">Domain</option>
              <option value="source">Source IP</option>
            </select>
          </Field>
        </div>

        {anyFilter && (
          <button
            className="text-xs text-robin-orange hover:underline"
            onClick={() => {
              const next = new URLSearchParams();
              if (from) next.set('from', from);
              if (to) next.set('to', to);
              setSearchParams(next, { replace: true });
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="card p-4">
        {!loading && rows.length === 0 && timeframe ? (
          <ReportingEmptyState timeframe={timeframe} noun="records" filtered={anyFilter} />
        ) : (
          <Table
            columns={columns}
            data={rows}
            keyField="id"
            isLoading={loading}
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs text-gray-500 dark:text-gray-400">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}

function TriSelect({ value, onChange }: { value: Tri; onChange: (v: Tri) => void }) {
  return (
    <select
      className="input py-1.5 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value as Tri)}
    >
      <option value="">Any</option>
      <option value="true">Aligned</option>
      <option value="false">Not aligned</option>
    </select>
  );
}

function Verdict({ value }: { value: string | null }) {
  const pass = (value ?? '').toLowerCase() === 'pass';
  return (
    <span className={pass ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
      {value ?? '—'}
    </span>
  );
}
