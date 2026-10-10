/**
 * Telemetry dashboards. Dashboards are stored by Robin Admin and managed here:
 * editors switch to edit mode to drag, resize, add and edit panels, rows and
 * variables, then save (the server refuses a save if someone else saved
 * first). The selected dashboard, variables, range and auto refresh live in
 * the URL so a view can be shared.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSearchParamsUpdater } from '../hooks/useSearchParamsUpdater';
import { Copy, Download, FolderCog, History, OctagonAlert, Pencil, Plus, RotateCcw, Save, Settings2, SlidersHorizontal, Sparkles, Trash2, X } from 'lucide-react';
import { ApiError, telemetryApi } from '../api/client';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { Modal } from '../components/ui/Modal';
import { ActionsMenu, type MenuAction } from '../components/telemetry/ActionsMenu';
import { DashboardDetailsModal } from '../components/telemetry/DashboardDetailsModal';
import { DashboardGrid } from '../components/telemetry/DashboardGrid';
import { ManageDashboardsModal } from '../components/telemetry/ManageDashboardsModal';
import { MultiSelect } from '../components/telemetry/MultiSelect';
import { PanelEditor } from '../components/telemetry/PanelEditor';
import { PanelFullscreen } from '../components/telemetry/PanelFullscreen';
import type { ChartSpan } from '../components/telemetry/TimeSeriesChart';
import { TelemetryStatusGate } from '../components/telemetry/TelemetryStatusGate';
import { TimeRangePicker } from '../components/telemetry/TimeRangePicker';
import { VariablesEditor } from '../components/telemetry/VariablesEditor';
import { VersionHistoryModal } from '../components/telemetry/VersionHistoryModal';
import { appIcons } from '../constants/appIcons';
import { useConfirm } from '../context/ConfirmContext';
import { useCanEdit, useIsAdmin } from '../hooks/useAuth';
import type {
  TelemetryAnnotation,
  TelemetryDashboard,
  TelemetryDashboardContent,
  TelemetryDashboardSummary,
  TelemetryPanel,
  TelemetryVariable,
  TelemetryVariableValues,
} from '../types/telemetry';
import {
  DEFAULT_RANGE,
  hasTimeRange,
  parseTimeRange,
  readVariableValues,
  REFRESH_OPTIONS,
  resolveRange,
  writeTimeRange,
  writeVariableValues,
  type TimeRange,
} from '../utils/telemetry';
import { addRow, blankPanel, contentOf, exportFileName, exportJson, findPanel, upsertPanel } from '../utils/telemetryDashboard';

const SYNC_KEY = 'telemetry-dashboard';

type Dialog =
  | { kind: 'panel'; rowId: string; panel: TelemetryPanel; isNew: boolean }
  | { kind: 'variables' }
  | { kind: 'details' }
  | { kind: 'new' }
  | { kind: 'manage' }
  | { kind: 'history' }
  | { kind: 'conflict'; currentVersion: number }
  | { kind: 'view'; panel: TelemetryPanel; values: TelemetryVariableValues };

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sameValues(a: TelemetryVariableValues, b: TelemetryVariableValues): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => (a[key] ?? []).join('\u0000') === (b[key] ?? []).join('\u0000'));
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Resolve variables in order: each one's options may depend on earlier ones.
 * Saved dashboards ask the dashboard endpoint; drafts ask the preview endpoint.
 */
function useVariables(input: {
  key: string;
  variables: TelemetryVariable[];
  load: (variable: TelemetryVariable, index: number, values: TelemetryVariableValues) => Promise<string[]>;
  requested: TelemetryVariableValues;
  /** Changes when the dashboard refreshes; options are reloaded but kept on screen meanwhile. */
  refreshKey: number;
  onResolved: (values: TelemetryVariableValues) => void;
}) {
  const { key, variables, load, requested, refreshKey, onResolved } = input;
  const [state, setState] = useState<{ key: string; options: Record<string, string[]>; values: TelemetryVariableValues } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const values: TelemetryVariableValues = {};
      const options: Record<string, string[]> = {};
      for (const [index, variable] of variables.entries()) {
        const available = await load(variable, index, { ...values });
        options[variable.name] = available;
        const wanted = requested[variable.name] ?? [];
        values[variable.name] = variable.multi
          ? wanted.filter((value) => available.includes(value))
          : wanted[0] && available.includes(wanted[0]) ? [wanted[0]] : available.slice(0, 1);
      }
      if (cancelled) return;
      setState({ key, options, values });
      setError(null);
      onResolved(values);
    })().catch((err: unknown) => {
      if (!cancelled) setError(errorMessage(err, 'Failed to load dashboard variables'));
    });
    return () => {
      cancelled = true;
    };
    // `key` covers the variables and how they load.
  }, [key, requested, refreshKey]);

  const current = state && state.key === key ? state : null;
  return { options: current?.options ?? {}, values: current?.values ?? null, error };
}

function DashboardView() {
  const canEdit = useCanEdit();
  // Monitoring, and so its incidents, is admin-only.
  const isAdmin = useIsAdmin();
  const confirm = useConfirm();
  const [params, updateParams] = useSearchParamsUpdater();
  const paramsKey = params.toString();
  const navigate = useNavigate();
  const requested = useMemo(() => readVariableValues(new URLSearchParams(paramsKey)), [paramsKey]);
  const showIncidents = isAdmin && params.get('incidents') === '1';

  const [summaries, setSummaries] = useState<TelemetryDashboardSummary[] | null>(null);
  const [dashboard, setDashboard] = useState<TelemetryDashboard | null>(null);
  const [draft, setDraft] = useState<TelemetryDashboardContent | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(nowSeconds);
  const [refreshKey, setRefreshKey] = useState(0);

  const requestedUid = params.get('dashboard');
  const uid = requestedUid ? summaries?.some((summary) => summary.uid === requestedUid) ? requestedUid : null : summaries?.[0]?.uid ?? null;
  const editing = draft !== null;
  const content = draft ?? (dashboard && dashboard.uid === uid ? contentOf(dashboard) : null);
  const dirty = editing && dashboard !== null && JSON.stringify(draft) !== JSON.stringify(contentOf(dashboard));
  // An explicit range or refresh in the URL wins over the dashboard's defaults.
  const defaultRange = content?.defaults?.range ?? DEFAULT_RANGE;
  const range = useMemo(() => {
    const urlParams = new URLSearchParams(paramsKey);
    return hasTimeRange(urlParams) ? parseTimeRange(urlParams) : { kind: 'relative' as const, preset: defaultRange };
  }, [paramsKey, defaultRange]);
  const refreshParam = params.has('refresh') ? Number(params.get('refresh')) : content?.defaults?.refresh ?? 0;
  const refreshSeconds = REFRESH_OPTIONS.some((option) => option.value === refreshParam) ? refreshParam : 0;
  const timeWindow = useMemo(() => resolveRange(range, now), [range, now]);
  const [annotations, setAnnotations] = useState<TelemetryAnnotation[]>([]);

  const loadSummaries = useCallback(async (openUid?: string) => {
    try {
      const response = await telemetryApi.dashboards();
      setSummaries(response.data ?? []);
      if (openUid) updateParams((next) => next.set('dashboard', openUid));
    } catch (err) {
      setError(errorMessage(err, 'Failed to load dashboards'));
    }
  }, [updateParams]);

  useEffect(() => {
    void loadSummaries();
  }, [loadSummaries]);

  useEffect(() => {
    if (!uid) {
      setDashboard(null);
      return undefined;
    }
    let cancelled = false;
    telemetryApi.dashboard(uid)
      .then((response) => {
        if (!cancelled) setDashboard(response.data ?? null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, 'Failed to load the dashboard'));
      });
    return () => {
      cancelled = true;
    };
  }, [uid]);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const variables = content?.variables ?? [];
  const variablesKey = editing ? `draft:${JSON.stringify(variables)}` : `saved:${dashboard?.uid}:${dashboard?.version}`;
  const resolved = useVariables({
    key: `${variablesKey}:${content ? 'ready' : 'none'}:${JSON.stringify(range)}`,
    variables: content ? variables : [],
    load: (variable, index, values) => {
      const windowNow = resolveRange(range);
      return (editing
        ? telemetryApi.previewVariable({ variables: variables.slice(0, index + 1), name: variable.name, values, ...windowNow })
        : telemetryApi.variableOptions(dashboard!.uid, variable.name, windowNow, values)
      ).then((response) => response.data ?? []);
    },
    requested,
    refreshKey,
    onResolved: (values) => {
      // Until the dashboard loads its variables are unknown: leave the URL alone.
      if (!content) return;
      const own = Object.fromEntries(Object.entries(requested).filter(([name]) => variables.some((variable) => variable.name === name)));
      // Also drop values of variables this dashboard does not have.
      const stale = Object.keys(requested).some((name) => !variables.some((variable) => variable.name === name));
      if (stale || !sameValues(own, values)) updateParams((next) => writeVariableValues(next, values), true);
    },
  });

  const annotationsWindow = `${timeWindow.start}:${timeWindow.end}`;
  useEffect(() => {
    if (!showIncidents) {
      setAnnotations([]);
      return undefined;
    }
    let cancelled = false;
    const [start, end] = annotationsWindow.split(':').map(Number);
    telemetryApi.annotations({ start, end })
      .then((response) => {
        if (!cancelled) setAnnotations(response.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setAnnotations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [showIncidents, annotationsWindow, refreshKey]);
  const spans = useMemo<ChartSpan[]>(() => annotations.map((issue) => ({
    start: Math.floor(new Date(issue.openedAt).getTime() / 1000),
    end: Math.ceil(new Date(issue.closedAt ?? Date.now()).getTime() / 1000),
    severity: issue.severity,
    label: `${issue.checkName}: ${issue.summary}`,
  })), [annotations]);

  const refresh = useCallback(() => {
    setNow(nowSeconds());
    setRefreshKey((key) => key + 1);
  }, []);

  useEffect(() => {
    if (!refreshSeconds || range.kind === 'absolute' || editing) return undefined;
    const timer = setInterval(refresh, refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [refreshSeconds, range.kind, refresh, editing]);

  useEffect(() => {
    setNow(nowSeconds());
  }, [range]);

  const setRange = (next: TimeRange) => updateParams((p) => writeTimeRange(p, next, true));
  const zoom = useCallback((start: number, end: number) => {
    updateParams((p) => writeTimeRange(p, { kind: 'absolute', from: start, to: end }));
  }, [updateParams]);

  /** Keep the time range and refresh when moving to another Telemetry view. */
  const carriedParams = () => {
    const carried = new URLSearchParams();
    for (const key of ['range', 'from', 'to', 'refresh', 'incidents']) {
      const value = params.get(key);
      if (value !== null) carried.set(key, value);
    }
    return carried;
  };

  const openLink = useCallback((panel: TelemetryPanel, labels: Record<string, string>) => {
    if (!panel.link || !labels[panel.link.label]) return;
    const next = carriedParams();
    next.set('dashboard', panel.link.dashboardUid);
    next.set(`var-${panel.link.variable}`, labels[panel.link.label]);
    setDraft(null);
    navigate(`/telemetry?${next.toString()}`);
  }, [navigate, paramsKey]);

  const explorePanel = async (panel: TelemetryPanel, values: TelemetryVariableValues) => {
    if (!dashboard) return;
    await actOn(async () => {
      const response = await telemetryApi.panelQueries(dashboard.uid, panel.id, timeWindow, values);
      const next = carriedParams();
      next.delete('incidents');
      for (const query of response.data?.queries ?? []) next.append('q', query.expr);
      if (response.data?.unit) next.set('unit', response.data.unit);
      navigate(`/telemetry/explore?${next.toString()}`);
    }, 'Failed to open the panel in Explore');
  };

  const switchDashboard = async (nextUid: string) => {
    if (dirty && !(await confirm('Discard your unsaved changes to this dashboard?'))) return;
    setDraft(null);
    updateParams((next) => next.set('dashboard', nextUid));
  };

  const save = async (version = dashboard?.version) => {
    if (!dashboard || !draft || version === undefined) return;
    setSaving(true);
    setError(null);
    try {
      const response = await telemetryApi.saveDashboard(dashboard.uid, draft, version);
      if (response.data) setDashboard(response.data);
      setDraft(null);
      setDialog(null);
      void loadSummaries();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const latest = await telemetryApi.dashboard(dashboard.uid).catch(() => null);
        setDialog({ kind: 'conflict', currentVersion: latest?.data?.version ?? version + 1 });
      } else {
        setError(errorMessage(err, 'Failed to save the dashboard'));
      }
    } finally {
      setSaving(false);
    }
  };

  const discard = async () => {
    if (dirty && !(await confirm('Discard your unsaved changes?'))) return;
    setDraft(null);
  };

  const reloadAfterConflict = async () => {
    if (!dashboard) return;
    const response = await telemetryApi.dashboard(dashboard.uid);
    if (response.data) setDashboard(response.data);
    setDraft(null);
    setDialog(null);
  };

  const actOn = async (work: () => Promise<void>, fallback: string) => {
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorMessage(err, fallback));
    }
  };

  const menu: MenuAction[] = [];
  if (canEdit) {
    menu.push({ label: 'Manage dashboards', icon: <FolderCog className="h-4 w-4" />, onSelect: () => setDialog({ kind: 'manage' }) });
  }
  if (dashboard) {
    if (canEdit) {
      menu.push({
        label: 'Duplicate',
        icon: <Copy className="h-4 w-4" />,
        onSelect: () => void actOn(async () => {
          const created = await telemetryApi.createDashboard({ duplicateOf: dashboard.uid });
          await loadSummaries(created.data?.uid);
        }, 'Failed to duplicate the dashboard'),
      });
    }
    menu.push({ label: 'Export JSON', icon: <Download className="h-4 w-4" />, onSelect: () => download(exportFileName(dashboard.title), exportJson(dashboard)) });
    menu.push({ label: 'Version history', icon: <History className="h-4 w-4" />, onSelect: () => setDialog({ kind: 'history' }) });
    if (canEdit && dashboard.templateKey) {
      menu.push({
        label: 'Restore template',
        icon: <RotateCcw className="h-4 w-4" />,
        onSelect: () => void confirm(`Replace "${dashboard.title}" with its template layout? The current version stays in the history.`).then((ok) => {
          if (!ok) return;
          void actOn(async () => {
            const response = await telemetryApi.restoreDefault(dashboard.uid);
            if (response.data) setDashboard(response.data);
            await loadSummaries();
          }, 'Failed to restore the dashboard');
        }),
      });
    }
    if (canEdit) {
      menu.push({
        label: 'Delete dashboard',
        icon: <Trash2 className="h-4 w-4" />,
        danger: true,
        onSelect: () => void confirm(`Delete the dashboard "${dashboard.title}"? Its version history is deleted too.`).then((ok) => {
          if (!ok) return;
          void actOn(async () => {
            await telemetryApi.deleteDashboard(dashboard.uid);
            setDashboard(null);
            updateParams((next) => next.delete('dashboard'));
            await loadSummaries();
          }, 'Failed to delete the dashboard');
        }),
      });
    }
  }

  const dialogs = (
    <>
      {dialog?.kind === 'panel' && content && resolved.values && (
        <PanelEditor
          panel={dialog.panel}
          rowId={dialog.rowId}
          rows={content.rows}
          variables={content.variables}
          values={resolved.values}
          start={timeWindow.start}
          end={timeWindow.end}
          isNew={dialog.isNew}
          dashboards={summaries ?? []}
          onSave={(rowId, panel) => {
            setDraft((current) => (current ? upsertPanel(current, rowId, panel) : current));
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'variables' && content && (
        <VariablesEditor
          variables={content.variables}
          start={timeWindow.start}
          end={timeWindow.end}
          onSave={(next) => {
            setDraft((current) => (current ? { ...current, variables: next } : current));
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'view' && dashboard && (
        <PanelFullscreen
          panel={dialog.panel}
          source={{ kind: 'saved', dashboardUid: dashboard.uid }}
          start={timeWindow.start}
          end={timeWindow.end}
          values={dialog.values}
          refreshKey={refreshKey}
          annotations={spans}
          onZoom={zoom}
          onOpenLink={(panel, labels) => {
            setDialog(null);
            openLink(panel, labels);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'details' && content && (
        <DashboardDetailsModal
          heading="Dashboard details"
          submitLabel="Apply"
          initialTitle={content.title}
          initialDescription={content.description}
          initialDefaults={content.defaults}
          onSubmit={(details) => {
            setDraft((current) => (current ? { ...current, ...details } : current));
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'new' && (
        <DashboardDetailsModal
          heading="New dashboard"
          submitLabel="Create"
          onSubmit={(details) => void actOn(async () => {
            const created = await telemetryApi.createDashboard({ ...details, variables: [], rows: [] });
            setDialog(null);
            await loadSummaries(created.data?.uid);
            if (created.data) {
              setDashboard(created.data);
              setDraft(addRow(contentOf(created.data), 'Overview'));
            }
          }, 'Failed to create the dashboard')}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'manage' && summaries && (
        <ManageDashboardsModal
          dashboards={summaries}
          confirm={confirm}
          onChanged={(openUid) => {
            void loadSummaries(openUid);
            if (openUid) setDialog(null);
          }}
          onNew={() => setDialog({ kind: 'new' })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'history' && dashboard && (
        <VersionHistoryModal
          dashboard={dashboard}
          canRestore={canEdit && !editing}
          confirm={confirm}
          onRestored={(restored) => {
            setDashboard(restored);
            setDialog(null);
            void loadSummaries();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'conflict' && (
        <Modal isOpen onClose={() => setDialog(null)} title="Someone else saved this dashboard" size="sm">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            This dashboard changed since you started editing (now version {dialog.currentVersion}). Reload to see their
            changes and lose yours, or save yours over theirs; their version stays in the history.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => void reloadAfterConflict()}>Reload</button>
            <button type="button" className="btn btn-primary" onClick={() => void save(dialog.currentVersion)}>Save over it</button>
          </div>
        </Modal>
      )}
    </>
  );

  if (!summaries) return <div className="flex justify-center py-16"><Spinner label="Loading dashboards" /></div>;

  if (requestedUid && !uid) {
    return <div className="space-y-3 py-6">
      <p role="status" className="text-sm text-gray-500 dark:text-gray-400">Dashboard not found. It may have been deleted.</p>
      <button type="button" className="btn btn-secondary" onClick={() => updateParams(next => { next.delete('dashboard'); writeVariableValues(next, {}); })}><FolderCog className="h-4 w-4" aria-hidden="true" />View dashboards</button>
    </div>;
  }

  if (summaries.length === 0) {
    return (
      <div className="card flex flex-col items-center gap-3 p-10 text-center">
        <h2 className="text-lg font-semibold">No dashboards</h2>
        <p className="max-w-lg text-sm text-gray-500 dark:text-gray-400">
          {canEdit ? 'No saved dashboards.' : 'No dashboards available.'}
        </p>
        {canEdit && (
          <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: 'manage' })}>
            <FolderCog aria-hidden="true" className="h-4 w-4" />
            Manage dashboards
          </button>
        )}
        {dialogs}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="form-label">Dashboard</span>
          <select className="input w-auto py-1.5 text-sm" value={uid ?? ''} onChange={(event) => void switchDashboard(event.target.value)}>
            {summaries.map((summary) => <option key={summary.uid} value={summary.uid}>{summary.title}</option>)}
          </select>
        </label>
        {variables.map((variable) => {
          const available = resolved.options[variable.name] ?? [];
          const selected = resolved.values?.[variable.name] ?? [];
          return (
            <div key={variable.name} className="text-sm">
              <span className="form-label">{variable.label}</span>
              {variable.multi ? (
                <MultiSelect
                  label={variable.label}
                  options={available}
                  value={selected}
                  onChange={(value) => updateParams((next) => writeVariableValues(next, { ...resolved.values, [variable.name]: value }))}
                />
              ) : (
                <select
                  className="input w-auto min-w-36 py-1.5 text-sm"
                  aria-label={variable.label}
                  value={selected[0] ?? ''}
                  disabled={available.length === 0}
                  onChange={(event) => updateParams((next) => writeVariableValues(next, { ...resolved.values, [variable.name]: [event.target.value] }))}
                >
                  {available.length === 0 && <option value="">No values</option>}
                  {available.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              )}
            </div>
          );
        })}
        <div className="ml-auto">
          <TimeRangePicker
            range={range}
            onRangeChange={setRange}
            refreshSeconds={refreshSeconds}
            onRefreshSecondsChange={(seconds) => updateParams((next) => next.set('refresh', String(seconds)))}
            onRefresh={refresh}
          />
        </div>
      </div>

      {dashboard?.templateUpdated && canEdit && !editing && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-sm text-gray-600 dark:border-robin-gray-700 dark:bg-robin-gray-800 dark:text-gray-300">
          <Sparkles aria-hidden="true" className="h-4 w-4 text-robin-orange" />
          <span className="mr-auto">An updated template is available. The current version will remain in history.</span>
          <button
            type="button"
            className="btn btn-secondary px-3 py-1 text-sm"
            onClick={() => void actOn(async () => {
              const response = await telemetryApi.keepDashboard(dashboard.uid);
              if (response.data) setDashboard(response.data);
              await loadSummaries();
            }, 'Failed to keep the dashboard')}
          >
            Keep mine
          </button>
          <button
            type="button"
            className="btn btn-secondary px-3 py-1 text-sm"
            onClick={() => void actOn(async () => {
              const response = await telemetryApi.restoreDefault(dashboard.uid);
              if (response.data) setDashboard(response.data);
              await loadSummaries();
            }, 'Failed to restore the dashboard')}
          >
            Use updated template
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-sm text-gray-500 dark:text-gray-400">
          {content?.description}
        </p>
        {editing ? (
          <>
            <button type="button" className="btn btn-secondary px-3 py-1.5 text-sm" onClick={() => setDraft((current) => (current ? addRow(current) : current))}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add row
            </button>
            <button type="button" className="btn btn-secondary px-3 py-1.5 text-sm" onClick={() => setDialog({ kind: 'variables' })}>
              <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
              Variables
            </button>
            <button type="button" className="btn btn-secondary px-3 py-1.5 text-sm" onClick={() => setDialog({ kind: 'details' })}>
              <Settings2 aria-hidden="true" className="h-4 w-4" />
              Details
            </button>
            <button type="button" className="btn btn-secondary px-3 py-1.5 text-sm" onClick={() => void discard()}>
              <X aria-hidden="true" className="h-4 w-4" />
              Discard
            </button>
            <button type="button" className="btn btn-primary px-3 py-1.5 text-sm" onClick={() => void save()} disabled={!dirty || saving}>
              <Save aria-hidden="true" className="h-4 w-4" />
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        ) : (
          <>
            {isAdmin && (
              <button
                type="button"
                className={`btn px-3 py-1.5 text-sm ${showIncidents ? 'btn-primary' : 'btn-secondary'}`}
                aria-pressed={showIncidents}
                title="Shade Monitoring incidents on the charts"
                onClick={() => updateParams((next) => {
                  if (showIncidents) next.delete('incidents');
                  else next.set('incidents', '1');
                })}
              >
                <OctagonAlert aria-hidden="true" className="h-4 w-4" />
                Incidents{showIncidents && annotations.length > 0 ? ` (${annotations.length})` : ''}
              </button>
            )}
            {canEdit && dashboard && (
              <button type="button" className="btn btn-secondary px-3 py-1.5 text-sm" onClick={() => setDraft(contentOf(dashboard))}>
                <Pencil aria-hidden="true" className="h-4 w-4" />
                Edit
              </button>
            )}
            <ActionsMenu actions={menu} />
          </>
        )}
      </div>

      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {resolved.error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{resolved.error}</p>}
      {!content || !resolved.values || !dashboard ? (
        <div className="flex justify-center py-16"><Spinner label="Loading dashboard" /></div>
      ) : (
        <DashboardGrid
          content={content}
          source={editing ? { kind: 'draft', variables: content.variables } : { kind: 'saved', dashboardUid: dashboard.uid }}
          editing={editing}
          start={timeWindow.start}
          end={timeWindow.end}
          values={resolved.values}
          variableOptions={resolved.options}
          refreshKey={refreshKey}
          syncKey={SYNC_KEY}
          onZoom={zoom}
          annotations={spans}
          onOpenLink={openLink}
          onViewPanel={(panel, values) => setDialog({ kind: 'view', panel, values })}
          onExplorePanel={(panel, values) => void explorePanel(panel, values)}
          onChange={setDraft}
          onEditPanel={({ rowId, panelId }) => {
            const found = panelId ? findPanel(content, panelId) : null;
            const row = content.rows.find((candidate) => candidate.id === rowId);
            if (!row) return;
            setDialog({ kind: 'panel', rowId, panel: found?.panel ?? blankPanel(row), isNew: !found });
          }}
          confirm={confirm}
        />
      )}
      {dialogs}
    </div>
  );
}

export function TelemetryPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.dashboard}
        title="Dashboard"
      />
      <TelemetryStatusGate>
        <DashboardView />
      </TelemetryStatusGate>
    </div>
  );
}
