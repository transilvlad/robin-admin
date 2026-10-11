import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, RotateCw } from 'lucide-react';
import { ApiError, dovecotApi } from '../api/client';
import { PerFileConfigPage, type PerFileConfigFile } from '../components/fleet/PerFileConfigPage';
import { Button } from '../components/ui/Button';
import { appIcons } from '../constants/appIcons';
import { DOVECOT_CORE_SECTIONS, DOVECOT_MANAGED_FILE_CATALOG_BY_KEY, DOVECOT_MANAGED_FILE_CATALOG } from '../constants/managedConfigFiles';
import { useServices } from '../context/ServiceContext';
import type { DovecotConfigState } from '../types';
import { useServiceCapabilities } from '../context/FeaturesContext';

const CORE_KEYS = new Set(DOVECOT_CORE_SECTIONS.map((s) => s.key));

export function DovecotConfigPage() {
  const { selectedDovecotService, dovecotServices } = useServices();
  const [state, setState] = useState<DovecotConfigState | null>(null);
  const [baseState, setBaseState] = useState<DovecotConfigState | null>(null);
  const [rendered, setRendered] = useState('');
  const [renderedFor, setRenderedFor] = useState<{ syntax?: string; detected?: string | null }>({});
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
    if (selectedDovecotService?.serviceId) {
      setScopeId(selectedDovecotService.serviceId);
    }
  }, [selectedDovecotService?.serviceId]);

  const refreshScopes = useCallback(async () => {
    try {
      const res = await dovecotApi.getConfigScopes();
      setOverrideScopes(res.data ?? []);
    } catch { /* non-fatal */ }
  }, []);
  useEffect(() => { void refreshScopes(); }, [refreshScopes]);

  const scopes = Array.from(new Set<string>([
    'default',
    ...dovecotServices.map((s) => s.serviceId),
    ...overrideScopes,
    ...(selectedDovecotService?.serviceId ? [selectedDovecotService.serviceId] : []),
  ]));

  const scopeRef = useRef(scopeId);
  scopeRef.current = scopeId;

  const load = useCallback(async () => {
    const req = scopeId;
    setLoading(true);
    setError('');
    try {
      const [config, renderedRes, baseRes] = await Promise.all([
        dovecotApi.getConfig(scopeId),
        dovecotApi.getRenderedConfig(scopeId),
        scopeId === 'default' ? Promise.resolve(null) : dovecotApi.getConfig('default'),
      ]);
      if (scopeRef.current !== req) return;
      setState(config.data ?? null);
      setBaseState(baseRes?.data ?? null);
      setRendered(renderedRes.data?.managed ?? '');
      setRenderedFor({ syntax: renderedRes.data?.renderedFor, detected: renderedRes.data?.detectedVersion });
    } catch (err) {
      if (scopeRef.current !== req) return;
      setError(err instanceof ApiError ? err.message : 'Failed to load Dovecot configuration');
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
        await dovecotApi.updateConfig(scopeId, { ...state.managed, ...values } as Partial<typeof state.managed>);
      } else {
        await dovecotApi.saveConfigFile(scopeId, key, values);
      }
      setSuccess(`Dovecot config saved for ${scopeId === 'default' ? 'Default (base)' : scopeId}`);
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
        await dovecotApi.updateConfig(newScopeId, { ...state.managed, ...values } as Partial<typeof state.managed>);
      } else {
        await dovecotApi.saveConfigFile(newScopeId, key, values);
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
      await dovecotApi.resetConfigFile(scopeId, key);
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
      const res = await dovecotApi.reload(scopeId);
      setSuccess(res.data?.response ?? 'Dovecot reload requested');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reload Dovecot');
    } finally {
      setIsReloading(false);
    }
  };

  const managed = state?.managed as unknown as Record<string, unknown> | undefined;
  const baseManaged = baseState?.managed as unknown as Record<string, unknown> | undefined;
  const filesByKey = Object.fromEntries((state?.managedFiles ?? []).map((f) => [f.key, f]));
  const baseFilesByKey = Object.fromEntries((baseState?.managedFiles ?? []).map((f) => [f.key, f]));

  const files: PerFileConfigFile[] = state
    ? [
      ...DOVECOT_CORE_SECTIONS.map((section) => ({
        key: section.key,
        label: section.label,
        fileName: '50-robin-managed.conf',
        description: section.fields.some((f) => f.key === 'dovecotVersion') && renderedFor.syntax
          ? `${section.description} Rendered for Dovecot ${renderedFor.syntax} syntax (${renderedFor.detected ? `the agent reports ${renderedFor.detected}` : 'no version reported yet; using the setting below'}).`
          : section.description,
        icon: appIcons[section.icon as keyof typeof appIcons] ?? appIcons.dovecotConfig,
        fields: section.fields,
        values: Object.fromEntries(section.fields.map((f) => [f.key, managed?.[f.key]])),
        baseValues: baseManaged ? Object.fromEntries(section.fields.map((f) => [f.key, baseManaged[f.key]])) : undefined,
        rendered,
      })),
      ...DOVECOT_MANAGED_FILE_CATALOG.map((cat) => {
        const entry = filesByKey[cat.key];
        const baseEntry = baseFilesByKey[cat.key];
        return {
          key: cat.key,
          label: cat.label,
          fileName: entry?.fileName ?? DOVECOT_MANAGED_FILE_CATALOG_BY_KEY[cat.key]?.key,
          description: cat.description,
          icon: appIcons[cat.icon as keyof typeof appIcons] ?? appIcons.dovecotConfig,
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
      title="Dovecot config"
      icon={appIcons.dovecotConfig}
      description="Managed conf.d include, including the counters the Metrics page reads, applied on the host by the service's robin-agent (doveadm reload)."
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
