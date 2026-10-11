import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, RotateCw } from 'lucide-react';
import { ApiError, postfixApi } from '../api/client';
import { PerFileConfigPage, type PerFileConfigFile } from '../components/fleet/PerFileConfigPage';
import { Button } from '../components/ui/Button';
import { appIcons } from '../constants/appIcons';
import { POSTFIX_CORE_SECTIONS, POSTFIX_MANAGED_FILE_CATALOG } from '../constants/managedConfigFiles';
import { useServices } from '../context/ServiceContext';
import type { PostfixConfigState } from '../types';
import { useServiceCapabilities } from '../context/FeaturesContext';

const CORE_KEYS = new Set(POSTFIX_CORE_SECTIONS.map((s) => s.key));

/** Split a textarea value into cleaned lines (one postfix rule per line). */
function toLines(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((l) => l.trim()).filter(Boolean);
  return String(value ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
}

export function PostfixConfigPage() {
  const { selectedPostfixService, postfixServices } = useServices();
  const [state, setState] = useState<PostfixConfigState | null>(null);
  const [baseState, setBaseState] = useState<PostfixConfigState | null>(null);
  const [rendered, setRendered] = useState({ mainCf: '', headerChecks: '', bodyChecks: '' });
  const [scopeId, setScopeId] = useState('default');
  const [overrideScopes, setOverrideScopes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isReloading, setIsReloading] = useState(false);
  // Reload runs against one instance, and only where its setup supports it.
  const { can: canScope } = useServiceCapabilities(scopeId === 'default' ? null : scopeId);
  const canReload = canScope('reload');

  useEffect(() => {
    if (selectedPostfixService?.serviceId) {
      setScopeId(selectedPostfixService.serviceId);
    }
  }, [selectedPostfixService?.serviceId]);

  const refreshScopes = useCallback(async () => {
    try {
      const res = await postfixApi.getConfigScopes();
      setOverrideScopes(res.data ?? []);
    } catch { /* non-fatal */ }
  }, []);
  useEffect(() => { void refreshScopes(); }, [refreshScopes]);

  const scopes = Array.from(new Set<string>([
    'default',
    ...postfixServices.map((s) => s.serviceId),
    ...overrideScopes,
    ...(selectedPostfixService?.serviceId ? [selectedPostfixService.serviceId] : []),
  ]));

  const scopeRef = useRef(scopeId);
  scopeRef.current = scopeId;

  const load = useCallback(async () => {
    const req = scopeId;
    setLoading(true);
    setError('');
    try {
      const [config, renderedRes, baseRes] = await Promise.all([
        postfixApi.getConfig(scopeId),
        postfixApi.getRenderedConfig(scopeId),
        scopeId === 'default' ? Promise.resolve(null) : postfixApi.getConfig('default'),
      ]);
      if (scopeRef.current !== req) return;
      setState(config.data ?? null);
      setBaseState(baseRes?.data ?? null);
      setRendered(renderedRes.data ?? { mainCf: '', headerChecks: '', bodyChecks: '' });
    } catch (err) {
      if (scopeRef.current !== req) return;
      setError(err instanceof ApiError ? err.message : 'Failed to load Postfix configuration');
    } finally {
      if (scopeRef.current === req) setLoading(false);
    }
  }, [scopeId]);

  useEffect(() => { void load(); }, [load]);

  const handleSaveFile = async (key: string, values: Record<string, unknown>) => {
    if (!state) return;
    setSavingKey(key);
    setError('');
    setSuccess('');
    try {
      if (CORE_KEYS.has(key)) {
        const patch: Record<string, unknown> = { ...state.managed, ...values };
        if ('headerChecks' in values) patch.headerChecks = toLines(values.headerChecks);
        if ('bodyChecks' in values) patch.bodyChecks = toLines(values.bodyChecks);
        await postfixApi.updateConfig(scopeId, patch as Partial<typeof state.managed>);
      } else {
        await postfixApi.saveConfigFile(scopeId, key, values);
      }
      setSuccess(`Postfix config saved for ${scopeId === 'default' ? 'Default (base)' : scopeId}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to save ${key} config`);
    } finally {
      setSavingKey(null);
    }
  };

  const handleSaveFileAs = async (key: string, values: Record<string, unknown>, newScopeId: string) => {
    if (!state) return;
    setSavingKey(key);
    setError('');
    setSuccess('');
    try {
      if (CORE_KEYS.has(key)) {
        const patch: Record<string, unknown> = { ...state.managed, ...values };
        if ('headerChecks' in values) patch.headerChecks = toLines(values.headerChecks);
        if ('bodyChecks' in values) patch.bodyChecks = toLines(values.bodyChecks);
        await postfixApi.updateConfig(newScopeId, patch as Partial<typeof state.managed>);
      } else {
        await postfixApi.saveConfigFile(newScopeId, key, values);
      }
      await refreshScopes();
      setSuccess(`Saved ${key} override for ${newScopeId}`);
      setScopeId(newScopeId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to save ${key} override`);
    } finally {
      setSavingKey(null);
    }
  };

  const handleResetFile = async (key: string) => {
    setSavingKey(key);
    setError('');
    setSuccess('');
    try {
      await postfixApi.resetConfigFile(scopeId, key);
      setSuccess(`Reset ${key} to base for ${scopeId}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to reset ${key}`);
    } finally {
      setSavingKey(null);
    }
  };

  const handleReload = async () => {
    setIsReloading(true);
    setError('');
    try {
      const res = await postfixApi.reload(scopeId);
      setSuccess(res.data?.response ?? 'Postfix reload requested');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reload Postfix');
    } finally {
      setIsReloading(false);
    }
  };

  const managed = state?.managed as unknown as Record<string, unknown> | undefined;
  const baseManaged = baseState?.managed as unknown as Record<string, unknown> | undefined;
  const filesByKey = Object.fromEntries((state?.managedFiles ?? []).map((f) => [f.key, f]));
  const baseFilesByKey = Object.fromEntries((baseState?.managedFiles ?? []).map((f) => [f.key, f]));
  const coreRendered: Record<string, string> = {
    limits: rendered.mainCf, ratelimits: rendered.mainCf,
    checks: `# header_checks\n${rendered.headerChecks}\n\n# body_checks\n${rendered.bodyChecks}`,
  };

  const files: PerFileConfigFile[] = state
    ? [
      ...POSTFIX_CORE_SECTIONS.map((section) => ({
        key: section.key,
        label: section.label,
        fileName: section.key === 'checks' ? 'robin-*_checks' : 'robin-managed.cf',
        description: section.description,
        icon: appIcons[section.icon as keyof typeof appIcons] ?? appIcons.postfixConfig,
        fields: section.fields,
        values: Object.fromEntries(section.fields.map((f) => [f.key, managed?.[f.key]])),
        baseValues: baseManaged ? Object.fromEntries(section.fields.map((f) => [f.key, baseManaged[f.key]])) : undefined,
        rendered: coreRendered[section.key],
      })),
      ...POSTFIX_MANAGED_FILE_CATALOG.map((cat) => {
        const entry = filesByKey[cat.key];
        const baseEntry = baseFilesByKey[cat.key];
        return {
          key: cat.key,
          label: cat.label,
          fileName: entry?.fileName,
          description: cat.description,
          icon: appIcons[cat.icon as keyof typeof appIcons] ?? appIcons.postfixConfig,
          fields: cat.fields,
          values: entry?.values ?? {},
          baseValues: baseState ? (baseEntry?.values ?? {}) : undefined,
          rendered: entry?.rendered,
        };
      }),
    ]
    : [];

  return (
    <PerFileConfigPage
      title="Postfix config"
      icon={appIcons.postfixConfig}
      description="Managed postconf overrides and content filters, applied on the host by the service's robin-agent (postconf -e, postfix reload)."
      files={files}
      scopeId={scopeId}
      scopes={scopes}
      onScopeChange={setScopeId}
      onSaveFile={handleSaveFile}
      onSaveFileAs={handleSaveFileAs}
      onResetFile={handleResetFile}
      savingKey={savingKey}
      loading={loading}
      error={error}
      success={success}
      headerActions={
        <>
          <Button variant="secondary" onClick={() => void load()}><RefreshCw className="h-4 w-4" />Refresh</Button>
          {canReload && <Button variant="secondary" onClick={handleReload} isLoading={isReloading}><RotateCw className="h-4 w-4" />Reload</Button>}
        </>
      }
    />
  );
}
