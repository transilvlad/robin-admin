/**
 * Edit a dashboard's variables: the pickers above the panels whose values
 * come from a label (for example host) and can be narrowed by a selector that
 * uses earlier variables.
 */

import { useState } from 'react';
import { ArrowDown, ArrowUp, Eye, Plus, Trash2 } from 'lucide-react';
import { ApiError, telemetryApi } from '../../api/client';
import { Modal } from '../ui/Modal';
import type { TelemetryVariable } from '../../types/telemetry';

interface VariablesEditorProps {
  variables: TelemetryVariable[];
  start: number;
  end: number;
  onSave: (variables: TelemetryVariable[]) => void;
  onClose: () => void;
}

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function problemFor(variable: TelemetryVariable, index: number, all: TelemetryVariable[]): string | null {
  if (!NAME_RE.test(variable.name) || variable.name.startsWith('__')) return 'Name: letters, digits and _; not starting with a digit or __.';
  if (all.findIndex((other) => other.name === variable.name) !== index) return `Name ${variable.name} is used twice.`;
  if (!NAME_RE.test(variable.source)) return 'Label: a label name such as host or vmname.';
  return null;
}

export function VariablesEditor({ variables: initial, start, end, onSave, onClose }: VariablesEditorProps) {
  const [variables, setVariables] = useState<TelemetryVariable[]>(initial);
  const [previews, setPreviews] = useState<Record<number, { values?: string[]; error?: string }>>({});
  const problems = variables.map((variable, index) => problemFor(variable, index, variables));

  const update = (index: number, patch: Partial<TelemetryVariable>) => {
    setVariables((current) => current.map((variable, i) => (i === index ? { ...variable, ...patch } : variable)));
    setPreviews((current) => ({ ...current, [index]: {} }));
  };

  const move = (index: number, delta: -1 | 1) => {
    setVariables((current) => {
      const next = [...current];
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      return next;
    });
    setPreviews({});
  };

  const preview = (index: number) => {
    const cleaned = variables.slice(0, index + 1).map((variable) => ({ ...variable, match: variable.match?.trim() || undefined }));
    telemetryApi.previewVariable({ variables: cleaned, name: variables[index].name, values: {}, start, end })
      .then((response) => setPreviews((current) => ({ ...current, [index]: { values: response.data ?? [] } })))
      .catch((err: unknown) => setPreviews((current) => ({ ...current, [index]: { error: err instanceof ApiError ? err.message : 'Preview failed' } })));
  };

  return (
    <Modal isOpen onClose={onClose} title="Variables" size="xl">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (problems.some(Boolean)) return;
          onSave(variables.map((variable) => ({
            name: variable.name,
            label: variable.label.trim() || variable.name,
            source: variable.source,
            ...(variable.match?.trim() ? { match: variable.match.trim() } : {}),
            ...(variable.multi ? { multi: true } : {}),
          })));
        }}
      >
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Variables become pickers above the panels. Reference one in a query as <code>$name</code> inside a regex
          matcher, for example <code>host=~"$host"</code>. A selector can use variables listed above it, for example
          <code> host_uptime{'{'}role=~"$role"{'}'}</code>.
        </p>
        {variables.length === 0 && <p className="text-sm text-gray-500 dark:text-gray-400">No variables yet.</p>}
        {variables.map((variable, index) => (
          <div key={index} className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-robin-gray-700">
            <div className="grid gap-3 sm:grid-cols-4">
              <label className="text-sm">
                <span className="form-hint">Name</span>
                <input className="input py-1.5 font-mono" value={variable.name} maxLength={40} onChange={(event) => update(index, { name: event.target.value })} />
              </label>
              <label className="text-sm">
                <span className="form-hint">Label</span>
                <input className="input py-1.5" value={variable.label} maxLength={60} onChange={(event) => update(index, { label: event.target.value })} />
              </label>
              <label className="text-sm">
                <span className="form-hint">Values from label</span>
                <input className="input py-1.5 font-mono" value={variable.source} maxLength={100} placeholder="host" onChange={(event) => update(index, { source: event.target.value })} />
              </label>
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input type="checkbox" checked={Boolean(variable.multi)} onChange={(event) => update(index, { multi: event.target.checked })} />
                Allow several (empty means all)
              </label>
            </div>
            <label className="block text-sm">
              <span className="form-hint">Only series matching (optional)</span>
              <input className="input py-1.5 font-mono text-xs" value={variable.match ?? ''} maxLength={1000} placeholder={'{job="metrics"}'} onChange={(event) => update(index, { match: event.target.value })} />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn btn-secondary px-3 py-1 text-sm" onClick={() => preview(index)} disabled={Boolean(problems[index])}>
                <Eye aria-hidden="true" className="h-4 w-4" />
                Preview values
              </button>
              <div className="ml-auto flex items-center gap-0.5">
                <button type="button" className="rounded-sm p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30 dark:hover:bg-robin-gray-700" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move ${variable.name} up`} title="Move up">
                  <ArrowUp className="h-4 w-4" />
                </button>
                <button type="button" className="rounded-sm p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30 dark:hover:bg-robin-gray-700" disabled={index === variables.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${variable.name} down`} title="Move down">
                  <ArrowDown className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="rounded-sm p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-robin-gray-700"
                  onClick={() => {
                    setVariables((current) => current.filter((_variable, i) => i !== index));
                    setPreviews({});
                  }}
                  aria-label={`Remove ${variable.name}`}
                  title="Remove"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
            {problems[index] && <p className="text-xs text-red-600 dark:text-red-400">{problems[index]}</p>}
            {previews[index]?.error && <p className="text-xs text-red-600 dark:text-red-400">{previews[index].error}</p>}
            {previews[index]?.values && (
              <p className="text-xs text-gray-600 dark:text-gray-300">
                {previews[index].values!.length === 0
                  ? 'No values in the current time range.'
                  : `${previews[index].values!.length} value(s): ${previews[index].values!.slice(0, 12).join(', ')}${previews[index].values!.length > 12 ? ', …' : ''}`}
              </p>
            )}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          {variables.length < 10 && (
            <button
              type="button"
              className="btn btn-secondary px-3 py-1.5 text-sm"
              onClick={() => setVariables((current) => [...current, { name: current.length === 0 ? 'host' : `var${current.length + 1}`, label: current.length === 0 ? 'Host' : 'Variable', source: 'host' }])}
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add variable
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={problems.some(Boolean)}>Apply</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
