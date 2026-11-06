import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, ChevronDown, HardDrive, RefreshCw, RotateCcw, Rows3, Settings, Trash2 } from 'lucide-react';
import { ApiError, logsApi } from '../api/client';
import { MetricCard } from '../components/ui/MetricCard';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { useConfirm } from '../context/ConfirmContext';
import { appIcons } from '../constants/appIcons';
import type { LogsStoreStatus, RejectedLogsBatch } from '../types';
import { formatBytes as formatByteSize } from '../utils/format';

function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return 'Unavailable';
  return formatByteSize(bytes);
}

function formatDate(value: string | null, empty: string): string {
  if (!value) return empty;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function LogsHealthPage() {
  const [status, setStatus] = useState<LogsStoreStatus | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [quarantine, setQuarantine] = useState<RejectedLogsBatch[]>([]);
  const [quarantineError, setQuarantineError] = useState('');
  const [quarantineBusy, setQuarantineBusy] = useState('');
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null);
  const [batchEntries, setBatchEntries] = useState<Record<string, unknown>[] | null>(null);
  const inspectionRequest = useRef(0);
  const confirm = useConfirm();
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await logsApi.status();
      setStatus(response.data ?? null);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load Logs health');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadQuarantine = useCallback(async () => {
    try {
      const response = await logsApi.listQuarantined();
      setQuarantine(response.data ?? []);
      setQuarantineError('');
    } catch (err) {
      setQuarantineError(err instanceof ApiError ? err.message : 'Failed to load quarantined batches');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadQuarantine(); }, [loadQuarantine]);
  useEffect(() => {
    const timer = window.setInterval(() => { void load(); void loadQuarantine(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [load, loadQuarantine]);
  useEffect(() => () => { inspectionRequest.current += 1; }, []);

  const usagePercent = status?.storageBytes !== null && status?.storageBytes !== undefined
    && status.maxDiskBytes !== null && status.maxDiskBytes > 0
    ? Math.min(100, status.storageBytes / status.maxDiskBytes * 100)
    : null;
  const queueUsage = status && status.write.capacityBytes > 0 ? status.write.usedBytes / status.write.capacityBytes * 100 : 0;
  const warnings = [
    status && !status.enabled ? 'Logs are disabled. Enable them under Administration → Logs.' : '',
    status && !status.reachable ? `VictoriaLogs is unreachable${status.error ? `: ${status.error}` : ''}.` : '',
    usagePercent !== null && usagePercent >= 80 ? 'Data is at least 80% of the configured VictoriaLogs cap. Keep at least 20% free space on its volume for compaction.' : '',
    status?.write.droppedLines24h ? `${status.write.droppedLines24h.toLocaleString()} Fleet log lines were not kept in the last 24 hours because the ingestion queue was full.` : '',
    status?.write.discardedLines24h ? `${status.write.discardedLines24h.toLocaleString()} rejected log lines were explicitly discarded in the last 24 hours.` : '',
    status?.write.rejectedLines24h ? `${status.write.rejectedLines24h.toLocaleString()} queued lines were refused by VictoriaLogs in the last 24 hours; check the last delivery error below.` : '',
    status?.write.quarantinedBatches ? `${status.write.quarantinedBatches.toLocaleString()} rejected batches remain quarantined and use queue capacity. Retry them after resolving the store error, or explicitly discard them.` : '',
    status?.write.uncertainBatches ? `${status.write.uncertainBatches.toLocaleString()} queued batches have uncertain store outcomes. Retrying them can create duplicate lines.` : '',
    status?.write.uncertainDeliveries24h ? `${status.write.uncertainDeliveries24h.toLocaleString()} batches had uncertain store outcomes in the last 24 hours. Duplicates may appear in search results and alert counts.` : '',
    queueUsage >= 80 ? 'The ingestion queue is at least 80% full. Fleet batches are asked to retry and external senders receive 503 responses.' : '',
    status?.metrics.rowsDroppedTotal ? `${status.metrics.rowsDroppedTotal.toLocaleString()} rows have been dropped by VictoriaLogs since its last restart.` : '',
  ].filter(Boolean);

  async function inspectBatch(id: string) {
    const request = ++inspectionRequest.current;
    setQuarantineError('');
    if (selectedBatch === id) {
      setSelectedBatch(null);
      setBatchEntries(null);
      return;
    }
    setSelectedBatch(id);
    setBatchEntries(null);
    try {
      const response = await logsApi.getQuarantined(id);
      if (inspectionRequest.current !== request) return;
      setBatchEntries(response.data ?? []);
    } catch (err) {
      if (inspectionRequest.current !== request) return;
      setSelectedBatch(null);
      setBatchEntries(null);
      setQuarantineError(err instanceof ApiError ? err.message : 'Failed to inspect quarantined batch');
    }
  }

  async function retryBatch(batch: RejectedLogsBatch) {
    if (selectedBatch === batch.id) {
      inspectionRequest.current += 1;
      setSelectedBatch(null);
      setBatchEntries(null);
    }
    setQuarantineError('');
    setQuarantineBusy(batch.id);
    try {
      await logsApi.retryQuarantined(batch.id);
      await Promise.all([load(), loadQuarantine()]);
    } catch (err) {
      setQuarantineError(err instanceof ApiError ? err.message : 'Failed to retry quarantined batch');
    } finally {
      setQuarantineBusy('');
    }
  }

  async function discardBatch(batch: RejectedLogsBatch) {
    if (!(await confirm(`Discard ${batch.lineCount} log lines in rejected batch ${batch.id}? This permanently removes them from quarantine.`))) return;
    setQuarantineBusy(batch.id);
    try {
      await logsApi.discardQuarantined(batch.id);
      inspectionRequest.current += 1;
      setSelectedBatch(null);
      setBatchEntries(null);
      await Promise.all([load(), loadQuarantine()]);
    } catch (err) {
      setQuarantineError(err instanceof ApiError ? err.message : 'Failed to discard quarantined batch');
    } finally {
      setQuarantineBusy('');
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader icon={appIcons.metrics} title="Logs health" description="VictoriaLogs availability, stored data, ingestion, and Robin Admin's ingestion queue." actions={<div className="flex gap-2">
        <button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={loading} title="Refresh Logs health" aria-label="Refresh Logs health"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" /></button>
        <Link className="btn btn-secondary" to="/administration/logs" title="Logs settings" aria-label="Logs settings"><Settings className="h-4 w-4" aria-hidden="true" /></Link>
      </div>} />
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!status ? (!error && <div className="flex justify-center p-8"><Spinner label="Loading Logs health" /></div>) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricCard icon={<Activity className="h-5 w-5" />} label="Store" value={status.reachable ? 'Reachable' : 'Unavailable'} sub={status.reachable ? 'VictoriaLogs responding' : status.error} tone={status.reachable ? 'success' : 'warning'} />
            <MetricCard icon={<HardDrive className="h-5 w-5" />} label="VictoriaLogs data" value={formatBytes(status.storageBytes)} sub={status.maxDiskBytes === null ? 'No data cap reported' : `Cap ${formatBytes(status.maxDiskBytes)}${usagePercent === null ? '' : ` · ${usagePercent.toFixed(0)}% used`}`} tone={usagePercent !== null && usagePercent >= 80 ? 'warning' : 'neutral'} />
            <MetricCard icon={<Rows3 className="h-5 w-5" />} label="Stored logs · 24h" value={status.rowsIngested24h === null ? 'Unavailable' : status.rowsIngested24h.toLocaleString()} sub={`Configured retention ${status.retentionDays} days`} />
            <MetricCard icon={<Rows3 className="h-5 w-5" />} label="Ingestion queue" value={`${status.write.queuedLines.toLocaleString()} lines`} sub={`${formatBytes(status.write.usedBytes)} of ${formatBytes(status.write.capacityBytes)}${status.write.retryingBatches ? ` · ${status.write.retryingBatches.toLocaleString()} retrying` : ''}${status.write.quarantinedBatches ? ` · ${status.write.quarantinedBatches} quarantined` : ''}`} tone={queueUsage >= 80 || status.write.retryingBatches || status.write.droppedLines24h || status.write.quarantinedBatches ? 'warning' : 'neutral'} />
          </div>
          {warnings.map((warning) => <p key={warning} role="status" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{warning}</p>)}
          {quarantine.length > 0 && <section className="card" aria-labelledby="logs-quarantine-title">
            <div className="card-header"><h2 id="logs-quarantine-title" className="card-title">Rejected batches</h2><p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Retained within queue capacity until retried or explicitly discarded.</p></div>
            <div className="divide-y divide-gray-200 dark:divide-gray-700">
              {quarantine.map((batch) => <div key={batch.id} className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{batch.lineCount.toLocaleString()} lines · {batch.origin} · batch {batch.id}</p>
                    <p className="mt-1 break-words text-sm text-red-700 dark:text-red-300">{batch.error || 'Store rejected the batch'}</p>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{formatBytes(batch.bytes)} · {formatDate(batch.createdAt, '')}</p>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" className="btn btn-secondary" disabled={Boolean(quarantineBusy)} onClick={() => void inspectBatch(batch.id)}><ChevronDown className="h-4 w-4" aria-hidden="true" />{selectedBatch === batch.id ? 'Hide lines' : 'Inspect'}</button>
                    <button type="button" className="btn btn-secondary" disabled={Boolean(quarantineBusy)} onClick={() => void retryBatch(batch)}><RotateCcw className="h-4 w-4" aria-hidden="true" />{quarantineBusy === batch.id ? 'Working…' : 'Retry'}</button>
                    <button type="button" className="btn btn-secondary" disabled={Boolean(quarantineBusy)} onClick={() => void discardBatch(batch)} aria-label={`Discard batch ${batch.id}`}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
                  </div>
                </div>
                {selectedBatch === batch.id && <pre className="max-h-72 overflow-auto rounded bg-gray-50 p-3 text-xs dark:bg-robin-gray-800">{batchEntries ? JSON.stringify(batchEntries, null, 2) : 'Loading batch…'}</pre>}
              </div>)}
            </div>
          </section>}
          {quarantineError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{quarantineError}</p>}
          <section className="card" aria-labelledby="logs-health-details-title">
            <div className="card-header"><h2 id="logs-health-details-title" className="card-title">Storage and ingestion details</h2></div>
            <div className="card-body space-y-4">
            <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <div><dt className="text-xs text-gray-500 dark:text-gray-400">Oldest stored log</dt><dd className="mt-0.5 font-medium">{formatDate(status.oldestLogAt, status.rowsIngested24h === 0 && status.storageBytes === 0 ? 'No stored logs' : 'Unavailable')}</dd></div>
              <div><dt className="text-xs text-gray-500 dark:text-gray-400">Rows ingested since VictoriaLogs restart</dt><dd className="mt-0.5 font-medium tabular-nums">{status.metrics.rowsIngestedTotal?.toLocaleString() ?? 'Unavailable'}</dd></div>
              <div><dt className="text-xs text-gray-500 dark:text-gray-400">Bytes ingested since VictoriaLogs restart</dt><dd className="mt-0.5 font-medium tabular-nums">{formatBytes(status.metrics.bytesIngestedTotal)}</dd></div>
              <div><dt className="text-xs text-gray-500 dark:text-gray-400">Streams created since VictoriaLogs restart</dt><dd className="mt-0.5 font-medium tabular-nums">{status.metrics.streamsCreatedTotal?.toLocaleString() ?? 'Unavailable'}</dd></div>
              <div><dt className="text-xs text-gray-500 dark:text-gray-400">Oldest queued line</dt><dd className="mt-0.5 font-medium">{formatDate(status.write.oldestQueuedAt, 'Queue empty')}</dd></div>
              <div><dt className="text-xs text-gray-500 dark:text-gray-400">Last delivery to VictoriaLogs</dt><dd className="mt-0.5 font-medium">{formatDate(status.write.lastDeliveredAt, 'Never')}</dd></div>
              <div><dt className="text-xs text-gray-500 dark:text-gray-400">Last delivery error</dt><dd className="mt-0.5 break-words font-medium">{status.write.lastError ? `${status.write.lastError}${status.write.lastErrorAt ? ` (${formatDate(status.write.lastErrorAt, '')})` : ''}` : 'None'}</dd></div>
            </dl>
            <p className="border-t border-gray-200 pt-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
              VictoriaLogs data size is not the same as physical volume usage. Monitor free space on the host volume separately; compaction requires disk headroom. Retention and the disk cap are deployment settings, shown under <Link className="text-robin-orange hover:underline" to="/administration/logs?tab=storage">Logs settings</Link>.
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Delivery retries are at least once. A timed-out store write can still complete after a retry and produce duplicate lines, even when the queue has recovered.
            </p>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
