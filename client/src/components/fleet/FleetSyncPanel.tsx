import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { fleetSyncApi } from '../../api/client';
import { Button } from '../ui/Button';
import type {
  FleetServiceApplyStatus,
  FleetServiceSyncLogEntry,
  FleetServiceSyncStatus,
  FleetSyncLogEventType,
} from '../../types';

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 12) : '—';
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const STATUS_CLASS: Record<FleetServiceApplyStatus, string> = {
  succeeded: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  unknown: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

const EVENT_CLASS: Record<FleetSyncLogEventType, string> = {
  registered: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  manifest_pulled: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
  apply_started: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  apply_succeeded: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  apply_failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  sync_requested: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
};

export function FleetSyncPanel({ serviceId }: { serviceId: string }) {
  const [status, setStatus] = useState<FleetServiceSyncStatus | null>(null);
  const [log, setLog] = useState<FleetServiceSyncLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fleetSyncApi.getSync(serviceId);
      setStatus(res.data?.status ?? null);
      setLog(res.data?.log ?? []);
    } catch {
      setError('Failed to load sync status');
    } finally {
      setLoading(false);
    }
  }, [serviceId]);

  useEffect(() => { void load(); }, [load]);

  const forceSync = async () => {
    setSyncing(true);
    setError('');
    try {
      await fleetSyncApi.requestSync(serviceId);
      await load();
    } catch {
      setError('Failed to request sync');
    } finally {
      setSyncing(false);
    }
  };

  const inSync = Boolean(
    status
    && status.lastApplyStatus === 'succeeded'
    && status.lastAppliedSha256
    && status.lastAppliedSha256 === status.manifestSha256
  );
  const neverSynced = !status || !status.lastSeenAt;

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50/60 p-4 dark:border-robin-gray-700 dark:bg-robin-gray-900/40">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Config sync</h3>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button size="sm" variant="primary" onClick={() => void forceSync()} disabled={syncing}>
            <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Requesting…' : 'Sync now'}
          </Button>
        </div>
      </div>

      {error && <div className="mb-3 rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/10 dark:text-red-300">{error}</div>}

      {neverSynced ? (
        <div className="rounded-sm border border-dashed border-gray-300 px-3 py-4 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
          Its agent hasn't synced this service yet. It pulls the config on its next cycle (every 30s) once it's online.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[status!.lastApplyStatus]}`}>
              {status!.lastApplyStatus}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${inSync ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'}`}>
              {inSync ? 'in sync' : 'drift / pending'}
            </span>
            {status!.agentVersion && <span className="text-xs text-gray-500 dark:text-gray-400">agent v{status!.agentVersion}</span>}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 sm:text-right">
            seen {relTime(status!.lastSeenAt)} · applied {relTime(status!.lastApplyFinishedAt)}
          </div>
          <div className="text-xs text-gray-600 dark:text-gray-300">
            manifest <span className="font-mono">{shortSha(status!.manifestSha256)}</span> · {status!.manifestFileCount ?? 0} files
          </div>
          <div className="text-xs text-gray-600 dark:text-gray-300 sm:text-right">
            applied <span className="font-mono">{shortSha(status!.lastAppliedSha256)}</span>
          </div>
          {status!.lastApplyError && (
            <div className="sm:col-span-2 rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/10 dark:text-red-300">
              {status!.lastApplyError}
            </div>
          )}
        </div>
      )}

      {/* Audit log */}
      <div className="mt-4">
        <div className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Sync audit log</div>
        <div className="overflow-x-auto rounded-sm border border-gray-200 dark:border-robin-gray-700">
          <table className="w-full text-xs">
            <thead className="bg-gray-100 dark:bg-robin-gray-800">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">When</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">Event</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">Applied</th>
                <th className="px-3 py-2 text-right font-medium text-gray-500 dark:text-gray-400">Files</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-robin-gray-700">
              {log.length === 0 ? (
                <tr><td colSpan={5} className="px-3 py-4 text-center text-gray-500 dark:text-gray-400">No sync events yet.</td></tr>
              ) : log.map((entry) => (
                <tr key={entry.id}>
                  <td className="px-3 py-2 text-gray-600 dark:text-gray-300" title={entry.createdAt}>{relTime(entry.createdAt)}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 font-medium ${EVENT_CLASS[entry.eventType]}`}>{entry.eventType}</span>
                  </td>
                  <td className="px-3 py-2 font-mono text-gray-600 dark:text-gray-300">{shortSha(entry.appliedSha256 ?? entry.manifestSha256)}</td>
                  <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-300">{entry.fileCount ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{entry.message ?? (entry.agentVersion ? `agent v${entry.agentVersion}` : '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
