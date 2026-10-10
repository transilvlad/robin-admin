/**
 * The rows and panels of a dashboard. Each row is a 12-column grid; in edit
 * mode panels are dragged by their header and resized from the corner, and
 * rows can be renamed, reordered, collapsed, repeated or removed. A row that
 * repeats is shown once per value of its variable. Narrow screens get a single
 * column without dragging.
 */

import { useState } from 'react';
import ReactGridLayout, { useContainerWidth, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Repeat, Trash2 } from 'lucide-react';
import {
  GRID_COLUMNS,
  type TelemetryDashboardContent,
  type TelemetryPanel as PanelDefinition,
  type TelemetryRow,
  type TelemetryVariableValues,
} from '../../types/telemetry';
import { applyLayout, duplicatePanel, moveRow, removePanel, removeRow, updateRow } from '../../utils/telemetryDashboard';
import type { ChartSpan } from './TimeSeriesChart';
import { DRAG_HANDLE_CLASS, TelemetryPanel, type OpenLink, type PanelSource } from './TelemetryPanel';

const ROW_HEIGHT = 30;
const MARGIN = 16;
const NARROW_WIDTH = 768;

interface DashboardGridProps {
  content: TelemetryDashboardContent;
  source: PanelSource;
  editing: boolean;
  start: number;
  end: number;
  values: TelemetryVariableValues;
  /** Options per variable, for rows that repeat over all values. */
  variableOptions: Record<string, string[]>;
  refreshKey: number;
  syncKey: string;
  onZoom: (start: number, end: number) => void;
  annotations?: ChartSpan[];
  onOpenLink?: OpenLink;
  /** View mode: open a panel full screen or in Explore with the variables it was shown with. */
  onViewPanel?: (panel: PanelDefinition, values: TelemetryVariableValues) => void;
  onExplorePanel?: (panel: PanelDefinition, values: TelemetryVariableValues) => void;
  /** Edit mode: content changed (layout, rows, panel removal or copy). */
  onChange: (content: TelemetryDashboardContent) => void;
  /** Edit mode: open the panel editor for an existing panel or a new one in a row. */
  onEditPanel: (target: { rowId: string; panelId?: string }) => void;
  /** Ask before destructive edits. */
  confirm: (message: string) => Promise<boolean>;
}

function pixelHeight(h: number): number {
  return h * ROW_HEIGHT + (h - 1) * MARGIN;
}

function RowGrid({ row, width, editing, renderPanel, onLayout }: {
  row: TelemetryRow;
  width: number;
  editing: boolean;
  renderPanel: (panel: PanelDefinition) => React.ReactNode;
  onLayout: (layout: Layout) => void;
}) {
  const panels = row.panels;
  if (width < NARROW_WIDTH) {
    const ordered = [...panels].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
    return (
      <div className="space-y-4">
        {ordered.map((panel) => (
          <div key={panel.id} style={{ height: pixelHeight(Math.max(panel.layout.h, panel.type === 'stat' ? 4 : 7)) }}>
            {renderPanel(panel)}
          </div>
        ))}
      </div>
    );
  }
  return (
    <ReactGridLayout
      width={width}
      layout={panels.map((panel) => ({ i: panel.id, ...panel.layout, minW: 2, minH: 2 }))}
      gridConfig={{ cols: GRID_COLUMNS, rowHeight: ROW_HEIGHT, margin: [MARGIN, MARGIN], containerPadding: [0, 0] }}
      dragConfig={{ enabled: editing, handle: `.${DRAG_HANDLE_CLASS}` }}
      resizeConfig={{ enabled: editing, handles: ['se'] }}
      onLayoutChange={(layout) => {
        if (editing) onLayout(layout);
      }}
    >
      {panels.map((panel) => <div key={panel.id}>{renderPanel(panel)}</div>)}
    </ReactGridLayout>
  );
}

/** The instances a row shows: one, or one per value of its repeat variable. */
export function rowInstances(row: TelemetryRow, values: TelemetryVariableValues, options: Record<string, string[]>) {
  if (!row.repeat) return [{ key: row.id, title: row.title, values }];
  const selected = values[row.repeat] ?? [];
  const repeatValues = selected.length > 0 ? selected : options[row.repeat] ?? [];
  return repeatValues.map((value) => ({
    key: `${row.id}:${value}`,
    title: `${row.title}: ${value}`,
    values: { ...values, [row.repeat!]: [value] },
  }));
}

export function DashboardGrid(props: DashboardGridProps) {
  const {
    content, source, editing, start, end, values, variableOptions, refreshKey, syncKey, onZoom,
    annotations, onOpenLink, onViewPanel, onExplorePanel, onChange, onEditPanel, confirm,
  } = props;
  const { width, containerRef, mounted } = useContainerWidth();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const renderPanel = (row: TelemetryRow, instanceValues: TelemetryVariableValues) => (panel: PanelDefinition) => (
    <TelemetryPanel
      panel={panel}
      source={source}
      start={start}
      end={end}
      values={instanceValues}
      refreshKey={refreshKey}
      syncKey={syncKey}
      onZoom={onZoom}
      annotations={annotations}
      onOpenLink={onOpenLink}
      viewActions={!editing && onViewPanel ? {
        onFullscreen: () => onViewPanel(panel, instanceValues),
        onExplore: onExplorePanel ? () => onExplorePanel(panel, instanceValues) : undefined,
      } : undefined}
      editActions={editing ? {
        onEdit: () => onEditPanel({ rowId: row.id, panelId: panel.id }),
        onDuplicate: () => onChange(duplicatePanel(content, panel.id)),
        onRemove: () => {
          void confirm(`Remove the panel "${panel.title}"?`).then((ok) => {
            if (ok) onChange(removePanel(content, panel.id));
          });
        },
      } : undefined}
    />
  );

  if (content.rows.length === 0) {
    return (
      <div ref={containerRef} className="card p-10 text-center text-sm text-gray-500 dark:text-gray-400">
        {editing ? 'This dashboard is empty. Add a row to start.' : 'This dashboard has no panels yet.'}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="space-y-6">
      {content.rows.map((row, index) => {
        if (editing) {
          return (
            <section key={row.id} className="space-y-3" aria-label={row.title}>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="input w-64 py-1 text-sm font-semibold"
                  value={row.title}
                  aria-label="Row title"
                  maxLength={80}
                  onChange={(event) => onChange(updateRow(content, row.id, { title: event.target.value }))}
                />
                <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300" title="Start collapsed when viewing">
                  <input
                    type="checkbox"
                    checked={Boolean(row.collapsed)}
                    onChange={(event) => onChange(updateRow(content, row.id, { collapsed: event.target.checked || undefined }))}
                  />
                  Collapsed
                </label>
                {content.variables.length > 0 && (
                  <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300" title="Show this row once for each value of a variable">
                    <Repeat aria-hidden="true" className="h-3.5 w-3.5" />
                    <select
                      className="input w-auto py-0.5 text-xs"
                      aria-label={`Repeat ${row.title}`}
                      value={row.repeat ?? ''}
                      onChange={(event) => onChange(updateRow(content, row.id, { repeat: event.target.value || undefined }))}
                    >
                      <option value="">No repeat</option>
                      {content.variables.map((variable) => <option key={variable.name} value={variable.name}>For each {variable.label}</option>)}
                    </select>
                  </label>
                )}
                <div className="flex items-center gap-0.5">
                  <button type="button" className="rounded-sm p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30 dark:hover:bg-robin-gray-700" disabled={index === 0} onClick={() => onChange(moveRow(content, row.id, -1))} aria-label={`Move ${row.title} up`} title="Move up">
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button type="button" className="rounded-sm p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30 dark:hover:bg-robin-gray-700" disabled={index === content.rows.length - 1} onClick={() => onChange(moveRow(content, row.id, 1))} aria-label={`Move ${row.title} down`} title="Move down">
                    <ArrowDown className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className="rounded-sm p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-robin-gray-700"
                    onClick={() => {
                      const message = row.panels.length > 0
                        ? `Remove the row "${row.title}" and its ${row.panels.length} panel(s)?`
                        : `Remove the row "${row.title}"?`;
                      void confirm(message).then((ok) => {
                        if (ok) onChange(removeRow(content, row.id));
                      });
                    }}
                    aria-label={`Remove ${row.title}`}
                    title="Remove row"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <button type="button" className="btn btn-secondary ml-auto px-3 py-1 text-sm" onClick={() => onEditPanel({ rowId: row.id })}>
                  <Plus aria-hidden="true" className="h-4 w-4" />
                  Add panel
                </button>
              </div>
              {row.repeat && (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Shown once for each selected {content.variables.find((variable) => variable.name === row.repeat)?.label ?? row.repeat} (all of them when none is selected). Edit the first; the others follow.
                </p>
              )}
              {mounted && (row.panels.length === 0 ? (
                <button
                  type="button"
                  className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 p-8 text-sm text-gray-500 hover:border-robin-orange hover:text-robin-orange dark:border-robin-gray-600"
                  onClick={() => onEditPanel({ rowId: row.id })}
                >
                  <Plus aria-hidden="true" className="h-4 w-4" />
                  Add a panel to this row
                </button>
              ) : (
                <RowGrid
                  row={row}
                  width={width}
                  editing
                  renderPanel={renderPanel(row, rowInstances(row, values, variableOptions)[0]?.values ?? values)}
                  onLayout={(layout) => onChange(applyLayout(content, row.id, layout))}
                />
              ))}
            </section>
          );
        }

        return rowInstances(row, values, variableOptions).map((instance) => {
          const isCollapsed = collapsed[instance.key] ?? Boolean(row.collapsed);
          return (
            <section key={instance.key} className="space-y-3" aria-label={instance.title}>
              <button
                type="button"
                className="flex items-center gap-1.5 text-sm font-semibold text-gray-700 dark:text-gray-200"
                aria-expanded={!isCollapsed}
                onClick={() => setCollapsed((current) => ({ ...current, [instance.key]: !isCollapsed }))}
              >
                {isCollapsed ? <ChevronRight aria-hidden="true" className="h-4 w-4" /> : <ChevronDown aria-hidden="true" className="h-4 w-4" />}
                {instance.title}
              </button>
              {!isCollapsed && mounted && row.panels.length > 0 && (
                <RowGrid row={row} width={width} editing={false} renderPanel={renderPanel(row, instance.values)} onLayout={() => undefined} />
              )}
            </section>
          );
        });
      })}
    </div>
  );
}
