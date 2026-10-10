import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, RotateCw } from 'lucide-react';
import { rspamdApi, ApiError } from '../api/client';
import { PerFileConfigPage, type PerFileConfigFile } from '../components/fleet/PerFileConfigPage';
import { Button } from '../components/ui/Button';
import { appIcons } from '../constants/appIcons';
import { RSPAMD_CORE_SECTIONS, RSPAMD_MANAGED_FILE_CATALOG } from '../constants/managedConfigFiles';
import { useServices } from '../context/ServiceContext';
import type { RspamdConfigState } from '../types';
import { useServiceCapabilities } from '../context/FeaturesContext';

const CORE_KEYS = new Set(RSPAMD_CORE_SECTIONS.map((s) => s.key));

export function RspamdConfigPage() {
  const { selectedRspamdService, rspamdServices } = useServices();
  const [state, setState] = useState<RspamdConfigState | null>(null);
  const [baseState, setBaseState] = useState<RspamdConfigState | null>(null);
  const [scopeId, setScopeId] = useState('default');
  // Reload runs against one instance, and only where its setup supports it.
  const { can: canScope } = useServiceCapabilities(scopeId === 'default' ? null : scopeId);
  const canReload = canScope('reload');
  const [overrideScopes, setOverrideScopes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isReloading, setIsReloading] = useState(false);

  useEffect(() => {
    if (selectedRspamdService?.serviceId) {
      setScopeId(selectedRspamdService.serviceId);
    }
  }, [selectedRspamdService?.serviceId]);

  // Scope dropdown = 'default' base ∪ registered rspamd instances ∪ any config-store
  // override owners (freeform Save As targets). De-duplicated, base first.
  const refreshScopes = useCallback(async () => {
    try {
      const res = await rspamdApi.getConfigScopes();
      setOverrideScopes(res.data ?? []);
    } catch {
      // Non-fatal: fall back to registered instances only.
    }
  }, []);

  useEffect(() => { void refreshScopes(); }, [refreshScopes]);

  const scopes = Array.from(new Set<string>([
    'default',
    ...rspamdServices.map((s) => s.serviceId),
    ...overrideScopes,
    ...(selectedRspamdService?.serviceId ? [selectedRspamdService.serviceId] : []),
  ]));

  const scopeRef = useRef(scopeId);
  scopeRef.current = scopeId;

  const load = useCallback(async () => {
    const req = scopeId;
    setLoading(true);
    setError('');
    try {
      const [config, baseRes] = await Promise.all([
        rspamdApi.getConfig(scopeId),
        scopeId === 'default' ? Promise.resolve(null) : rspamdApi.getConfig('default'),
      ]);
      if (scopeRef.current !== req) return;
      setState(config.data ?? null);
      setBaseState(baseRes?.data ?? null);
    } catch (err) {
      if (scopeRef.current !== req) return;
      setError(err instanceof ApiError ? err.message : 'Failed to load Rspamd configuration');
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
        await rspamdApi.updateConfig({ ...state.managedConfig, ...values }, { dkim: true, bayes: true }, scopeId);
      } else {
        await rspamdApi.saveConfigFile(key, values, scopeId);
      }
      setSuccess(`Rspamd config saved for ${scopeId === 'default' ? 'Default (base)' : scopeId}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to save ${key} config`);
    } finally {
      setSavingKey(null);
    }
  };

  const saveFileToScope = async (key: string, values: Record<string, unknown>, targetScope: string) => {
    if (CORE_KEYS.has(key)) {
      await rspamdApi.updateConfig({ ...state?.managedConfig, ...values }, { dkim: true, bayes: true }, targetScope);
    } else {
      await rspamdApi.saveConfigFile(key, values, targetScope);
    }
  };

  const handleSaveFileAs = async (key: string, values: Record<string, unknown>, newScopeId: string) => {
    setSavingKey(key);
    setError('');
    setSuccess('');
    try {
      await saveFileToScope(key, values, newScopeId);
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
      await rspamdApi.resetConfigFile(key, scopeId);
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
      const res = await rspamdApi.reload(scopeId === 'default' ? undefined : scopeId);
      setSuccess(res.data?.response ?? 'Rspamd reload requested');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reload Rspamd');
    } finally {
      setIsReloading(false);
    }
  };

  const managedConfig = state?.managedConfig as unknown as Record<string, unknown> | undefined;
  const baseManagedConfig = baseState?.managedConfig as unknown as Record<string, unknown> | undefined;
  const filesByKey = Object.fromEntries((state?.managedFiles ?? []).map((f) => [f.key, f]));
  const baseFilesByKey = Object.fromEntries((baseState?.managedFiles ?? []).map((f) => [f.key, f]));
  const coreRendered: Record<string, string | undefined> = {
    dkim: state?.files.dkim.content ?? undefined,
    bayes: state?.files.bayes.content ?? undefined,
  };

  const files: PerFileConfigFile[] = state
    ? [
      ...RSPAMD_CORE_SECTIONS.map((section) => ({
        key: section.key,
        label: section.label,
        fileName: section.key === 'dkim' ? 'dkim_signing.conf' : 'classifier-bayes.conf',
        description: section.description,
        icon: appIcons[section.icon as keyof typeof appIcons] ?? appIcons.rspamdConfig,
        fields: section.fields,
        values: Object.fromEntries(section.fields.map((f) => [f.key, managedConfig?.[f.key]])),
        baseValues: baseManagedConfig ? Object.fromEntries(section.fields.map((f) => [f.key, baseManagedConfig[f.key]])) : undefined,
        rendered: coreRendered[section.key],
      })),
      ...RSPAMD_MANAGED_FILE_CATALOG.map((cat) => {
        const entry = filesByKey[cat.key];
        const baseEntry = baseFilesByKey[cat.key];
        return {
          key: cat.key,
          label: cat.label,
          fileName: entry?.fileName,
          description: cat.description,
          icon: appIcons[cat.icon as keyof typeof appIcons] ?? appIcons.rspamdConfig,
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
      title="Rspamd config"
      icon={appIcons.rspamdConfig}
      description="Managed local.d files applied by the co-located agent (rspamadm reload). DKIM keys are managed on the DKIM Keys page."
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
