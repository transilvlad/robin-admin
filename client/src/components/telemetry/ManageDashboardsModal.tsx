/**
 * Organise dashboards: order them, delete them, create a blank one, import a
 * JSON export, or explicitly add an optional exporter template.
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, FilePlus, Plus, Trash2, Upload } from 'lucide-react';
import { ApiError, telemetryApi } from '../../api/client';
import { Modal } from '../ui/Modal';
import type { TelemetryDashboardContent, TelemetryDashboardSummary, TelemetryTemplate } from '../../types/telemetry';
import { parseImport } from '../../utils/telemetryDashboard';

interface ManageDashboardsModalProps {
  dashboards: TelemetryDashboardSummary[];
  confirm: (message: string) => Promise<boolean>;
  /** The list changed on the server; reload it. `openUid` selects a new dashboard. */
  onChanged: (openUid?: string) => void;
  onNew: () => void;
  onClose: () => void;
}

export function ManageDashboardsModal({ dashboards, confirm, onChanged, onNew, onClose }: ManageDashboardsModalProps) {
  const [order, setOrder] = useState(dashboards);
  const [templates, setTemplates] = useState<TelemetryTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setOrder(dashboards), [dashboards]);
  useEffect(() => {
    telemetryApi.templates().then((response) => setTemplates(response.data ?? [])).catch(() => setTemplates([]));
  }, []);

  const run = async (work: () => Promise<string | undefined>) => {
    setBusy(true);
    setError(null);
    try {
      const openUid = await work();
      onChanged(openUid);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, delta: -1 | 1) => {
    const next = [...order];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    setOrder(next);
    void run(async () => {
      await telemetryApi.reorderDashboards(next.map((dashboard) => dashboard.uid));
      return undefined;
    });
  };

  const remove = (dashboard: TelemetryDashboardSummary) => {
    void confirm(`Delete the dashboard "${dashboard.title}"? Its version history is deleted too.`).then((ok) => {
      if (!ok) return;
      void run(async () => {
        await telemetryApi.deleteDashboard(dashboard.uid);
        return undefined;
      });
    });
  };

  const importFile = (file: File) => {
    void run(async () => {
      const content: TelemetryDashboardContent = parseImport(await file.text());
      const created = await telemetryApi.createDashboard(content);
      return created.data?.uid;
    });
  };

  const installed = new Set(dashboards.map((dashboard) => dashboard.templateKey).filter(Boolean));

  return (
    <Modal isOpen onClose={onClose} title="Manage dashboards" size="lg">
      <div className="space-y-6">
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary px-3 py-1.5 text-sm" onClick={onNew} disabled={busy}>
            <FilePlus aria-hidden="true" className="h-4 w-4" />
            New dashboard
          </button>
          <button type="button" className="btn btn-secondary px-3 py-1.5 text-sm" onClick={() => fileRef.current?.click()} disabled={busy}>
            <Upload aria-hidden="true" className="h-4 w-4" />
            Import JSON
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="Dashboard JSON file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) importFile(file);
            }}
          />
        </div>
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <section>
          <h3 className="mb-2 text-sm font-semibold">Dashboards</h3>
          {order.length === 0 && <p className="text-sm text-gray-500 dark:text-gray-400">No dashboards yet.</p>}
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-robin-gray-700 dark:border-robin-gray-700">
            {order.map((dashboard, index) => (
              <li key={dashboard.uid} className="flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{dashboard.title}</div>
                  {dashboard.description && <div className="truncate text-xs text-gray-500 dark:text-gray-400">{dashboard.description}</div>}
                </div>
                <button type="button" className="rounded-sm p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30 dark:hover:bg-robin-gray-700" disabled={busy || index === 0} onClick={() => move(index, -1)} aria-label={`Move ${dashboard.title} up`} title="Move up">
                  <ArrowUp className="h-4 w-4" />
                </button>
                <button type="button" className="rounded-sm p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30 dark:hover:bg-robin-gray-700" disabled={busy || index === order.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${dashboard.title} down`} title="Move down">
                  <ArrowDown className="h-4 w-4" />
                </button>
                <button type="button" className="rounded-sm p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-robin-gray-700" disabled={busy} onClick={() => remove(dashboard)} aria-label={`Delete ${dashboard.title}`} title="Delete">
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="mb-1 text-sm font-semibold">Optional templates</h3>
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-robin-gray-700 dark:border-robin-gray-700">
            {templates.map((template) => (
              <li key={template.key} className="flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {template.title}
                    {installed.has(template.key) && <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">Added</span>}
                  </div>
                  <div className="truncate text-xs text-gray-500 dark:text-gray-400">{template.description}</div>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary px-3 py-1 text-sm"
                  disabled={busy}
                  onClick={() => void run(async () => (await telemetryApi.createDashboard({ templateKey: template.key })).data?.uid)}
                >
                  <Plus aria-hidden="true" className="h-4 w-4" />
                  {installed.has(template.key) ? 'Add again' : 'Add'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Modal>
  );
}
