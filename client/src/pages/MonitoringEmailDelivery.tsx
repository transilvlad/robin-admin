import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Inbox, RefreshCw } from 'lucide-react';
import { ApiError, emailApi } from '../api/client';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import type { EmailDelivery, EmailDeliveryStatus } from '../types/email';

type StatusFilter = 'all' | EmailDeliveryStatus;
type StatTone = 'neutral' | 'success' | 'warning' | 'error';

const PAGE_SIZES = [10, 25, 50] as const;

export function MonitoringEmailDeliveryPage() {
  const [deliveries, setDeliveries] = useState<EmailDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const response = await emailApi.deliveries();
      setDeliveries(response.data ?? []);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load monitoring email delivery');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const stats = useMemo(() => {
    const accepted = deliveries.filter((delivery) => delivery.status === 'accepted').length;
    const pending = deliveries.filter((delivery) => delivery.status === 'pending' || delivery.status === 'processing').length;
    const cancelled = deliveries.filter((delivery) => delivery.status === 'cancelled').length;
    const failed = deliveries.filter((delivery) => delivery.status === 'failed').length;
    return { accepted, pending, cancelled, failed };
  }, [deliveries]);

  if (loading) return <div className="flex justify-center py-10"><Spinner className="text-robin-orange" /></div>;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.email}
        title="Monitoring email delivery"
        description="Operational visibility for monitoring and status page email delivery."
        actions={<Button variant="secondary" onClick={() => void load(false)}><RefreshCw aria-hidden="true" className="h-4 w-4" />Refresh</Button>}
      />

      {error && <Notice>{error}</Notice>}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Accepted" value={stats.accepted} tone="success" />
        <Stat label="Pending" value={stats.pending} tone={stats.pending ? 'warning' : 'neutral'} />
        <Stat label="Cancelled" value={stats.cancelled} tone={stats.cancelled ? 'warning' : 'neutral'} />
        <Stat label="Failed" value={stats.failed} tone={stats.failed ? 'error' : 'neutral'} />
      </section>

      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 p-5 dark:border-gray-700">
          <div>
            <h2 className="text-base font-semibold">Email delivery history</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
              Recent admin notification and public status page email attempts.
            </p>
          </div>
          <Inbox aria-hidden="true" className="h-5 w-5 text-gray-400" />
        </div>
        <History deliveries={deliveries} />
      </section>
    </div>
  );
}

function History({ deliveries }: { deliveries: EmailDelivery[] }) {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [purpose, setPurpose] = useState('all');
  const [query, setQuery] = useState('');
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(10);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const purposes = useMemo(() => Array.from(new Set(deliveries.map((delivery) => delivery.purpose))).sort(), [deliveries]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return deliveries.filter((delivery) => {
      const statusMatches = status === 'all' || delivery.status === status;
      const purposeMatches = purpose === 'all' || delivery.purpose === purpose;
      const searchMatches = !needle || [
        delivery.recipientEmail,
        delivery.subject,
        delivery.purpose,
        delivery.status,
        delivery.error ?? '',
      ].some((value) => value.toLowerCase().includes(needle));
      return statusMatches && purposeMatches && searchMatches;
    });
  }, [deliveries, purpose, query, status]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const firstVisible = visibleStart(currentPage, pageSize, filtered.length);
  const lastVisible = Math.min(currentPage * pageSize, filtered.length);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const updateFilters = (action: () => void) => {
    action();
    setPage(1);
    setExpanded(new Set());
  };

  const toggle = (id: number) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div>
      <div className="grid gap-4 border-b border-gray-200 p-4 dark:border-gray-700 lg:grid-cols-[180px_180px_minmax(260px,1fr)_112px]">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Status</span>
          <select className="input" value={status} onChange={(event) => updateFilters(() => setStatus(event.target.value as StatusFilter))}>
            <option value="all">All statuses</option>
            <option value="accepted">Accepted</option>
            <option value="pending">Pending</option>
            <option value="processing">Processing</option>
            <option value="cancelled">Cancelled</option>
            <option value="failed">Failed</option>
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Purpose</span>
          <select className="input" value={purpose} onChange={(event) => updateFilters(() => setPurpose(event.target.value))}>
            <option value="all">All purposes</option>
            {purposes.map((value) => <option key={value} value={value}>{formatPurpose(value)}</option>)}
          </select>
        </label>

        <label className="block min-w-0 space-y-1">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Search</span>
          <input
            className="input"
            value={query}
            onChange={(event) => updateFilters(() => setQuery(event.target.value))}
            placeholder="Recipient, subject, error"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Rows</span>
          <select className="input w-full" value={pageSize} onChange={(event) => updateFilters(() => setPageSize(Number(event.target.value) as (typeof PAGE_SIZES)[number]))}>
            {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-left text-sm">
          <thead className="bg-gray-50 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300">
            <tr>
              <th className="w-10 px-4 py-3 font-medium" aria-label="Details" />
              <th className="w-32 px-4 py-3 font-medium">Status</th>
              <th className="w-32 px-4 py-3 font-medium">Purpose</th>
              <th className="w-56 px-4 py-3 font-medium">Recipient</th>
              <th className="px-4 py-3 font-medium">Subject</th>
              <th className="w-24 px-4 py-3 font-medium">Attempts</th>
              <th className="w-44 px-4 py-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {visible.map((delivery) => {
              const isExpanded = expanded.has(delivery.id);
              return (
                <Fragment key={delivery.id}>
                  <tr className="align-top">
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        className="rounded-sm p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-robin-gray-800 dark:hover:text-white"
                        onClick={() => toggle(delivery.id)}
                        aria-label={isExpanded ? 'Hide delivery attempts' : 'Show delivery attempts'}
                      >
                        {isExpanded ? <ChevronDown aria-hidden="true" className="h-4 w-4" /> : <ChevronRight aria-hidden="true" className="h-4 w-4" />}
                      </button>
                    </td>
                    <td className="px-4 py-3"><Status status={delivery.status} /></td>
                    <td className="whitespace-nowrap px-4 py-3">{formatPurpose(delivery.purpose)}</td>
                    <td className="wrap-break-word px-4 py-3">{delivery.recipientEmail}</td>
                    <td className="wrap-break-word px-4 py-3">
                      <div>{delivery.subject}</div>
                      {delivery.error && <div className="mt-1 text-xs text-red-600 dark:text-red-300">{delivery.error}</div>}
                    </td>
                    <td className="px-4 py-3">{delivery.attempts}</td>
                    <td className="whitespace-nowrap px-4 py-3">{formatDate(delivery.createdAt)}</td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={7} className="bg-gray-50 px-4 py-4 dark:bg-robin-gray-900/50">
                        <Attempts attempts={delivery.deliveryAttempts} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {!visible.length && <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500">No deliveries match the current filters.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 px-4 py-3 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300">
        <span>Showing {firstVisible}-{lastVisible} of {filtered.length} deliveries.</span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</Button>
          <span className="whitespace-nowrap">Page {currentPage} of {pageCount}</span>
          <Button size="sm" variant="secondary" disabled={currentPage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>Next</Button>
        </div>
      </div>
    </div>
  );
}

function Attempts({ attempts }: { attempts: EmailDelivery['deliveryAttempts'] }) {
  if (attempts.length === 0) return <div className="text-sm text-gray-500 dark:text-gray-400">No relay attempts have been recorded yet.</div>;

  return (
    <div className="space-y-3">
      <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Relay attempts</div>
      <div className="grid gap-2">
        {attempts.map((attempt) => (
          <div key={attempt.id} className="min-w-0 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-robin-gray-900">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-medium">{attempt.relayName}</div>
              <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                <span>Attempt {attempt.attemptNumber}</span>
                <span>{formatDate(attempt.createdAt)}</span>
                <span className={attempt.accepted ? 'text-green-600 dark:text-green-300' : 'text-red-600 dark:text-red-300'}>
                  {attempt.accepted ? 'Accepted' : 'Rejected'}
                </span>
              </div>
            </div>
            <pre className="mt-2 max-h-28 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-sm bg-gray-950 p-3 text-xs text-gray-100">
              {formatAttemptDetail(attempt.error || attempt.response || 'No response detail recorded.')}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, tone = 'neutral' }: { label: string; value: number; tone?: StatTone }) {
  const classes: Record<StatTone, string> = {
    neutral: 'border-gray-200 bg-white text-gray-950 dark:border-gray-700 dark:bg-robin-gray-900 dark:text-white',
    success: 'border-green-200 bg-green-50 text-green-700 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-200',
    warning: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200',
    error: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200',
  };

  return (
    <div className={`rounded-lg border p-4 ${classes[tone]}`}>
      <div className="text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-sm opacity-80">{label}</div>
    </div>
  );
}

function Status({ status }: { status: EmailDeliveryStatus }) {
  const classes: Record<EmailDeliveryStatus, string> = {
    accepted: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200',
    pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
    processing: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200',
    cancelled: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200',
    failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200',
  };

  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${classes[status]}`}>{formatStatus(status)}</span>;
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">{children}</div>;
}

function formatStatus(value: EmailDeliveryStatus): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatPurpose(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatAttemptDetail(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function formatDate(value: string | null): string {
  if (!value) return '-';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function visibleStart(page: number, pageSize: number, total: number): number {
  if (total === 0) return 0;
  return ((page - 1) * pageSize) + 1;
}
