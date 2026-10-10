import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, RotateCw } from 'lucide-react';
import { ApiError, redisApi } from '../api/client';
import { PerFileConfigPage, type PerFileConfigFile } from '../components/fleet/PerFileConfigPage';
import { Button } from '../components/ui/Button';
import { appIcons } from '../constants/appIcons';
import { REDIS_CONFIG_SECTIONS } from '../constants/managedConfigFiles';
import { useServices } from '../context/ServiceContext';
import type { RedisConfigState } from '../types';
import { useServiceCapabilities } from '../context/FeaturesContext';

export function RedisConfigPage() {
  const { selectedRedisService, redisServices } = useServices();
  const [managed, setManaged] = useState<RedisConfigState['managed'] | null>(null);
  const [base, setBase] = useState<Record<string, unknown> | null>(null);
  const [rendered, setRendered] = useState('');
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
    if (selectedRedisService?.serviceId) {
      setScopeId(selectedRedisService.serviceId);
    }
  }, [selectedRedisService?.serviceId]);

  const refreshScopes = useCallback(async () => {
    try {
      const res = await redisApi.getConfigScopes();
      setOverrideScopes(res.data ?? []);
    } catch { /* non-fatal */ }
  }, []);
  useEffect(() => { void refreshScopes(); }, [refreshScopes]);

  const scopes = Array.from(new Set<string>([
    'default',
    ...redisServices.map((s) => s.serviceId),
    ...overrideScopes,
    ...(selectedRedisService?.serviceId ? [selectedRedisService.serviceId] : []),
  ]));

  const scopeRef = useRef(scopeId);
  scopeRef.current = scopeId;

  const load = useCallback(async () => {
    const req = scopeId;
    setLoading(true);
    setError('');
    try {
      const [config, renderedRes, baseRes] = await Promise.all([
        redisApi.getConfig(scopeId),
        redisApi.getRenderedConfig(scopeId),
        scopeId === 'default' ? Promise.resolve(null) : redisApi.getConfig('default'),
      ]);
      if (scopeRef.current !== req) return;
      setManaged(config.data?.managed ?? null);
      setBase((baseRes?.data?.managed ?? null) as Record<string, unknown> | null);
      setRendered(renderedRes.data?.managed ?? '');
    } catch (err) {
      if (scopeRef.current !== req) return;
      setError(err instanceof ApiError ? err.message : 'Failed to load Redis configuration');
    } finally {
      if (scopeRef.current === req) setLoading(false);
    }
  }, [scopeId]);

  useEffect(() => { void load(); }, [load]);

  // A save is stored even when the live apply fails; say so instead of claiming success.
  const reportSaved = (message: string, applyError: string | null | undefined) => {
    if (applyError) {
      setError(`${message}, but it was not applied to the running Redis: ${applyError}`);
    } else {
      setSuccess(message);
    }
  };

  const handleSaveFile = async (key: string, values: Record<string, unknown>) => {
    if (!managed) return;
    setSavingKey(key);
    setError('');
    setSuccess('');
    try {
      // Sections all edit one managed object; merge the section's fields.
      const res = await redisApi.updateConfig(scopeId, { ...managed, ...values });
      reportSaved(`Redis config saved for ${scopeId === 'default' ? 'Default (base)' : scopeId}`, res.data?.applyError);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save Redis configuration');
    } finally {
      setSavingKey(null);
    }
  };

  const handleSaveFileAs = async (_key: string, values: Record<string, unknown>, newScopeId: string) => {
    if (!managed) return;
    setSavingKey(_key);
    setError('');
    setSuccess('');
    try {
      const res = await redisApi.updateConfig(newScopeId, { ...managed, ...values });
      await refreshScopes();
      reportSaved(`Saved Redis override for ${newScopeId}`, res.data?.applyError);
      setScopeId(newScopeId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save Redis override');
    } finally {
      setSavingKey(null);
    }
  };

  const handleResetFile = async (key: string) => {
    setSavingKey(key);
    setError('');
    setSuccess('');
    try {
      const res = await redisApi.resetConfig(scopeId);
      reportSaved(`Reset Redis config to base for ${scopeId}`, res.data?.applyError);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reset Redis config');
    } finally {
      setSavingKey(null);
    }
  };

  const handleReload = async () => {
    setIsReloading(true);
    setError('');
    try {
      const res = await redisApi.reload(scopeId);
      setSuccess(res.data?.response ?? 'Redis reload requested');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reload Redis');
    } finally {
      setIsReloading(false);
    }
  };

  const files: PerFileConfigFile[] = managed
    ? REDIS_CONFIG_SECTIONS.map((section) => ({
      key: section.key,
      label: section.label,
      description: section.description,
      icon: appIcons[section.icon as keyof typeof appIcons] ?? appIcons.redisConfig,
      fields: section.fields,
      values: Object.fromEntries(section.fields.map((f) => [f.key, (managed as unknown as Record<string, unknown>)[f.key]])),
      baseValues: base ? Object.fromEntries(section.fields.map((f) => [f.key, base[f.key]])) : undefined,
      rendered,
    }))
    : [];

  return (
    <PerFileConfigPage
      title="Redis config"
      icon={appIcons.redisConfig}
      description="Managed runtime settings, applied live via CONFIG SET. Structural config stays ansible-owned."
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
