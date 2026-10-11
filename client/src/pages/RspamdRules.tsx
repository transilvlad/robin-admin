import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { ApiError, rspamdApi } from '../api/client';
import type {
  RspamdActionOverride,
  RspamdActionThreshold,
  RspamdAdvancedValueType,
  RspamdCompositeRule,
  RspamdGroupRule,
  RspamdLocalMap,
  RspamdMultimapRule,
  RspamdRulesAdvancedOption,
  RspamdRulesDocument,
  RspamdRulesFileManagement,
  RspamdRulesState,
  RspamdScoreOverride,
  RspamdSettingsProfile,
  RspamdSymbolRule,
} from '../types';
import { PageServiceSelector } from '../components/fleet/PageServiceSelector';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import { useServices } from '../context/ServiceContext';

type Workspace = 'actions' | 'settings' | 'composites' | 'multimaps';

const EMPTY_STATE: RspamdRulesState = {
  settings: {
    serviceId: null,
    serviceName: null,
    rspamdControllerUrl: '',
    rspamdNormalUrl: '',
    hasControllerPassword: false,
    hasEnablePassword: false,
    rspamdConfigDir: '',
    rspamdStoreDir: '',
    rspamdTrainingDir: '',
  },
  status: {
    available: false,
    enabled: false,
    controllerReachable: false,
    controllerAuthenticated: false,
    controllerStatusCode: null,
    controllerPingOk: false,
    controllerPingStatusCode: null,
    controllerHealthyOk: false,
    controllerHealthyStatusCode: null,
    controllerStatAuthOk: false,
    controllerStatStatusCode: null,
    normalWorkerPingOk: false,
    normalWorkerPingStatusCode: null,
    configDir: { path: '', exists: false, readable: false, writable: false },
    storeDir: { path: '', exists: false, readable: false, writable: false },
    trainingDir: { path: '', exists: false, readable: false, writable: false },
    reasons: [],
    siblingSuggestion: null,
  },
  fileManagement: {
    actions: true,
    groups: true,
    settings: true,
    composites: true,
    multimap: true,
  },
  document: {
    actions: [],
    groups: [],
    settingsProfiles: [],
    composites: [],
    multimaps: [],
    localMaps: [],
  },
  files: {
    actions: { path: '', exists: false, readable: false, writable: false, managed: false, managementEnabled: true, content: null },
    groups: { path: '', exists: false, readable: false, writable: false, managed: false, managementEnabled: true, content: null },
    settings: { path: '', exists: false, readable: false, writable: false, managed: false, managementEnabled: true, content: null },
    composites: { path: '', exists: false, readable: false, writable: false, managed: false, managementEnabled: true, content: null },
    multimap: { path: '', exists: false, readable: false, writable: false, managed: false, managementEnabled: true, content: null },
    localMaps: [],
  },
  validation: { errors: [], warnings: [] },
};

function makeId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function splitCsv(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function joinCsv(values: string[]): string {
  return values.join(', ');
}

function emptyOption(): RspamdRulesAdvancedOption {
  return {
    id: makeId('option'),
    key: '',
    valueType: 'string',
    stringValue: '',
    numberValue: null,
    booleanValue: false,
    listValue: [],
  };
}

function emptyAction(): RspamdActionThreshold {
  return {
    id: makeId('action'),
    name: '',
    threshold: 0,
    enabled: true,
    flags: [],
    subject: '',
    growFactor: null,
    unknownWeight: null,
    options: [],
  };
}

function emptySymbol(): RspamdSymbolRule {
  return {
    id: makeId('symbol'),
    name: '',
    weight: 0,
    description: '',
    oneShot: false,
    enabled: true,
    options: [],
  };
}

function emptyGroup(): RspamdGroupRule {
  return {
    id: makeId('group'),
    name: '',
    description: '',
    maxScore: null,
    minScore: null,
    enabled: true,
    options: [],
    symbols: [],
  };
}

function emptyActionOverride(): RspamdActionOverride {
  return { id: makeId('action-override'), action: '', threshold: 0 };
}

function emptyScoreOverride(): RspamdScoreOverride {
  return { id: makeId('score-override'), name: '', score: 0 };
}

function emptyProfile(): RspamdSettingsProfile {
  return {
    id: makeId('profile'),
    name: '',
    profileId: '',
    priority: 0,
    enabled: true,
    description: '',
    conditions: {
      authenticated: null,
      local: null,
      ips: [],
      from: [],
      rcpt: [],
      domains: [],
      headers: [],
      selector: '',
      options: [],
    },
    apply: {
      actionOverrides: [],
      enableSymbols: [],
      disableSymbols: [],
      enableGroups: [],
      disableGroups: [],
      symbolScores: [],
      groupScores: [],
      options: [],
    },
    options: [],
  };
}

function emptyComposite(): RspamdCompositeRule {
  return {
    id: makeId('composite'),
    name: '',
    expression: '',
    description: '',
    score: null,
    policy: '',
    group: '',
    enabled: true,
    options: [],
  };
}

function emptyLocalMap(): RspamdLocalMap {
  return {
    id: makeId('local-map'),
    slug: '',
    name: '',
    description: '',
    content: '',
  };
}

function emptyMultimap(): RspamdMultimapRule {
  return {
    id: makeId('multimap'),
    name: '',
    ruleType: 'from',
    selector: '',
    description: '',
    score: null,
    oneShot: false,
    regexp: false,
    enabled: true,
    filter: '',
    source: {
      type: 'local',
      localMapSlug: '',
      url: '',
      redisKey: '',
      selector: '',
      externalDefinition: '',
      backend: '',
      options: [],
    },
    options: [],
  };
}

function ManagementToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange"
      />
      <div>
        <div className="text-sm font-medium">{label}</div>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{description}</p>
      </div>
    </label>
  );
}

function AdvancedOptionsEditor({
  options,
  onChange,
}: {
  options: RspamdRulesAdvancedOption[];
  onChange: (options: RspamdRulesAdvancedOption[]) => void;
}) {
  const updateOption = (id: string, patch: Partial<RspamdRulesAdvancedOption>) => {
    onChange(options.map((option) => (option.id === id ? { ...option, ...patch } : option)));
  };

  const removeOption = (id: string) => onChange(options.filter((option) => option.id !== id));

  return (
    <div className="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold">Advanced properties</h4>
          <p className="text-xs text-gray-500 dark:text-gray-400">Allowlisted typed fields for the wider Rspamd surface.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => onChange([...options, emptyOption()])}>
          <Plus className="h-4 w-4" />
          Add property
        </Button>
      </div>

      {options.length === 0 && (
        <div className="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
          No advanced properties yet.
        </div>
      )}

      {options.map((option) => (
        <div key={option.id} className="grid gap-3 rounded-lg border border-gray-200 p-3 md:grid-cols-[1.2fr_0.8fr_1.4fr_auto] dark:border-robin-gray-700">
          <Input label="Key" value={option.key} onChange={(event) => updateOption(option.id, { key: event.target.value })} />
          <label className="space-y-1 text-sm">
            <span className="block font-medium text-gray-700 dark:text-gray-300">Type</span>
            <select
              className="input"
              value={option.valueType}
              onChange={(event) => updateOption(option.id, { valueType: event.target.value as RspamdAdvancedValueType })}
            >
              <option value="string">String</option>
              <option value="number">Number</option>
              <option value="boolean">Boolean</option>
              <option value="stringList">String list</option>
            </select>
          </label>
          {option.valueType === 'string' && (
            <Input label="Value" value={option.stringValue} onChange={(event) => updateOption(option.id, { stringValue: event.target.value })} />
          )}
          {option.valueType === 'number' && (
            <Input
              label="Value"
              type="number"
              value={option.numberValue ?? ''}
              onChange={(event) => updateOption(option.id, { numberValue: event.target.value === '' ? null : Number(event.target.value) })}
            />
          )}
          {option.valueType === 'boolean' && (
            <label className="flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-robin-gray-700 md:mt-6">
              <input
                type="checkbox"
                checked={option.booleanValue}
                onChange={(event) => updateOption(option.id, { booleanValue: event.target.checked })}
                className="h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange"
              />
              <span>Enabled</span>
            </label>
          )}
          {option.valueType === 'stringList' && (
            <div className="space-y-1">
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">Value</span>
              <textarea
                className="input min-h-20 w-full"
                value={joinCsv(option.listValue)}
                onChange={(event) => updateOption(option.id, { listValue: splitCsv(event.target.value) })}
                placeholder="value1, value2"
              />
            </div>
          )}
          <div className="md:mt-6">
            <Button size="sm" variant="danger" onClick={() => removeOption(option.id)}>
              <Trash2 className="h-4 w-4" />
              Remove
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function RenderedFileCard({
  title,
  content,
  path,
  defaultOpen = false,
}: {
  title: string;
  content: string | null;
  path: string;
  defaultOpen?: boolean;
}) {
  return (
    <details className="card p-5" open={defaultOpen}>
      <summary className="cursor-pointer list-none">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold">{title}</h3>
            <div className="mt-1 font-mono text-xs text-gray-500 dark:text-gray-400">{path}</div>
          </div>
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Rendered preview</span>
        </div>
      </summary>
      <pre className="mt-4 max-h-80 overflow-auto rounded-lg bg-gray-950 p-4 text-xs text-gray-100">{content || '# No rendered content'}</pre>
    </details>
  );
}

export function RspamdRulesPage() {
  const { selectedRspamdService } = useServices();
  const [state, setState] = useState<RspamdRulesState>(EMPTY_STATE);
  const [draft, setDraft] = useState<RspamdRulesDocument>(EMPTY_STATE.document);
  const [fileManagement, setFileManagement] = useState<RspamdRulesFileManagement>(EMPTY_STATE.fileManagement);
  const [workspace, setWorkspace] = useState<Workspace>('actions');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const serviceId = selectedRspamdService?.serviceId;

  const load = useCallback(async () => {
    if (!serviceId) {
      setState(EMPTY_STATE);
      setDraft(EMPTY_STATE.document);
      setFileManagement(EMPTY_STATE.fileManagement);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError('');
    try {
      const response = await rspamdApi.getRules(serviceId);
      const nextState = response.data ?? EMPTY_STATE;
      setState(nextState);
      setDraft(nextState.document);
      setFileManagement(nextState.fileManagement);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load Rspamd rules');
    } finally {
      setIsLoading(false);
    }
  }, [serviceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const preview = async () => {
    if (!serviceId) return;
    setIsPreviewing(true);
    setError('');
    setSuccess('');
    try {
      const response = await rspamdApi.previewRules(draft, fileManagement, serviceId);
      setState(response.data ?? state);
      setDraft(response.data?.document ?? draft);
      setSuccess('Preview updated');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to preview rules');
    } finally {
      setIsPreviewing(false);
    }
  };

  const save = async () => {
    if (!serviceId) return;
    setIsSaving(true);
    setError('');
    setSuccess('');
    try {
      const response = await rspamdApi.updateRules(draft, fileManagement, serviceId);
      const nextState = response.data ?? state;
      setState(nextState);
      setDraft(nextState.document);
      setFileManagement(nextState.fileManagement);
      setSuccess(`Rspamd rules saved for ${selectedRspamdService?.name ?? serviceId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save Rspamd rules');
    } finally {
      setIsSaving(false);
    }
  };

  const updateDraft = (next: RspamdRulesDocument) => setDraft(next);

  const workspaceTabs: Array<{ key: Workspace; label: string }> = [
    { key: 'actions', label: 'Actions & Scores' },
    { key: 'settings', label: 'Settings profiles' },
    { key: 'composites', label: 'Composites' },
    { key: 'multimaps', label: 'Multimaps' },
  ];

  const renderedFiles = useMemo(() => ([
    { title: 'actions.conf', content: state.files.actions.content, path: state.files.actions.path },
    { title: 'groups.conf', content: state.files.groups.content, path: state.files.groups.path },
    { title: 'settings.conf', content: state.files.settings.content, path: state.files.settings.path },
    { title: 'composites.conf', content: state.files.composites.content, path: state.files.composites.path },
    { title: 'multimap.conf', content: state.files.multimap.content, path: state.files.multimap.path },
    ...state.files.localMaps.map((fileState, index) => ({
      title: draft.localMaps[index]?.slug ? `maps/${draft.localMaps[index].slug}.map` : 'local map',
      content: fileState.content,
      path: fileState.path,
    })),
  ]), [draft.localMaps, state.files]);

  if (!serviceId) {
    return (
      <div className="space-y-6">
        <PageHeader
          icon={appIcons.rspamdRules}
          title="Rspamd rules"
          description="Select an enabled Rspamd service before managing actions, settings profiles, composites, or multimaps."
          actions={<PageServiceSelector serviceType="rspamd" capability="rules" />}
        />
        <div className="rounded-lg border border-dashed border-gray-300 px-6 py-10 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
          No enabled Rspamd service is currently selected.
        </div>
      </div>
    );
  }

  if (isLoading) {
    return <div className="flex justify-center py-8"><Spinner className="text-robin-orange" /></div>;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.rspamdRules}
        title="Rspamd rules"
        description={<>Structured rule management for <strong>{selectedRspamdService?.name ?? serviceId}</strong>.</>}
        actions={
          <>
            <PageServiceSelector serviceType="rspamd" capability="rules" />
            <Button variant="secondary" onClick={() => load()}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
            <Button variant="secondary" onClick={preview} isLoading={isPreviewing}>
              <Eye className="h-4 w-4" />
              Preview
            </Button>
            <Button onClick={save} isLoading={isSaving}>
              <Save className="h-4 w-4" />
              Save
            </Button>
          </>
        }
      />

      {error && <div className="rounded-lg bg-red-100 p-3 text-red-700 dark:bg-red-900/20 dark:text-red-400">{error}</div>}
      {success && <div className="rounded-lg bg-green-100 p-3 text-green-700 dark:bg-green-900/20 dark:text-green-400">{success}</div>}

      <div className="grid gap-4 xl:grid-cols-4">
        <div className="card p-4">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Selected service</div>
          <div className="mt-2 text-lg font-semibold">{selectedRspamdService?.name ?? serviceId}</div>
          <div className="mt-1 font-mono text-xs text-gray-500 dark:text-gray-400">{serviceId}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Controller</div>
          <div className={`mt-2 text-lg font-semibold ${state.status.controllerReachable ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {state.status.controllerReachable ? 'Reachable' : 'Unavailable'}
          </div>
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{state.settings.rspamdControllerUrl || 'No controller URL configured'}</div>
          <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Password {state.settings.hasControllerPassword ? 'set' : 'not set'} · change it in Fleet → Services
          </div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Config store</div>
          <div className={`mt-2 text-lg font-semibold ${state.status.configDir.readable ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}>
            {state.status.configDir.readable ? 'Readable' : 'Check mount'}
          </div>
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{state.status.configDir.path || 'No config path configured'}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Generated files</div>
          <div className="mt-2 text-lg font-semibold">{renderedFiles.length}</div>
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">Including local multimap map files</div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ManagementToggle label="Manage actions.conf" description="Own action thresholds and custom action attributes." checked={Boolean(fileManagement.actions)} onChange={(checked) => setFileManagement((current) => ({ ...current, actions: checked }))} />
        <ManagementToggle label="Manage groups.conf" description="Own groups, symbols, and score overrides." checked={Boolean(fileManagement.groups)} onChange={(checked) => setFileManagement((current) => ({ ...current, groups: checked }))} />
        <ManagementToggle label="Manage settings.conf" description="Own settings profiles, match conditions, and apply blocks." checked={Boolean(fileManagement.settings)} onChange={(checked) => setFileManagement((current) => ({ ...current, settings: checked }))} />
        <ManagementToggle label="Manage composites.conf" description="Own composite rule definitions and metadata." checked={Boolean(fileManagement.composites)} onChange={(checked) => setFileManagement((current) => ({ ...current, composites: checked }))} />
        <ManagementToggle label="Manage multimap.conf" description="Own multimap rules and local map resources." checked={Boolean(fileManagement.multimap)} onChange={(checked) => setFileManagement((current) => ({ ...current, multimap: checked }))} />
      </div>

      <div className="flex flex-wrap gap-3">
        {workspaceTabs.map((tab) => (
          <Button
            key={tab.key}
            variant={workspace === tab.key ? 'primary' : 'secondary'}
            onClick={() => setWorkspace(tab.key)}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      <div className="grid gap-6 2xl:grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          {workspace === 'actions' && (
            <>
              <section className="card space-y-5 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">Actions</h2>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Thresholds, flags, and custom action attributes.</p>
                  </div>
                  <Button variant="secondary" onClick={() => updateDraft({ ...draft, actions: [...draft.actions, emptyAction()] })}>
                    <Plus className="h-4 w-4" />
                    Add action
                  </Button>
                </div>
                {draft.actions.map((action) => (
                  <div key={action.id} className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
                    <div className="flex items-center justify-between">
                      <h3 className="font-medium">{action.name || 'New action'}</h3>
                      <Button variant="danger" size="sm" onClick={() => updateDraft({ ...draft, actions: draft.actions.filter((item) => item.id !== action.id) })}>
                        <Trash2 className="h-4 w-4" />
                        Remove
                      </Button>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                      <Input label="Action name" value={action.name} onChange={(event) => updateDraft({ ...draft, actions: draft.actions.map((item) => item.id === action.id ? { ...item, name: event.target.value } : item) })} />
                      <Input label="Threshold" type="number" value={action.threshold} onChange={(event) => updateDraft({ ...draft, actions: draft.actions.map((item) => item.id === action.id ? { ...item, threshold: Number(event.target.value) } : item) })} />
                      <Input label="Flags" value={joinCsv(action.flags)} onChange={(event) => updateDraft({ ...draft, actions: draft.actions.map((item) => item.id === action.id ? { ...item, flags: splitCsv(event.target.value) } : item) })} placeholder="no_threshold, no_stat" />
                      <Input label="Subject" value={action.subject} onChange={(event) => updateDraft({ ...draft, actions: draft.actions.map((item) => item.id === action.id ? { ...item, subject: event.target.value } : item) })} />
                      <Input label="Grow factor" type="number" value={action.growFactor ?? ''} onChange={(event) => updateDraft({ ...draft, actions: draft.actions.map((item) => item.id === action.id ? { ...item, growFactor: event.target.value === '' ? null : Number(event.target.value) } : item) })} />
                      <Input label="Unknown weight" type="number" value={action.unknownWeight ?? ''} onChange={(event) => updateDraft({ ...draft, actions: draft.actions.map((item) => item.id === action.id ? { ...item, unknownWeight: event.target.value === '' ? null : Number(event.target.value) } : item) })} />
                    </div>
                    <label className="flex items-center gap-3 text-sm">
                      <input type="checkbox" checked={action.enabled} onChange={(event) => updateDraft({ ...draft, actions: draft.actions.map((item) => item.id === action.id ? { ...item, enabled: event.target.checked } : item) })} className="h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange" />
                      <span>Enabled</span>
                    </label>
                    <AdvancedOptionsEditor options={action.options} onChange={(options) => updateDraft({ ...draft, actions: draft.actions.map((item) => item.id === action.id ? { ...item, options } : item) })} />
                  </div>
                ))}
              </section>

              <section className="card space-y-5 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">Groups & symbols</h2>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Group caps, descriptions, and symbol weights.</p>
                  </div>
                  <Button variant="secondary" onClick={() => updateDraft({ ...draft, groups: [...draft.groups, emptyGroup()] })}>
                    <Plus className="h-4 w-4" />
                    Add group
                  </Button>
                </div>
                {draft.groups.map((group) => (
                  <div key={group.id} className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
                    <div className="flex items-center justify-between">
                      <h3 className="font-medium">{group.name || 'New group'}</h3>
                      <Button variant="danger" size="sm" onClick={() => updateDraft({ ...draft, groups: draft.groups.filter((item) => item.id !== group.id) })}>
                        <Trash2 className="h-4 w-4" />
                        Remove
                      </Button>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                      <Input label="Group name" value={group.name} onChange={(event) => updateDraft({ ...draft, groups: draft.groups.map((item) => item.id === group.id ? { ...item, name: event.target.value } : item) })} />
                      <Input label="Description" value={group.description} onChange={(event) => updateDraft({ ...draft, groups: draft.groups.map((item) => item.id === group.id ? { ...item, description: event.target.value } : item) })} />
                      <Input label="Max score" type="number" value={group.maxScore ?? ''} onChange={(event) => updateDraft({ ...draft, groups: draft.groups.map((item) => item.id === group.id ? { ...item, maxScore: event.target.value === '' ? null : Number(event.target.value) } : item) })} />
                      <Input label="Min score" type="number" value={group.minScore ?? ''} onChange={(event) => updateDraft({ ...draft, groups: draft.groups.map((item) => item.id === group.id ? { ...item, minScore: event.target.value === '' ? null : Number(event.target.value) } : item) })} />
                    </div>
                    <label className="flex items-center gap-3 text-sm">
                      <input type="checkbox" checked={group.enabled} onChange={(event) => updateDraft({ ...draft, groups: draft.groups.map((item) => item.id === group.id ? { ...item, enabled: event.target.checked } : item) })} className="h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange" />
                      <span>Enabled</span>
                    </label>
                    <AdvancedOptionsEditor options={group.options} onChange={(options) => updateDraft({ ...draft, groups: draft.groups.map((item) => item.id === group.id ? { ...item, options } : item) })} />

                    <div className="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
                      <div className="flex items-center justify-between">
                        <div>
                          <h4 className="text-sm font-semibold">Symbols</h4>
                          <p className="text-xs text-gray-500 dark:text-gray-400">Explicit symbol weights and overrides for this group.</p>
                        </div>
                        <Button size="sm" variant="secondary" onClick={() => updateDraft({ ...draft, groups: draft.groups.map((item) => item.id === group.id ? { ...item, symbols: [...item.symbols, emptySymbol()] } : item) })}>
                          <Plus className="h-4 w-4" />
                          Add symbol
                        </Button>
                      </div>
                      {group.symbols.map((symbol) => (
                        <div key={symbol.id} className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-robin-gray-700">
                          <div className="flex items-center justify-between">
                            <h5 className="text-sm font-medium">{symbol.name || 'New symbol'}</h5>
                            <Button size="sm" variant="danger" onClick={() => updateDraft({ ...draft, groups: draft.groups.map((item) => item.id === group.id ? { ...item, symbols: item.symbols.filter((entry) => entry.id !== symbol.id) } : item) })}>
                              <Trash2 className="h-4 w-4" />
                              Remove
                            </Button>
                          </div>
                          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                            <Input label="Symbol name" value={symbol.name} onChange={(event) => updateDraft({ ...draft, groups: draft.groups.map((item) => item.id === group.id ? { ...item, symbols: item.symbols.map((entry) => entry.id === symbol.id ? { ...entry, name: event.target.value } : entry) } : item) })} />
                            <Input label="Weight" type="number" value={symbol.weight} onChange={(event) => updateDraft({ ...draft, groups: draft.groups.map((item) => item.id === group.id ? { ...item, symbols: item.symbols.map((entry) => entry.id === symbol.id ? { ...entry, weight: Number(event.target.value) } : entry) } : item) })} />
                            <Input label="Description" value={symbol.description} onChange={(event) => updateDraft({ ...draft, groups: draft.groups.map((item) => item.id === group.id ? { ...item, symbols: item.symbols.map((entry) => entry.id === symbol.id ? { ...entry, description: event.target.value } : entry) } : item) })} />
                            <div className="flex gap-4 pt-6 text-sm">
                              <label className="flex items-center gap-2"><input type="checkbox" checked={symbol.enabled} onChange={(event) => updateDraft({ ...draft, groups: draft.groups.map((item) => item.id === group.id ? { ...item, symbols: item.symbols.map((entry) => entry.id === symbol.id ? { ...entry, enabled: event.target.checked } : entry) } : item) })} className="h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange" />Enabled</label>
                              <label className="flex items-center gap-2"><input type="checkbox" checked={symbol.oneShot} onChange={(event) => updateDraft({ ...draft, groups: draft.groups.map((item) => item.id === group.id ? { ...item, symbols: item.symbols.map((entry) => entry.id === symbol.id ? { ...entry, oneShot: event.target.checked } : entry) } : item) })} className="h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange" />One shot</label>
                            </div>
                          </div>
                          <AdvancedOptionsEditor options={symbol.options} onChange={(options) => updateDraft({ ...draft, groups: draft.groups.map((item) => item.id === group.id ? { ...item, symbols: item.symbols.map((entry) => entry.id === symbol.id ? { ...entry, options } : entry) } : item) })} />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            </>
          )}

          {workspace === 'settings' && (
            <section className="card space-y-5 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Settings profiles</h2>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Match conditions and apply blocks for profile-driven overrides.</p>
                </div>
                <Button variant="secondary" onClick={() => updateDraft({ ...draft, settingsProfiles: [...draft.settingsProfiles, emptyProfile()] })}>
                  <Plus className="h-4 w-4" />
                  Add profile
                </Button>
              </div>
              {draft.settingsProfiles.map((profile) => (
                <div key={profile.id} className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
                  <div className="flex items-center justify-between">
                    <h3 className="font-medium">{profile.name || 'New profile'}</h3>
                    <Button size="sm" variant="danger" onClick={() => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.filter((item) => item.id !== profile.id) })}>
                      <Trash2 className="h-4 w-4" />
                      Remove
                    </Button>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <Input label="Profile name" value={profile.name} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, name: event.target.value } : item) })} />
                    <Input label="Settings id" value={profile.profileId} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, profileId: event.target.value } : item) })} />
                    <Input label="Priority" type="number" value={profile.priority} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, priority: Number(event.target.value) } : item) })} />
                    <Input label="Description" value={profile.description} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, description: event.target.value } : item) })} />
                  </div>
                  <label className="flex items-center gap-3 text-sm">
                    <input type="checkbox" checked={profile.enabled} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, enabled: event.target.checked } : item) })} className="h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange" />
                    <span>Enabled</span>
                  </label>

                  <div className="grid gap-4 xl:grid-cols-2">
                    <div className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
                      <div>
                        <h4 className="text-sm font-semibold">Conditions</h4>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Matchers for authenticated mail, addresses, domains, IPs, and selectors.</p>
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        <Input label="From" value={joinCsv(profile.conditions.from)} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, conditions: { ...item.conditions, from: splitCsv(event.target.value) } } : item) })} />
                        <Input label="Recipients" value={joinCsv(profile.conditions.rcpt)} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, conditions: { ...item.conditions, rcpt: splitCsv(event.target.value) } } : item) })} />
                        <Input label="Domains" value={joinCsv(profile.conditions.domains)} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, conditions: { ...item.conditions, domains: splitCsv(event.target.value) } } : item) })} />
                        <Input label="IPs" value={joinCsv(profile.conditions.ips)} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, conditions: { ...item.conditions, ips: splitCsv(event.target.value) } } : item) })} />
                        <Input label="Request headers" value={joinCsv(profile.conditions.headers)} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, conditions: { ...item.conditions, headers: splitCsv(event.target.value) } } : item) })} />
                        <Input label="Selector" value={profile.conditions.selector} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, conditions: { ...item.conditions, selector: event.target.value } } : item) })} />
                      </div>
                      <div className="flex gap-4 text-sm">
                        <label className="flex items-center gap-2"><input type="checkbox" checked={profile.conditions.authenticated ?? false} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, conditions: { ...item.conditions, authenticated: event.target.checked } } : item) })} className="h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange" />Authenticated</label>
                        <label className="flex items-center gap-2"><input type="checkbox" checked={profile.conditions.local ?? false} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, conditions: { ...item.conditions, local: event.target.checked } } : item) })} className="h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange" />Local</label>
                      </div>
                      <AdvancedOptionsEditor options={profile.conditions.options} onChange={(options) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, conditions: { ...item.conditions, options } } : item) })} />
                    </div>

                    <div className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
                      <div>
                        <h4 className="text-sm font-semibold">Apply</h4>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Override actions, enable or disable symbols/groups, and tune scores.</p>
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        <Input label="Enable symbols" value={joinCsv(profile.apply.enableSymbols)} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, apply: { ...item.apply, enableSymbols: splitCsv(event.target.value) } } : item) })} />
                        <Input label="Disable symbols" value={joinCsv(profile.apply.disableSymbols)} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, apply: { ...item.apply, disableSymbols: splitCsv(event.target.value) } } : item) })} />
                        <Input label="Enable groups" value={joinCsv(profile.apply.enableGroups)} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, apply: { ...item.apply, enableGroups: splitCsv(event.target.value) } } : item) })} />
                        <Input label="Disable groups" value={joinCsv(profile.apply.disableGroups)} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, apply: { ...item.apply, disableGroups: splitCsv(event.target.value) } } : item) })} />
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h5 className="text-sm font-medium">Action overrides</h5>
                          <Button size="sm" variant="secondary" onClick={() => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, apply: { ...item.apply, actionOverrides: [...item.apply.actionOverrides, emptyActionOverride()] } } : item) })}>
                            <Plus className="h-4 w-4" />
                            Add
                          </Button>
                        </div>
                        {profile.apply.actionOverrides.map((override) => (
                          <div key={override.id} className="grid gap-3 md:grid-cols-[1fr_180px_auto]">
                            <Input label="Action" value={override.action} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, apply: { ...item.apply, actionOverrides: item.apply.actionOverrides.map((entry) => entry.id === override.id ? { ...entry, action: event.target.value } : entry) } } : item) })} />
                            <Input label="Threshold" type="number" value={override.threshold} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, apply: { ...item.apply, actionOverrides: item.apply.actionOverrides.map((entry) => entry.id === override.id ? { ...entry, threshold: Number(event.target.value) } : entry) } } : item) })} />
                            <div className="pt-6"><Button size="sm" variant="danger" onClick={() => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, apply: { ...item.apply, actionOverrides: item.apply.actionOverrides.filter((entry) => entry.id !== override.id) } } : item) })}><Trash2 className="h-4 w-4" />Remove</Button></div>
                          </div>
                        ))}
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h5 className="text-sm font-medium">Symbol score overrides</h5>
                          <Button size="sm" variant="secondary" onClick={() => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, apply: { ...item.apply, symbolScores: [...item.apply.symbolScores, emptyScoreOverride()] } } : item) })}>
                            <Plus className="h-4 w-4" />
                            Add
                          </Button>
                        </div>
                        {profile.apply.symbolScores.map((override) => (
                          <div key={override.id} className="grid gap-3 md:grid-cols-[1fr_180px_auto]">
                            <Input label="Symbol" value={override.name} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, apply: { ...item.apply, symbolScores: item.apply.symbolScores.map((entry) => entry.id === override.id ? { ...entry, name: event.target.value } : entry) } } : item) })} />
                            <Input label="Score" type="number" value={override.score} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, apply: { ...item.apply, symbolScores: item.apply.symbolScores.map((entry) => entry.id === override.id ? { ...entry, score: Number(event.target.value) } : entry) } } : item) })} />
                            <div className="pt-6"><Button size="sm" variant="danger" onClick={() => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, apply: { ...item.apply, symbolScores: item.apply.symbolScores.filter((entry) => entry.id !== override.id) } } : item) })}><Trash2 className="h-4 w-4" />Remove</Button></div>
                          </div>
                        ))}
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h5 className="text-sm font-medium">Group score overrides</h5>
                          <Button size="sm" variant="secondary" onClick={() => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, apply: { ...item.apply, groupScores: [...item.apply.groupScores, emptyScoreOverride()] } } : item) })}>
                            <Plus className="h-4 w-4" />
                            Add
                          </Button>
                        </div>
                        {profile.apply.groupScores.map((override) => (
                          <div key={override.id} className="grid gap-3 md:grid-cols-[1fr_180px_auto]">
                            <Input label="Group" value={override.name} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, apply: { ...item.apply, groupScores: item.apply.groupScores.map((entry) => entry.id === override.id ? { ...entry, name: event.target.value } : entry) } } : item) })} />
                            <Input label="Score" type="number" value={override.score} onChange={(event) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, apply: { ...item.apply, groupScores: item.apply.groupScores.map((entry) => entry.id === override.id ? { ...entry, score: Number(event.target.value) } : entry) } } : item) })} />
                            <div className="pt-6"><Button size="sm" variant="danger" onClick={() => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, apply: { ...item.apply, groupScores: item.apply.groupScores.filter((entry) => entry.id !== override.id) } } : item) })}><Trash2 className="h-4 w-4" />Remove</Button></div>
                          </div>
                        ))}
                      </div>

                      <AdvancedOptionsEditor options={profile.apply.options} onChange={(options) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, apply: { ...item.apply, options } } : item) })} />
                    </div>
                  </div>

                  <AdvancedOptionsEditor options={profile.options} onChange={(options) => updateDraft({ ...draft, settingsProfiles: draft.settingsProfiles.map((item) => item.id === profile.id ? { ...item, options } : item) })} />
                </div>
              ))}
            </section>
          )}

          {workspace === 'composites' && (
            <section className="card space-y-5 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Composites</h2>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Composite symbols, expressions, and optional score metadata.</p>
                </div>
                <Button variant="secondary" onClick={() => updateDraft({ ...draft, composites: [...draft.composites, emptyComposite()] })}>
                  <Plus className="h-4 w-4" />
                  Add composite
                </Button>
              </div>
              {draft.composites.map((composite) => (
                <div key={composite.id} className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
                  <div className="flex items-center justify-between">
                    <h3 className="font-medium">{composite.name || 'New composite'}</h3>
                    <Button size="sm" variant="danger" onClick={() => updateDraft({ ...draft, composites: draft.composites.filter((item) => item.id !== composite.id) })}>
                      <Trash2 className="h-4 w-4" />
                      Remove
                    </Button>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <Input label="Composite name" value={composite.name} onChange={(event) => updateDraft({ ...draft, composites: draft.composites.map((item) => item.id === composite.id ? { ...item, name: event.target.value } : item) })} />
                    <Input label="Expression" value={composite.expression} onChange={(event) => updateDraft({ ...draft, composites: draft.composites.map((item) => item.id === composite.id ? { ...item, expression: event.target.value } : item) })} />
                    <Input label="Score" type="number" value={composite.score ?? ''} onChange={(event) => updateDraft({ ...draft, composites: draft.composites.map((item) => item.id === composite.id ? { ...item, score: event.target.value === '' ? null : Number(event.target.value) } : item) })} />
                    <Input label="Group" value={composite.group} onChange={(event) => updateDraft({ ...draft, composites: draft.composites.map((item) => item.id === composite.id ? { ...item, group: event.target.value } : item) })} />
                    <Input label="Policy" value={composite.policy} onChange={(event) => updateDraft({ ...draft, composites: draft.composites.map((item) => item.id === composite.id ? { ...item, policy: event.target.value } : item) })} />
                    <Input label="Description" value={composite.description} onChange={(event) => updateDraft({ ...draft, composites: draft.composites.map((item) => item.id === composite.id ? { ...item, description: event.target.value } : item) })} />
                  </div>
                  <label className="flex items-center gap-3 text-sm">
                    <input type="checkbox" checked={composite.enabled} onChange={(event) => updateDraft({ ...draft, composites: draft.composites.map((item) => item.id === composite.id ? { ...item, enabled: event.target.checked } : item) })} className="h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange" />
                    <span>Enabled</span>
                  </label>
                  <AdvancedOptionsEditor options={composite.options} onChange={(options) => updateDraft({ ...draft, composites: draft.composites.map((item) => item.id === composite.id ? { ...item, options } : item) })} />
                </div>
              ))}
            </section>
          )}

          {workspace === 'multimaps' && (
            <>
              <section className="card space-y-5 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">Multimap rules</h2>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Local, remote, Redis, selector, and external map definitions.</p>
                  </div>
                  <Button variant="secondary" onClick={() => updateDraft({ ...draft, multimaps: [...draft.multimaps, emptyMultimap()] })}>
                    <Plus className="h-4 w-4" />
                    Add multimap
                  </Button>
                </div>
                {draft.multimaps.map((rule) => (
                  <div key={rule.id} className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
                    <div className="flex items-center justify-between">
                      <h3 className="font-medium">{rule.name || 'New multimap'}</h3>
                      <Button size="sm" variant="danger" onClick={() => updateDraft({ ...draft, multimaps: draft.multimaps.filter((item) => item.id !== rule.id) })}>
                        <Trash2 className="h-4 w-4" />
                        Remove
                      </Button>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                      <Input label="Rule name" value={rule.name} onChange={(event) => updateDraft({ ...draft, multimaps: draft.multimaps.map((item) => item.id === rule.id ? { ...item, name: event.target.value } : item) })} />
                      <Input label="Rule type" value={rule.ruleType} onChange={(event) => updateDraft({ ...draft, multimaps: draft.multimaps.map((item) => item.id === rule.id ? { ...item, ruleType: event.target.value } : item) })} />
                      <Input label="Selector" value={rule.selector} onChange={(event) => updateDraft({ ...draft, multimaps: draft.multimaps.map((item) => item.id === rule.id ? { ...item, selector: event.target.value } : item) })} />
                      <Input label="Score" type="number" value={rule.score ?? ''} onChange={(event) => updateDraft({ ...draft, multimaps: draft.multimaps.map((item) => item.id === rule.id ? { ...item, score: event.target.value === '' ? null : Number(event.target.value) } : item) })} />
                      <Input label="Description" value={rule.description} onChange={(event) => updateDraft({ ...draft, multimaps: draft.multimaps.map((item) => item.id === rule.id ? { ...item, description: event.target.value } : item) })} />
                      <Input label="Filter" value={rule.filter} onChange={(event) => updateDraft({ ...draft, multimaps: draft.multimaps.map((item) => item.id === rule.id ? { ...item, filter: event.target.value } : item) })} />
                    </div>
                    <div className="flex flex-wrap gap-4 text-sm">
                      <label className="flex items-center gap-2"><input type="checkbox" checked={rule.enabled} onChange={(event) => updateDraft({ ...draft, multimaps: draft.multimaps.map((item) => item.id === rule.id ? { ...item, enabled: event.target.checked } : item) })} className="h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange" />Enabled</label>
                      <label className="flex items-center gap-2"><input type="checkbox" checked={rule.oneShot} onChange={(event) => updateDraft({ ...draft, multimaps: draft.multimaps.map((item) => item.id === rule.id ? { ...item, oneShot: event.target.checked } : item) })} className="h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange" />One shot</label>
                      <label className="flex items-center gap-2"><input type="checkbox" checked={rule.regexp} onChange={(event) => updateDraft({ ...draft, multimaps: draft.multimaps.map((item) => item.id === rule.id ? { ...item, regexp: event.target.checked } : item) })} className="h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange" />Regexp</label>
                    </div>

                    <div className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
                      <div>
                        <h4 className="text-sm font-semibold">Source</h4>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Choose a local file map, remote URL, Redis key, selector map, or external object.</p>
                      </div>
                      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                        <label className="space-y-1 text-sm">
                          <span className="block font-medium text-gray-700 dark:text-gray-300">Source type</span>
                          <select className="input" value={rule.source.type} onChange={(event) => updateDraft({ ...draft, multimaps: draft.multimaps.map((item) => item.id === rule.id ? { ...item, source: { ...item.source, type: event.target.value as RspamdMultimapRule['source']['type'] } } : item) })}>
                            <option value="local">Local file</option>
                            <option value="http">HTTP</option>
                            <option value="https">HTTPS</option>
                            <option value="redis">Redis</option>
                            <option value="selector">Selector</option>
                            <option value="external">External object</option>
                          </select>
                        </label>
                        <Input label="Local map slug" value={rule.source.localMapSlug} onChange={(event) => updateDraft({ ...draft, multimaps: draft.multimaps.map((item) => item.id === rule.id ? { ...item, source: { ...item.source, localMapSlug: event.target.value } } : item) })} />
                        <Input label="Remote URL" value={rule.source.url} onChange={(event) => updateDraft({ ...draft, multimaps: draft.multimaps.map((item) => item.id === rule.id ? { ...item, source: { ...item.source, url: event.target.value } } : item) })} />
                        <Input label="Redis key" value={rule.source.redisKey} onChange={(event) => updateDraft({ ...draft, multimaps: draft.multimaps.map((item) => item.id === rule.id ? { ...item, source: { ...item.source, redisKey: event.target.value } } : item) })} />
                        <Input label="Source selector" value={rule.source.selector} onChange={(event) => updateDraft({ ...draft, multimaps: draft.multimaps.map((item) => item.id === rule.id ? { ...item, source: { ...item.source, selector: event.target.value } } : item) })} />
                        <Input label="Backend" value={rule.source.backend} onChange={(event) => updateDraft({ ...draft, multimaps: draft.multimaps.map((item) => item.id === rule.id ? { ...item, source: { ...item.source, backend: event.target.value } } : item) })} />
                      </div>
                      <div className="space-y-1">
                        <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">External map object</span>
                        <textarea className="input min-h-24 w-full" value={rule.source.externalDefinition} onChange={(event) => updateDraft({ ...draft, multimaps: draft.multimaps.map((item) => item.id === rule.id ? { ...item, source: { ...item.source, externalDefinition: event.target.value } } : item) })} />
                      </div>
                      <AdvancedOptionsEditor options={rule.source.options} onChange={(options) => updateDraft({ ...draft, multimaps: draft.multimaps.map((item) => item.id === rule.id ? { ...item, source: { ...item.source, options } } : item) })} />
                    </div>

                    <AdvancedOptionsEditor options={rule.options} onChange={(options) => updateDraft({ ...draft, multimaps: draft.multimaps.map((item) => item.id === rule.id ? { ...item, options } : item) })} />
                  </div>
                ))}
              </section>

              <section className="card space-y-5 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">Local maps</h2>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Inline content editors for file-backed multimap resources.</p>
                  </div>
                  <Button variant="secondary" onClick={() => updateDraft({ ...draft, localMaps: [...draft.localMaps, emptyLocalMap()] })}>
                    <Plus className="h-4 w-4" />
                    Add local map
                  </Button>
                </div>
                {draft.localMaps.map((map) => (
                  <div key={map.id} className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
                    <div className="flex items-center justify-between">
                      <h3 className="font-medium">{map.slug || 'New local map'}</h3>
                      <Button size="sm" variant="danger" onClick={() => updateDraft({ ...draft, localMaps: draft.localMaps.filter((item) => item.id !== map.id) })}>
                        <Trash2 className="h-4 w-4" />
                        Remove
                      </Button>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                      <Input label="Slug" value={map.slug} onChange={(event) => updateDraft({ ...draft, localMaps: draft.localMaps.map((item) => item.id === map.id ? { ...item, slug: event.target.value } : item) })} />
                      <Input label="Name" value={map.name} onChange={(event) => updateDraft({ ...draft, localMaps: draft.localMaps.map((item) => item.id === map.id ? { ...item, name: event.target.value } : item) })} />
                      <Input label="Description" value={map.description} onChange={(event) => updateDraft({ ...draft, localMaps: draft.localMaps.map((item) => item.id === map.id ? { ...item, description: event.target.value } : item) })} />
                    </div>
                    <div className="space-y-1">
                      <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">Map content</span>
                      <textarea className="input min-h-40 w-full font-mono text-xs" value={map.content} onChange={(event) => updateDraft({ ...draft, localMaps: draft.localMaps.map((item) => item.id === map.id ? { ...item, content: event.target.value } : item) })} placeholder={"one value per line\n@example.com"} />
                    </div>
                  </div>
                ))}
              </section>
            </>
          )}
        </div>

        <div className="space-y-6">
          <section className="card space-y-4 p-5">
            <div>
              <h2 className="text-lg font-semibold">Validation</h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Preview or save runs the same server-side validation and renderer.</p>
            </div>
            {state.validation.errors.length === 0 && state.validation.warnings.length === 0 && (
              <div className="rounded-lg bg-green-100 p-3 text-sm text-green-700 dark:bg-green-900/20 dark:text-green-400">
                No validation issues detected in the current preview.
              </div>
            )}
            {state.validation.errors.length > 0 && (
              <div className="rounded-lg bg-red-100 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
                <div className="font-medium">Errors</div>
                <ul className="mt-2 space-y-1">
                  {state.validation.errors.map((message) => <li key={message}>{message}</li>)}
                </ul>
              </div>
            )}
            {state.validation.warnings.length > 0 && (
              <div className="rounded-lg bg-amber-100 p-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
                <div className="font-medium">Warnings</div>
                <ul className="mt-2 space-y-1">
                  {state.validation.warnings.map((message) => <li key={message}>{message}</li>)}
                </ul>
              </div>
            )}
          </section>

          {renderedFiles.map((file) => (
            <RenderedFileCard
              key={file.title}
              title={file.title}
              content={file.content}
              path={file.path}
              defaultOpen={
                (workspace === 'actions' && (file.title === 'actions.conf' || file.title === 'groups.conf'))
                || (workspace === 'settings' && file.title === 'settings.conf')
                || (workspace === 'composites' && file.title === 'composites.conf')
                || (workspace === 'multimaps' && (file.title === 'multimap.conf' || file.title.startsWith('maps/')))
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}
