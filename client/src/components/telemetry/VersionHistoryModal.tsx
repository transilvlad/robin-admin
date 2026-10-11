import { useEffect, useState } from 'react';
import { Eye, RotateCcw } from 'lucide-react';
import { ApiError, telemetryApi } from '../../api/client';
import { Modal } from '../ui/Modal';
import { Spinner } from '../ui/Spinner';
import type { TelemetryDashboard, TelemetryDashboardVersion } from '../../types/telemetry';
import { contentOf, diffDashboards } from '../../utils/telemetryDashboard';

interface VersionHistoryModalProps {
  dashboard: TelemetryDashboard;
  canRestore: boolean;
  confirm: (message: string) => Promise<boolean>;
  onRestored: (dashboard: TelemetryDashboard) => void;
  onClose: () => void;
}

/** The last saved versions of a dashboard, any of which can be restored as a new version. */
export function VersionHistoryModal({ dashboard, canRestore, confirm, onRestored, onClose }: VersionHistoryModalProps) {
  const [versions, setVersions] = useState<TelemetryDashboardVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ version: number; changes: string[] } | null>(null);

  const view = (version: TelemetryDashboardVersion) => {
    if (viewing?.version === version.version) {
      setViewing(null);
      return;
    }
    telemetryApi.version(dashboard.uid, version.version)
      .then((response) => {
        if (response.data) setViewing({ version: version.version, changes: diffDashboards(contentOf(dashboard), response.data).changes });
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Failed to load the version'));
  };

  useEffect(() => {
    telemetryApi.versions(dashboard.uid)
      .then((response) => setVersions(response.data ?? []))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Failed to load versions'));
  }, [dashboard.uid, dashboard.version]);

  const restore = (version: TelemetryDashboardVersion) => {
    void confirm(`Restore version ${version.version}? It is saved as a new version; nothing is lost.`).then((ok) => {
      if (!ok) return;
      telemetryApi.restoreVersion(dashboard.uid, version.version)
        .then((response) => {
          if (response.data) onRestored(response.data);
        })
        .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Restore failed'));
    });
  };

  return (
    <Modal isOpen onClose={onClose} title={`History of ${dashboard.title}`}>
      {error && <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!versions ? (
        <div className="flex justify-center py-8"><Spinner label="Loading versions" /></div>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-robin-gray-700">
          {versions.map((version) => (
            <li key={version.version} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-0 flex-1 text-sm">
                <div className="font-medium">
                  Version {version.version}
                  {version.version === dashboard.version && <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">Current</span>}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {new Date(version.savedAt).toLocaleString()} · {version.savedBy ?? 'Installed by Robin Admin'} · {version.title}
                </div>
              </div>
              {version.version !== dashboard.version && (
                <button type="button" className="btn btn-secondary px-3 py-1 text-sm" aria-expanded={viewing?.version === version.version} onClick={() => view(version)}>
                  <Eye aria-hidden="true" className="h-4 w-4" />
                  View
                </button>
              )}
              {canRestore && version.version !== dashboard.version && (
                <button type="button" className="btn btn-secondary px-3 py-1 text-sm" onClick={() => restore(version)}>
                  <RotateCcw aria-hidden="true" className="h-4 w-4" />
                  Restore
                </button>
              )}
              {viewing?.version === version.version && (
                <div className="mt-2 w-full rounded-lg bg-gray-50 p-3 text-sm dark:bg-robin-gray-900">
                  <p className="mb-1 font-medium">Restoring version {version.version} would change:</p>
                  {viewing.changes.length === 0 ? (
                    <p className="text-gray-500 dark:text-gray-400">Nothing; it matches the current version.</p>
                  ) : (
                    <ul className="list-disc space-y-0.5 pl-5 text-gray-600 dark:text-gray-300">
                      {viewing.changes.map((change) => <li key={change}>{change}</li>)}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">The last 20 versions are kept.</p>
    </Modal>
  );
}
