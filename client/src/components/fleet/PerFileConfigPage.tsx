import { useEffect, useState, type ReactNode } from 'react';
import { RefreshCw, Save, Layers, GitCompare, Copy, RotateCcw, X, type LucideIcon } from 'lucide-react';
import { PageHeader } from '../ui/PageHeader';
import { Spinner } from '../ui/Spinner';
import { TextField, NumberField, ToggleField, SelectField, TextAreaField } from '../robin-config/ConfigField';
import type { ManagedFieldDef } from '../../constants/managedConfigFiles';

// A single config "file" (or logical section) shown in the sidebar and edited on
// the right. `fields` drives a generic structured form; `rendered` is the live
// preview of the file the fleet layer materialises.
export interface PerFileConfigFile {
  key: string;
  label: string;
  fileName?: string;
  description?: string;
  icon?: LucideIcon;
  fields: ManagedFieldDef[];
  values: Record<string, unknown>;
  /** Default (base) values for the same fields — enables the base-vs-override Diff. */
  baseValues?: Record<string, unknown>;
  rendered?: string;
}

/** Human-readable rendering of a config value for the diff panel. */
function formatDiffValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.map(String).join('\n') : '—';
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}

interface PerFileConfigPageProps {
  title: string;
  icon: LucideIcon;
  description?: ReactNode;
  files: PerFileConfigFile[];
  scopeId: string;
  scopes: string[];
  onScopeChange: (id: string) => void;
  onSaveFile: (key: string, values: Record<string, unknown>) => Promise<void> | void;
  /** Save the current edits as a NEW instance override scope (Robin-style Save As). */
  onSaveFileAs?: (key: string, values: Record<string, unknown>, newScopeId: string) => Promise<void> | void;
  /** Drop the current scope's override for this file so it inherits base again. */
  onResetFile?: (key: string) => Promise<void> | void;
  savingKey?: string | null;
  loading?: boolean;
  error?: string;
  success?: string;
  /** Extra header buttons (Refresh / Reload / Diff), rendered before Save. */
  headerActions?: ReactNode;
  /** Optional right-rail content shown under the editor (service status, etc.). */
  aside?: ReactNode;
}

// One generic structured form, rendered from field metadata — the same look for
// every service so config editing is identical across the fleet.
function ConfigForm({
  fields,
  values,
  onChange,
}: {
  fields: ManagedFieldDef[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {fields.map((field) => {
        const v = values[field.key];
        if (field.type === 'textarea') {
          // Value may be a string or a string[] (one item per line).
          const text = Array.isArray(v) ? v.join('\n') : String(v ?? '');
          return (
            <div key={field.key} className="sm:col-span-2">
              <TextAreaField label={field.label} help={field.help} placeholder={field.placeholder}
                value={text} rows={5} onChange={(nv) => onChange(field.key, nv)} />
            </div>
          );
        }
        if (field.type === 'boolean') {
          return <ToggleField key={field.key} label={field.label} help={field.help} value={Boolean(v)} onChange={(nv) => onChange(field.key, nv)} />;
        }
        if (field.type === 'select') {
          return <SelectField key={field.key} label={field.label} help={field.help} value={String(v ?? '')} options={field.options ?? []} onChange={(nv) => onChange(field.key, nv)} />;
        }
        if (field.type === 'number') {
          if (field.nullable) {
            return (
              <TextField key={field.key} label={field.label} help={field.help} placeholder={field.placeholder}
                value={v === null || v === undefined ? '' : String(v)}
                onChange={(nv) => onChange(field.key, nv.trim() === '' ? null : Number(nv))} />
            );
          }
          return <NumberField key={field.key} label={field.label} help={field.help} value={typeof v === 'number' ? v : Number(v) || 0} min={field.min} max={field.max} step={field.step} onChange={(nv) => onChange(field.key, nv)} />;
        }
        return <TextField key={field.key} label={field.label} help={field.help} placeholder={field.placeholder} value={String(v ?? '')} onChange={(nv) => onChange(field.key, nv)} />;
      })}
    </div>
  );
}

export function PerFileConfigPage({
  title, icon, description, files, scopeId, scopes, onScopeChange,
  onSaveFile, onSaveFileAs, onResetFile, savingKey, loading, error, success, headerActions, aside,
}: PerFileConfigPageProps) {
  const [selectedKey, setSelectedKey] = useState<string>(files[0]?.key ?? '');
  const selected = files.find((f) => f.key === selectedKey) ?? files[0];
  const [edited, setEdited] = useState<Record<string, unknown>>(selected?.values ?? {});
  const [showPreview, setShowPreview] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState('');

  // The Diff view compares the current scope's saved override against the base.
  // It only makes sense on a non-default scope that supplied base values.
  const canDiff = scopeId !== 'default' && !!selected?.baseValues;
  const diffRows = canDiff && selected
    ? selected.fields.flatMap((f) => {
      const base = selected.baseValues![f.key];
      const cur = selected.values[f.key];
      return JSON.stringify(cur ?? null) !== JSON.stringify(base ?? null)
        ? [{ key: f.key, label: f.label, base, cur }]
        : [];
    })
    : [];

  // Default/keep a valid selection as the file list loads or changes.
  useEffect(() => {
    if (files.length && !files.some((f) => f.key === selectedKey)) {
      setSelectedKey(files[0].key);
    }
  }, [files, selectedKey]);

  // Re-sync the editor when the selected file or its stored values change.
  useEffect(() => {
    setEdited(selected?.values ?? {});
  }, [selected?.key, selected?.values]);

  // Diff is meaningless on the base scope — collapse it when it can't apply.
  useEffect(() => {
    if (!canDiff) setShowDiff(false);
  }, [canDiff]);

  const dirty = selected ? JSON.stringify(edited) !== JSON.stringify(selected.values) : false;
  const saving = savingKey === selected?.key;

  return (
    <div className="space-y-6">
      <PageHeader icon={icon} title={title} description={description} actions={headerActions} />

      {error && <div className="rounded-lg bg-red-100 p-3 text-red-700 dark:bg-red-900/20 dark:text-red-400">{error}</div>}
      {success && <div className="rounded-lg bg-green-100 p-3 text-green-700 dark:bg-green-900/20 dark:text-green-400">{success}</div>}

      {loading ? (
        <div className="flex justify-center py-8"><Spinner className="text-robin-orange" /></div>
      ) : files.length === 0 ? (
        <div className="card p-8 text-center text-gray-500 dark:text-gray-400">No configuration files for this service.</div>
      ) : (
        <div className="flex flex-col gap-6 lg:flex-row">
          {/* Sidebar file list */}
          <div className="shrink-0 lg:w-64">
            <div className="card sticky top-4 p-2">
              <div className="px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400">Config files</div>
              <nav className="space-y-1">
                {files.map((file) => {
                  const Icon = file.icon ?? Layers;
                  const isActive = selected?.key === file.key;
                  return (
                    <button
                      key={file.key}
                      onClick={() => setSelectedKey(file.key)}
                      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                        isActive ? 'bg-robin-orange/10 text-robin-orange' : 'hover:bg-gray-100 dark:hover:bg-robin-gray-700'
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="flex-1 truncate">{file.label}</span>
                    </button>
                  );
                })}
              </nav>
            </div>
            {aside && <div className="mt-6">{aside}</div>}
          </div>

          {/* Editor */}
          <div className="min-w-0 flex-1">
            {selected && (
              <div className="card">
                <div className="border-b border-gray-200 p-4 dark:border-robin-gray-700">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <h2 className="text-lg font-semibold">{selected.label}</h2>
                      {selected.description && <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{selected.description}</p>}
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2">
                        <label className="text-sm text-gray-600 dark:text-gray-400">Scope:</label>
                        <select value={scopeId} onChange={(e) => onScopeChange(e.target.value)} className="input py-1.5 text-sm">
                          {scopes.map((id) => <option key={id} value={id}>{id === 'default' ? 'Default (base)' : id}</option>)}
                        </select>
                      </div>
                      {canDiff && (
                        <button
                          onClick={() => setShowDiff((s) => !s)}
                          className={`btn btn-secondary ${showDiff ? 'ring-1 ring-robin-orange' : ''}`}
                        >
                          <GitCompare className="h-4 w-4" />
                          Diff
                        </button>
                      )}
                      {onResetFile && canDiff && diffRows.length > 0 && (
                        <button
                          onClick={() => void onResetFile(selected.key)}
                          disabled={saving}
                          title="Drop this instance's override for this file and inherit the base"
                          className="btn btn-secondary"
                        >
                          <RotateCcw className="h-4 w-4" />
                          Reset to base
                        </button>
                      )}
                      {onSaveFileAs && (
                        <button onClick={() => { setSaveAsName(''); setSaveAsOpen(true); }} disabled={saving} className="btn btn-secondary">
                          <Copy className="h-4 w-4" />
                          Save as
                        </button>
                      )}
                      <button onClick={() => void onSaveFile(selected.key, edited)} disabled={saving || !dirty} className="btn btn-primary">
                        {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        Save
                      </button>
                    </div>
                  </div>
                </div>

                <div className="space-y-4 p-4">
                  {showDiff && canDiff && (
                    <div className="rounded-lg border border-robin-orange/30 bg-robin-orange/5 p-4">
                      <div className="mb-3 text-sm font-medium text-gray-700 dark:text-gray-200">
                        Overrides for <strong>{scopeId}</strong> vs Default (base)
                      </div>
                      {diffRows.length === 0 ? (
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          No overrides — this scope matches the default base for this file.
                        </p>
                      ) : (
                        <div className="space-y-3">
                          {diffRows.map((r) => (
                            <div key={r.key} className="grid grid-cols-1 gap-3 md:grid-cols-2">
                              <div>
                                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{r.label} · default</span>
                                <pre className="mt-1 overflow-x-auto rounded-sm bg-gray-100 p-2 text-sm text-red-600 dark:bg-robin-gray-800 dark:text-red-400">{formatDiffValue(r.base)}</pre>
                              </div>
                              <div>
                                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{r.label} · {scopeId}</span>
                                <pre className="mt-1 overflow-x-auto rounded-sm bg-gray-100 p-2 text-sm text-green-600 dark:bg-robin-gray-800 dark:text-green-400">{formatDiffValue(r.cur)}</pre>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <ConfigForm fields={selected.fields} values={edited} onChange={(k, v) => setEdited((p) => ({ ...p, [k]: v }))} />
                  {selected.rendered !== undefined && (
                    <div>
                      <button type="button" onClick={() => setShowPreview((s) => !s)} className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                        {showPreview ? 'Hide' : 'Show'} rendered {selected.fileName ?? 'output'}
                      </button>
                      {showPreview && (
                        <pre className="mt-2 max-h-72 overflow-auto rounded-sm bg-gray-900 p-3 text-xs leading-relaxed text-gray-100">{selected.rendered}</pre>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {saveAsOpen && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setSaveAsOpen(false)}>
          <div className="mx-4 w-full max-w-md rounded-lg bg-white shadow-xl dark:bg-robin-gray-800" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-robin-gray-700">
              <h3 className="text-lg font-semibold">Save as instance override</h3>
              <button onClick={() => setSaveAsOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"><X className="h-5 w-5" /></button>
            </div>
            <div className="space-y-4 p-4">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Save the current <strong>{selected.label}</strong> values as an override for a specific
                instance. Only the values that differ from the base are stored; the instance inherits
                everything else. The instance id must match the service id that instance's agent enrolls with.
              </p>
              <div>
                <label className="form-label">Instance id</label>
                <input
                  type="text"
                  value={saveAsName}
                  onChange={(e) => setSaveAsName(e.target.value)}
                  placeholder="e.g. inbound-spam-1"
                  className="form-input"
                  autoFocus
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-200 p-4 dark:border-robin-gray-700">
              <button onClick={() => setSaveAsOpen(false)} className="btn btn-secondary">Cancel</button>
              <button
                onClick={async () => {
                  const name = saveAsName.trim();
                  if (!name || name === 'default' || !onSaveFileAs) return;
                  await onSaveFileAs(selected.key, edited, name);
                  setSaveAsOpen(false);
                }}
                disabled={!saveAsName.trim() || saveAsName.trim() === 'default'}
                className="btn btn-primary"
              >
                <Copy className="h-4 w-4" />
                Save override
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
