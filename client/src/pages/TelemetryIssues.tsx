import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, BellOff, ExternalLink, RefreshCw } from 'lucide-react';
import { alertsApi, ApiError } from '../api/client';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import type { TelemetryAlertIssue, TelemetryAlertIssueStatus } from '../types/telemetry-alerts';

const PAGE_SIZE = 50;
const ISSUE_TABS: Array<{ status: TelemetryAlertIssueStatus; label: string }> = [
  { status: 'active', label: 'Active' },
  { status: 'dismissed', label: 'Dismissed' },
  { status: 'resolved', label: 'Resolved' },
];

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels).filter(([key]) => key !== '__name__').sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(', ') : 'All series';
}

function formatValue(value: number | null): string {
  return value === null ? 'n/a' : String(Number(value.toFixed(4)));
}

function formatDuration(seconds: number): string {
  if (seconds === 0) return 'immediately';
  if (seconds % 3600 === 0) return `${seconds / 3600} hr`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} sec`;
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

function localDateTimeValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function eventLabel(eventType: TelemetryAlertIssue['events'][number]['eventType']): string {
  const labels: Record<TelemetryAlertIssue['events'][number]['eventType'], string> = {
    firing: 'Firing',
    dismissed: 'Dismissed',
    resumed: 'Returned to active',
    dismissal_expired: 'Dismissal expired',
    severity_escalated: 'Severity increased',
    resolved: 'Resolved',
  };
  return labels[eventType];
}

export function TelemetryIssuesPage() {
  const [status, setStatus] = useState<TelemetryAlertIssueStatus>('active');
  const [issues, setIssues] = useState<TelemetryAlertIssue[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dismissing, setDismissing] = useState<TelemetryAlertIssue | null>(null);
  const [reason, setReason] = useState('');
  const [hasExpiry, setHasExpiry] = useState(false);
  const [until, setUntil] = useState('');
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    try {
      const response = await alertsApi.listTelemetryIssues(status, PAGE_SIZE, offset);
      if (requestVersion.current !== version) return;
      setIssues(response.data?.issues ?? []);
      setTotal(response.data?.total ?? 0);
      setError('');
    } catch (err) {
      if (requestVersion.current !== version) return;
      setError(err instanceof ApiError ? err.message : 'Failed to load telemetry issues');
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  }, [status, offset]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const changeStatus = (next: TelemetryAlertIssueStatus) => {
    setStatus(next);
    setOffset(0);
    setNotice('');
  };

  const openDismiss = (issue: TelemetryAlertIssue) => {
    setError('');
    setReason('');
    setHasExpiry(false);
    setUntil(localDateTimeValue(new Date(Date.now() + 4 * 60 * 60_000)));
    setDismissing(issue);
  };

  const dismiss = async () => {
    if (!dismissing) return;
    setWorkingId(dismissing.id);
    setError('');
    setNotice('');
    ++requestVersion.current;
    try {
      const expiresAt = hasExpiry ? new Date(until) : null;
      if (hasExpiry && (!until || !expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date())) {
        setError('Choose a future expiration time or dismiss until the issue resolves.');
        return;
      }
      await alertsApi.dismissTelemetryIssue(dismissing.id, {
        expectedRevision: dismissing.revision,
        reason: reason.trim() || null,
        until: expiresAt?.toISOString() ?? null,
      });
      setDismissing(null);
      setNotice('Issue dismissed. It remains visible here while the condition is firing.');
      await load();
    } catch (err) {
      const staleMessage = err instanceof ApiError && err.status === 409 ? err.message : null;
      if (staleMessage) {
        await load();
        setError(staleMessage);
      } else {
        setError(err instanceof ApiError ? err.message : 'Failed to dismiss telemetry issue');
      }
    } finally {
      setWorkingId(null);
    }
  };

  const resume = async (issue: TelemetryAlertIssue) => {
    setWorkingId(issue.id);
    setError('');
    setNotice('');
    ++requestVersion.current;
    try {
      await alertsApi.resumeTelemetryIssue(issue.id, { expectedRevision: issue.revision });
      setNotice('Issue returned to Active. A notification will be sent after the next successful evaluation confirms it is still firing.');
      await load();
    } catch (err) {
      const staleMessage = err instanceof ApiError && err.status === 409 ? err.message : null;
      if (staleMessage) {
        await load();
        setError(staleMessage);
      } else {
        setError(err instanceof ApiError ? err.message : 'Failed to resume telemetry issue');
      }
    } finally {
      setWorkingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={AlertTriangle}
        title="Telemetry issues"
        description={<>A firing issue continues to be evaluated while dismissed. Dismissal changes notification state only; recovery happens when its condition ends or its rule stops tracking the series.</>}
        actions={<div className="flex gap-2">
          <Link className="btn btn-secondary whitespace-nowrap" to="/administration/alerts">Telemetry rules</Link>
          <Button variant="secondary" onClick={() => void load()} disabled={loading} aria-label="Refresh telemetry issues">
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
          </Button>
        </div>}
      />

      <section className="card overflow-hidden p-0" aria-label="Telemetry issues">
        <div className="flex flex-wrap gap-2 border-b border-gray-200 p-4 dark:border-gray-700" role="group" aria-label="Issue status">
          {ISSUE_TABS.map((tab) => (
            <button
              key={tab.status}
              type="button"
              aria-pressed={status === tab.status}
              className={`rounded-md px-3 py-2 text-sm font-medium ${status === tab.status ? 'bg-robin-orange/10 text-robin-orange' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-robin-gray-800'}`}
              onClick={() => changeStatus(tab.status)}
            >
              {tab.label}
            </button>
          ))}
          <span className="ml-auto self-center text-sm text-gray-500" aria-live="polite">{total} {status} issue{total === 1 ? '' : 's'}</span>
        </div>

        {notice && <p role="status" className="px-4 pt-4 text-sm text-green-700 dark:text-green-300">{notice}</p>}
        {error && !dismissing && <p role="alert" className="px-4 pt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
        {loading ? <div className="flex justify-center p-8"><Spinner label="Loading telemetry issues" /></div> : issues.length === 0 ? (
          <div className="p-8 text-center">
            <BellOff className="mx-auto h-8 w-8 text-gray-400" aria-hidden="true" />
            <p className="mt-3 font-medium">No {status} telemetry issues</p>
            <p className="mt-1 text-sm text-gray-500">
              {status === 'active' ? 'Issues appear when a telemetry rule has fired for a series.' : 'Issues that reach this state will appear here.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            {issues.map((issue) => (
              <article key={issue.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold">{issue.ruleName}</h2>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${issue.severity === 'critical' ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200' : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'}`}>
                        {issue.severity}
                      </span>
                      <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700 dark:bg-robin-gray-800 dark:text-gray-200">
                        {issue.status === 'dismissed' ? 'Dismissed — still firing' : issue.status}
                      </span>
                    </div>
                    <p className="mt-1 break-all font-mono text-sm text-gray-700 dark:text-gray-200">{formatLabels(issue.labels)}</p>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                      Value {formatValue(issue.lastValue)} · {issue.comparator} {issue.threshold}{issue.forSeconds ? ` for ${formatDuration(issue.forSeconds)}` : ''}
                    </p>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      {issue.status === 'resolved' ? `Fired ${formatDate(issue.openedAt)} · resolved ${formatDate(issue.resolvedAt)} (${issue.resolutionReason})`
                        : `Firing since ${formatDate(issue.openedAt)} · last observed ${formatDate(issue.lastSeenAt)}`}
                    </p>
                    {issue.status === 'dismissed' && (
                      <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                        Dismissed by {issue.dismissedBy ?? 'an administrator'} at {formatDate(issue.dismissedAt)}
                        {issue.dismissedUntil ? ` · until ${formatDate(issue.dismissedUntil)}` : ' · until the issue resolves'}
                        {issue.dismissalReason ? ` · ${issue.dismissalReason}` : ''}
                      </p>
                    )}
                    <details className="mt-3">
                      <summary className="cursor-pointer text-sm font-medium text-robin-blue hover:underline">Issue details and history</summary>
                      <div className="mt-3 space-y-3 rounded-lg bg-gray-50 p-3 text-sm dark:bg-robin-gray-800/70">
                        <div>
                          <p className="font-medium">Rule condition</p>
                          <p className="mt-1">{issue.comparator} {issue.threshold}{issue.forSeconds ? ` continuously for ${formatDuration(issue.forSeconds)}` : ''}; last sample {formatValue(issue.lastValue)}.</p>
                          <p className="mt-1 text-gray-600 dark:text-gray-300">Last successful observation: {formatDate(issue.lastSeenAt)}</p>
                        </div>
                        <div>
                          <p className="font-medium">Query snapshot</p>
                          <code className="mt-1 block break-all font-mono text-xs">{issue.query}</code>
                        </div>
                        <ol className="space-y-2 border-t border-gray-200 pt-3 dark:border-gray-700" aria-label="Issue history">
                          {issue.events.map((event) => (
                            <li key={event.id}>
                              <span className="font-medium">{eventLabel(event.eventType)}</span>
                              {' · '}{formatDate(event.occurredAt)}
                              {event.actorName ? ` · ${event.actorName}` : ''}
                              {event.reason ? ` · ${event.reason}` : ''}
                              {event.expiresAt ? ` · dismissal expires ${formatDate(event.expiresAt)}` : ''}
                            </li>
                          ))}
                        </ol>
                        <Link className="inline-flex items-center gap-1 text-robin-blue hover:underline" to={`/telemetry/explore?q=${encodeURIComponent(issue.query)}`}>
                          Explore query <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        </Link>
                      </div>
                    </details>
                  </div>
                  {status === 'active' ? (
                    <Button size="sm" variant="secondary" onClick={() => openDismiss(issue)} disabled={workingId === issue.id} aria-label={`Dismiss ${issue.ruleName} for ${formatLabels(issue.labels)}`}>
                      Dismiss
                    </Button>
                  ) : status === 'dismissed' ? (
                    <Button size="sm" variant="secondary" onClick={() => void resume(issue)} disabled={workingId === issue.id} aria-label={`Undo dismissal for ${issue.ruleName} on ${formatLabels(issue.labels)}`}>
                      Undo dismissal
                    </Button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-gray-200 px-4 py-3 dark:border-gray-700">
            <Button size="sm" variant="secondary" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0 || loading}>Previous</Button>
            <span className="text-sm text-gray-500">Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}</span>
            <Button size="sm" variant="secondary" onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total || loading}>Next</Button>
          </div>
        )}
      </section>

      <Modal isOpen={dismissing !== null} onClose={() => setDismissing(null)} title="Dismiss telemetry issue" size="md">
        {dismissing && (
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void dismiss(); }}>
            <p className="text-sm text-gray-700 dark:text-gray-200">
              {dismissing.ruleName} · {formatLabels(dismissing.labels)} remains active and continues to be evaluated. Dismissal only pauses notifications for this firing occurrence.
            </p>
            <Input label="Reason (optional)" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={hasExpiry} onChange={(event) => setHasExpiry(event.target.checked)} />
              Resume notifications at a specific time
            </label>
            {hasExpiry && (
              <Input
                label="Resume at (your local time)"
                type="datetime-local"
                value={until}
                min={localDateTimeValue(new Date())}
                onChange={(event) => setUntil(event.target.value)}
                required
              />
            )}
            <p className="text-xs text-gray-500 dark:text-gray-400">If no time is selected, the issue stays dismissed until it resolves.</p>
            {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setDismissing(null)}>Cancel</Button>
              <Button type="submit" disabled={workingId !== null}>Dismiss issue</Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
