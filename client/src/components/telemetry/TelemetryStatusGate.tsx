import { useEffect, useState, type ReactNode } from 'react';
import { DatabaseZap, ServerOff } from 'lucide-react';
import { ApiError, telemetryApi } from '../../api/client';
import type { TelemetryStatus } from '../../types/telemetry';
import { Spinner } from '../ui/Spinner';
import { formatSpan } from '../../utils/telemetry';
import { Link } from 'react-router-dom';

function Notice({ icon: Icon, title, children }: { icon: typeof ServerOff; title: string; children: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-3 p-10 text-center">
      <Icon aria-hidden="true" className="h-8 w-8 text-gray-400" />
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="max-w-xl text-sm text-gray-500 dark:text-gray-400">{children}</div>
    </div>
  );
}

/**
 * Renders children once the Telemetry store is configured and reachable;
 * otherwise explains what is missing. Discovery never gates historical queries.
 */
export function TelemetryStatusGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-check on a timer so the page recovers by itself when the store comes back.
  const healthy = Boolean(status?.configured && status.reachable);
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      telemetryApi.status()
        .then((response) => {
          if (cancelled) return;
          setStatus(response.data ?? null);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load Telemetry status');
        });
    };
    if (status === null) check();
    const timer = window.setInterval(check, healthy ? 60_000 : 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // Only the polling interval depends on the result.
  }, [healthy]);

  // A failed re-check keeps the last known status on screen.
  if (error && !status) return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!status) return <div className="flex justify-center py-16"><Spinner label="Loading telemetry" /></div>;
  if (!status.configured) {
    return (
      <Notice icon={DatabaseZap} title="No Telemetry store configured">
        <Link to="/administration/telemetry?tab=connection" className="text-robin-blue hover:underline">Store settings</Link>
      </Notice>
    );
  }
  if (!status.reachable) {
    return (
      <Notice icon={ServerOff} title="Telemetry store unreachable">
        Robin Admin cannot reach the configured store. Check that it is running and that the server can connect to it.
        This page checks again every 15 seconds.
        <p className="mt-3"><Link to="/administration/telemetry?tab=connection" className="text-robin-blue hover:underline">Store settings</Link></p>
      </Notice>
    );
  }
  return (
    <>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {status.sources.length === 0 && (
        <div role="status" className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600 dark:border-robin-gray-700 dark:bg-robin-gray-800 dark:text-gray-300">
          No matching source has sent metrics in the last {formatSpan(status.silentAfterSeconds)}. Older data is still available.
        </div>
      )}
      {children}
    </>
  );
}
