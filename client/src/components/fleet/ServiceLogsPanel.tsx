import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, ScrollText } from 'lucide-react';
import { configApi, logsApi } from '../../api/client';
import { Button } from '../ui/Button';
import type { FleetServiceType, ServiceLogs } from '../../types';

const LINE_OPTIONS = [100, 200, 500, 1000];

/**
 * Recent-logs viewer for a co-located fleet service. Reads via the shared
 * `/api/logs` endpoint (journald → log file). Shows a clear "unavailable"
 * state when robin-admin is not co-located with the service.
 */
export function ServiceLogsPanel({ serviceType, serviceId }: { serviceType: FleetServiceType; serviceId: string | undefined }) {
  const [logs, setLogs] = useState<ServiceLogs | null>(null);
  const [lines, setLines] = useState(200);
  const [lineOptions, setLineOptions] = useState(LINE_OPTIONS);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);
  // The selected service can change while a request is in flight (the page
  // selector switches to a service that has logs); only the newest one lands.
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    if (!serviceId) {
      setLogs(null);
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      const response = await logsApi.get(serviceType, serviceId, lines);
      if (request === requestRef.current) setLogs(response.data ?? null);
    } catch (err) {
      if (request === requestRef.current) setError(err instanceof Error ? err.message : 'Failed to load logs');
    } finally {
      if (request === requestRef.current) setIsLoading(false);
    }
  }, [serviceType, serviceId, lines]);

  useEffect(() => {
    configApi.get()
      .then((response) => {
        const config = response.data;
        if (!config) return;
        const max = Math.max(config.logDefaultLines, config.logMaxLines);
        const options = [...new Set([...LINE_OPTIONS, config.logDefaultLines, max])]
          .filter((value) => value > 0 && value <= max)
          .sort((a, b) => a - b);
        setLineOptions(options);
        setLines(config.logDefaultLines);
      })
      .catch(() => {
        setLineOptions(LINE_OPTIONS);
      });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  return (
    <div className="card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ScrollText className="h-5 w-5 text-gray-500" />
          <h2 className="text-lg font-semibold">Recent logs</h2>
          {logs?.source && (
            <span className="rounded-full bg-gray-100 px-2.5 py-0.5 font-mono text-xs text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300">
              {logs.source}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(event) => setAutoScroll(event.target.checked)}
              className="h-4 w-4 accent-robin-orange"
            />
            Auto-scroll to latest
          </label>
          <label className="text-sm text-gray-500 dark:text-gray-400">
            Lines
            <select
              value={lines}
              onChange={(event) => setLines(Number(event.target.value))}
              className="ml-2 rounded-md border border-gray-200 bg-white px-2 py-1 text-sm dark:border-robin-gray-700 dark:bg-robin-gray-800"
            >
              {lineOptions.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <Button variant="secondary" onClick={() => void load()} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

      {!error && logs && !logs.available && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-200">
          {logs.error ?? 'Logs are unavailable for this service in the current environment.'}
        </div>
      )}

      {!error && logs?.available && (
        logs.lines.length === 0 ? (
          <div className="text-sm text-gray-500 dark:text-gray-400">No recent log lines.</div>
        ) : (
          <pre ref={logRef} className="h-[calc(100vh-16rem)] min-h-112 overflow-auto rounded-lg bg-gray-950 p-4 text-xs leading-relaxed text-gray-100">
            {logs.lines.join('\n')}
          </pre>
        )
      )}

      {!logs && !error && !isLoading && (
        <div className="text-sm text-gray-500 dark:text-gray-400">Select a service to view its logs.</div>
      )}
    </div>
  );
}
