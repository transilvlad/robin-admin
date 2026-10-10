/**
 * Turn Explore queries into a panel on a dashboard: pick the dashboard and
 * row (or a new row), name the panel, and save.
 */

import { useEffect, useState } from 'react';
import { ApiError, telemetryApi } from '../../api/client';
import { Modal } from '../ui/Modal';
import { Spinner } from '../ui/Spinner';
import {
  PANEL_TYPES,
  type TelemetryDashboard,
  type TelemetryDashboardSummary,
  type TelemetryPanelType,
  type TelemetryUnit,
} from '../../types/telemetry';
import { addRow, blankPanel, contentOf, upsertPanel } from '../../utils/telemetryDashboard';

const NEW_ROW = '__new__';
const NEW_DASHBOARD = '__new_dashboard__';
const TYPE_LABELS: Record<TelemetryPanelType, string> = { timeseries: 'Time series', stat: 'Stat', table: 'Table' };

interface AddToDashboardModalProps {
  queries: string[];
  unit: TelemetryUnit;
  onAdded: (uid: string) => void;
  onClose: () => void;
}

export function AddToDashboardModal({ queries, unit, onAdded, onClose }: AddToDashboardModalProps) {
  const [summaries, setSummaries] = useState<TelemetryDashboardSummary[] | null>(null);
  const [uid, setUid] = useState('');
  const [dashboardTitle, setDashboardTitle] = useState('');
  const [dashboard, setDashboard] = useState<TelemetryDashboard | null>(null);
  const [rowId, setRowId] = useState(NEW_ROW);
  const [rowTitle, setRowTitle] = useState('From Explore');
  const [title, setTitle] = useState('New panel');
  const [type, setType] = useState<TelemetryPanelType>('timeseries');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    telemetryApi.dashboards()
      .then((response) => {
        if (cancelled) return;
        const list = response.data ?? [];
        setSummaries(list);
        setUid(list.length === 0 ? NEW_DASHBOARD : '');
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load dashboards'); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setDashboard(null);
    setRowId(NEW_ROW);
    setError(null);
    if (!uid || uid === NEW_DASHBOARD) return;
    let cancelled = false;
    telemetryApi.dashboard(uid)
      .then((response) => {
        if (cancelled) return;
        setDashboard(response.data ?? null);
        setRowId(response.data?.rows[0]?.id ?? NEW_ROW);
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load the dashboard'); });
    return () => { cancelled = true; };
  }, [uid]);

  const creating = uid === NEW_DASHBOARD;
  const ready = creating ? Boolean(dashboardTitle.trim()) : Boolean(dashboard && dashboard.uid === uid);
  const add = async () => {
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      let content = creating ? { title: dashboardTitle.trim(), description: '', variables: [], rows: [] } : contentOf(dashboard!);
      let targetRow = rowId;
      if (rowId === NEW_ROW) {
        content = addRow(content, rowTitle.trim() || 'From Explore');
        targetRow = content.rows[content.rows.length - 1].id;
      }
      const row = content.rows.find((candidate) => candidate.id === targetRow)!;
      const panel = { ...blankPanel(row, type), title: title.trim() || 'New panel', unit, queries: queries.map((expr) => ({ expr })) };
      content = upsertPanel(content, targetRow, panel);
      if (creating) {
        const response = await telemetryApi.createDashboard(content);
        if (!response.data) throw new Error('Dashboard was not returned');
        onAdded(response.data.uid);
      } else {
        await telemetryApi.saveDashboard(dashboard!.uid, content, dashboard!.version);
        onAdded(dashboard!.uid);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add the panel');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Add to dashboard">
      {error && <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!summaries ? (
        <div className="flex justify-center py-8"><Spinner label="Loading dashboards" /></div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <label className="block text-sm">
            <span className="form-label">Dashboard</span>
            <select className="input" value={uid} onChange={(event) => setUid(event.target.value)} disabled={saving}>
              <option value="" disabled>Select dashboard</option>
              {summaries.map((summary) => <option key={summary.uid} value={summary.uid}>{summary.title}</option>)}
              <option value={NEW_DASHBOARD}>New dashboard</option>
            </select>
          </label>
          {creating && <label className="block text-sm">
            <span className="form-label">Dashboard title</span>
            <input className="input" value={dashboardTitle} maxLength={120} onChange={(event) => setDashboardTitle(event.target.value)} required disabled={saving} />
          </label>}
          <label className="block text-sm">
            <span className="form-label">Row</span>
            <select className="input" value={rowId} onChange={(event) => setRowId(event.target.value)} disabled={(!dashboard && !creating) || saving}>
              {dashboard?.rows.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
              <option value={NEW_ROW}>New row…</option>
            </select>
          </label>
          {rowId === NEW_ROW && (
            <label className="block text-sm">
              <span className="form-label">New row title</span>
              <input className="input" value={rowTitle} maxLength={80} onChange={(event) => setRowTitle(event.target.value)} />
            </label>
          )}
          <label className="block text-sm">
            <span className="form-label">Panel title</span>
            <input className="input" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} required />
          </label>
          <label className="block text-sm">
            <span className="form-label">Visualisation</span>
            <select className="input" value={type} onChange={(event) => setType(event.target.value as TelemetryPanelType)}>
              {PANEL_TYPES.map((option) => <option key={option} value={option}>{TYPE_LABELS[option]}</option>)}
            </select>
          </label>
          <ul className="space-y-1">
            {queries.map((query) => <li key={query} className="break-all rounded-sm bg-gray-50 p-2 font-mono text-xs text-gray-600 dark:bg-robin-gray-900 dark:text-gray-300">{query}</li>)}
          </ul>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={!ready || saving || !title.trim()}>{saving ? 'Adding…' : 'Add panel'}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
