import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, RotateCw } from 'lucide-react';
import { ApiError, clamavApi } from '../api/client';
import { PerFileConfigPage, type PerFileConfigFile } from '../components/fleet/PerFileConfigPage';
import { Button } from '../components/ui/Button';
import { appIcons } from '../constants/appIcons';
import { CLAMAV_CONFIG_SECTIONS } from '../constants/managedConfigFiles';
import { useServices } from '../context/ServiceContext';
import type { ClamavConfigState } from '../types';
import { useServiceCapabilities } from '../context/FeaturesContext';

/** Textarea value → cleaned lines (mirror lists). */
function toLines(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((l) => l.trim()).filter(Boolean);
  return String(value ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
}

export function ClamavConfigPage() {
  const { selectedClamavService, clamavServices } = useServices();
  const [state, setState] = useState<ClamavConfigState | null>(null);
  const [baseState, setBaseState] = useState<ClamavConfigState | null>(null);
  const [rendered, setRendered] = useState({ clamd: '', freshclam: '' });
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
    if (selectedClamavService?.serviceId) {
      setScopeId(selectedClamavService.serviceId);
    }
  }, [selectedClamavService?.serviceId]);

  const refreshScopes = useCallback(async () => {
    try {
      const res = await clamavApi.getConfigScopes();
      setOverrideScopes(res.data ?? []);
    } catch { /* non-fatal */ }
  }, []);
  useEffect(() => { void refreshScopes(); }, [refreshScopes]);

  const scopes = Array.from(new Set<string>([
    'default',
    ...clamavServices.map((s) => s.serviceId),
    ...overrideScopes,
    ...(selectedClamavService?.serviceId ? [selectedClamavService.serviceId] : []),
  ]));

  const scopeRef = useRef(scopeId);
  scopeRef.current = scopeId;

  const load = useCallback(async () => {
    const req = scopeId;
    setLoading(true);
    setError('');
    try {
      const [config, renderedRes, baseRes] = await Promise.all([
        clamavApi.getConfig(scopeId),
        clamavApi.getRenderedConfig(scopeId),
        scopeId === 'default' ? Promise.resolve(null) : clamavApi.getConfig('default'),
      ]);
      if (scopeRef.current !== req) return;
      setState(config.data ?? null);
      setBaseState(baseRes?.data ?? null);
      setRendered(renderedRes.data ?? { clamd: '', freshclam: '' });
    } catch (err) {
      if (scopeRef.current !== req) return;
      setError(err instanceof ApiError ? err.message : 'Failed to load ClamAV configuration');
    } finally {
      if (scopeRef.current === req) setLoading(false);
    }
  }, [scopeId]);

  useEffect(() => { void load(); }, [load]);

  const saveToScope = async (key: string, values: Record<string, unknown>, targetScope: string) => {
    if (!state) return;
    if (key.startsWith('freshclam')) {
      const patch = { ...(state.freshclam as unknown as Record<string, unknown>), ...values };
      if ('databaseMirror' in values) patch.databaseMirror = toLines(values.databaseMirror);
      if ('privateMirror' in values) patch.privateMirror = toLines(values.privateMirror);
      await clamavApi.updateConfig(targetScope, { freshclam: patch } as unknown as Partial<ClamavConfigState>);
    } else {
      await clamavApi.updateConfig(targetScope, { clamd: { ...(state.clamd as unknown as Record<string, unknown>), ...values } } as unknown as Partial<ClamavConfigState>);
    }
  };

  const handleSaveFile = async (key: string, values: Record<string, unknown>) => {
    if (!state) return;
    setSavingKey(key);
    setError('');
    setSuccess('');
    try {
      await saveToScope(key, values, scopeId);
      setSuccess(`ClamAV config saved for ${scopeId === 'default' ? 'Default (base)' : scopeId}`);
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
      await saveToScope(key, values, newScopeId);
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
      await clamavApi.resetConfigFile(scopeId, key);
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
      const res = await clamavApi.reload(scopeId);
      setSuccess(res.data?.response ?? 'ClamAV signature reload requested');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reload ClamAV');
    } finally {
      setIsReloading(false);
    }
  };

  const clamd = state?.clamd as unknown as Record<string, unknown> | undefined;
  const freshclam = state?.freshclam as unknown as Record<string, unknown> | undefined;
  const baseClamd = baseState?.clamd as unknown as Record<string, unknown> | undefined;
  const baseFreshclam = baseState?.freshclam as unknown as Record<string, unknown> | undefined;

  const files: PerFileConfigFile[] = state
    ? CLAMAV_CONFIG_SECTIONS.map((section) => {
      const isFreshclam = section.key.startsWith('freshclam');
      const src = isFreshclam ? freshclam : clamd;
      const baseSrc = isFreshclam ? baseFreshclam : baseClamd;
      return {
        key: section.key,
        label: section.label,
        fileName: isFreshclam ? 'freshclam.conf' : 'clamd.conf',
        description: section.description,
        icon: appIcons[section.icon as keyof typeof appIcons] ?? appIcons.clamavConfig,
        fields: section.fields,
        values: Object.fromEntries(section.fields.map((f) => [f.key, src?.[f.key]])),
        baseValues: baseSrc ? Object.fromEntries(section.fields.map((f) => [f.key, baseSrc[f.key]])) : undefined,
        rendered: isFreshclam ? rendered.freshclam : rendered.clamd,
      };
    })
    : [];

  return (
    <PerFileConfigPage
      title="ClamAV Config"
      icon={appIcons.clamavConfig}
      description="Managed clamd.conf and freshclam.conf for the antivirus service."
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
          {canReload && <Button variant="secondary" onClick={handleReload} isLoading={isReloading} aria-label="Reload signatures" title="clamd reloads its signature database; it reads clamd.conf only at start, so restart it to apply config changes"><RotateCw className="h-4 w-4" />Reload signatures</Button>}
        </>
      }
    />
  );
}
