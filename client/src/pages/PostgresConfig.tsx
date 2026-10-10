import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, RotateCw } from 'lucide-react';
import { ApiError, postgresApi } from '../api/client';
import { PerFileConfigPage, type PerFileConfigFile } from '../components/fleet/PerFileConfigPage';
import { Button } from '../components/ui/Button';
import { appIcons } from '../constants/appIcons';
import { POSTGRES_CONFIG_SECTIONS } from '../constants/managedConfigFiles';
import { useServices } from '../context/ServiceContext';
import type { PostgresConfigState, PostgresRestartRequiredSetting } from '../types';
import { useServiceCapabilities } from '../context/FeaturesContext';

export function PostgresConfigPage() {
  const { selectedPostgresService, postgresServices } = useServices();
  const [managed, setManaged] = useState<PostgresConfigState['managed'] | null>(null);
  const [base, setBase] = useState<Record<string, unknown> | null>(null);
  const [rendered, setRendered] = useState('');
  const [restartRequired, setRestartRequired] = useState<PostgresRestartRequiredSetting[]>([]);
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
    if (selectedPostgresService?.serviceId) {
      setScopeId(selectedPostgresService.serviceId);
    }
  }, [selectedPostgresService?.serviceId]);

  const refreshScopes = useCallback(async () => {
    try {
      const res = await postgresApi.getConfigScopes();
      setOverrideScopes(res.data ?? []);
    } catch { /* non-fatal */ }
  }, []);
  useEffect(() => { void refreshScopes(); }, [refreshScopes]);

  const scopes = Array.from(new Set<string>([
    'default',
    ...postgresServices.map((s) => s.serviceId),
    ...overrideScopes,
    ...(selectedPostgresService?.serviceId ? [selectedPostgresService.serviceId] : []),
  ]));

  const scopeRef = useRef(scopeId);
  scopeRef.current = scopeId;

  const load = useCallback(async () => {
    const req = scopeId;
    setLoading(true);
    setError('');
    try {
      const [config, renderedRes, baseRes] = await Promise.all([
        postgresApi.getConfig(scopeId),
        postgresApi.getRenderedConfig(scopeId),
        scopeId === 'default' ? Promise.resolve(null) : postgresApi.getConfig('default'),
      ]);
      if (scopeRef.current !== req) return;
      setManaged(config.data?.managed ?? null);
      setBase((baseRes?.data?.managed ?? null) as Record<string, unknown> | null);
      setRestartRequired(config.data?.restartRequired ?? []);
      setRendered(renderedRes.data?.managed ?? '');
    } catch (err) {
      if (scopeRef.current !== req) return;
      setError(err instanceof ApiError ? err.message : 'Failed to load Postgres configuration');
    } finally {
      if (scopeRef.current === req) setLoading(false);
    }
  }, [scopeId]);

  useEffect(() => { void load(); }, [load]);

  // A save is stored even when the live apply fails; say so instead of claiming success.
  const reportSaved = (message: string, applyError: string | null | undefined) => {
    if (applyError) {
      setError(`${message}, but it was not applied to the running Postgres: ${applyError}`);
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
      const res = await postgresApi.updateConfig(scopeId, { ...managed, ...values });
      reportSaved(`Postgres config saved for ${scopeId === 'default' ? 'Default (base)' : scopeId}`, res.data?.applyError);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save Postgres configuration');
    } finally {
      setSavingKey(null);
    }
  };

  const handleSaveFileAs = async (key: string, values: Record<string, unknown>, newScopeId: string) => {
    if (!managed) return;
    setSavingKey(key);
    setError('');
    setSuccess('');
    try {
      const res = await postgresApi.updateConfig(newScopeId, { ...managed, ...values });
      await refreshScopes();
      reportSaved(`Saved Postgres override for ${newScopeId}`, res.data?.applyError);
      setScopeId(newScopeId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save Postgres override');
    } finally {
      setSavingKey(null);
    }
  };

  const handleResetFile = async (key: string) => {
    setSavingKey(key);
    setError('');
    setSuccess('');
    try {
      const res = await postgresApi.resetConfig(scopeId);
      reportSaved(`Reset Postgres config to base for ${scopeId}`, res.data?.applyError);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reset Postgres config');
    } finally {
      setSavingKey(null);
    }
  };

  const handleReload = async () => {
    setIsReloading(true);
    setError('');
    try {
      const res = await postgresApi.reload(scopeId);
      setSuccess(res.data?.response ?? 'Postgres reload requested');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reload Postgres');
    } finally {
      setIsReloading(false);
    }
  };

  const files: PerFileConfigFile[] = managed
    ? POSTGRES_CONFIG_SECTIONS.map((section) => ({
      key: section.key,
      label: section.label,
      description: section.description,
      icon: appIcons[section.icon as keyof typeof appIcons] ?? appIcons.postgresConfig,
      fields: section.fields,
      values: Object.fromEntries(section.fields.map((f) => [f.key, (managed as unknown as Record<string, unknown>)[f.key]])),
      baseValues: base ? Object.fromEntries(section.fields.map((f) => [f.key, base[f.key]])) : undefined,
      rendered,
    }))
    : [];

  return (
    <PerFileConfigPage
      title="Postgres config"
      icon={appIcons.postgresConfig}
      description="Managed reload-safe GUCs, applied live via ALTER SYSTEM + pg_reload_conf(). Restart-required GUCs stay read-only."
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
      aside={restartRequired.length > 0 ? (
        <div className="card p-4">
          <h3 className="text-sm font-semibold">Restart required</h3>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">These GUCs need a Postgres restart and are read-only here.</p>
          <ul className="mt-2 space-y-1 text-xs">
            {restartRequired.map((g) => (
              <li key={g.name} className="flex justify-between gap-2">
                <code className="text-gray-600 dark:text-gray-300">{g.name}</code>
                <span className="text-gray-400">{g.setting}{g.unit ?? ''}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : undefined}
    />
  );
}
