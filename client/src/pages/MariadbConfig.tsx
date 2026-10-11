import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, RotateCw } from 'lucide-react';
import { ApiError, mariadbApi } from '../api/client';
import { PerFileConfigPage, type PerFileConfigFile } from '../components/fleet/PerFileConfigPage';
import { Button } from '../components/ui/Button';
import { appIcons } from '../constants/appIcons';
import { MARIADB_CONFIG_SECTIONS } from '../constants/managedConfigFiles';
import { useServices } from '../context/ServiceContext';
import { useServiceCapabilities } from '../context/FeaturesContext';
import type { MariadbConfigState, MariadbManagedConfig } from '../types';

export function MariadbConfigPage() {
  const { selectedMariadbService, mariadbServices } = useServices();
  const [state, setState] = useState<MariadbConfigState | null>(null);
  const [base, setBase] = useState<MariadbManagedConfig | null>(null);
  const [rendered, setRendered] = useState('');
  const [scopeId, setScopeId] = useState('default');
  // Re-apply runs against one instance, and only where robin-admin can reach it.
  const { can: canScope } = useServiceCapabilities(scopeId === 'default' ? null : scopeId);
  const canReapply = canScope('reload');
  const [overrideScopes, setOverrideScopes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isApplying, setIsApplying] = useState(false);

  useEffect(() => {
    if (selectedMariadbService?.serviceId) setScopeId(selectedMariadbService.serviceId);
  }, [selectedMariadbService?.serviceId]);

  const refreshScopes = useCallback(async () => {
    try {
      setOverrideScopes((await mariadbApi.getConfigScopes()).data ?? []);
    } catch { /* non-fatal */ }
  }, []);
  useEffect(() => { void refreshScopes(); }, [refreshScopes]);

  const scopes = Array.from(new Set<string>([
    'default',
    ...mariadbServices.map((s) => s.serviceId),
    ...overrideScopes,
    ...(selectedMariadbService?.serviceId ? [selectedMariadbService.serviceId] : []),
  ]));

  const scopeRef = useRef(scopeId);
  scopeRef.current = scopeId;

  const load = useCallback(async () => {
    const requested = scopeId;
    setLoading(true);
    setError('');
    try {
      const [config, renderedRes, baseRes] = await Promise.all([
        mariadbApi.getConfig(scopeId),
        mariadbApi.getRenderedConfig(scopeId),
        scopeId === 'default' ? Promise.resolve(null) : mariadbApi.getConfig('default'),
      ]);
      if (scopeRef.current !== requested) return;
      setState(config.data ?? null);
      setBase(baseRes?.data?.managed ?? null);
      setRendered(renderedRes.data?.managed ?? '');
    } catch (err) {
      if (scopeRef.current !== requested) return;
      setError(err instanceof ApiError ? err.message : 'Failed to load MariaDB configuration');
    } finally {
      if (scopeRef.current === requested) setLoading(false);
    }
  }, [scopeId]);

  useEffect(() => { void load(); }, [load]);

  // A save is stored even when the live apply fails; say so instead of claiming success.
  const reportSaved = (message: string, applyError: string | null | undefined) => {
    if (applyError) setError(`${message}, but it was not applied to the running server: ${applyError}`);
    else setSuccess(message);
  };

  const save = async (key: string, targetScope: string, values: Record<string, unknown>, message: string) => {
    if (!state) return;
    setSavingKey(key);
    setError('');
    setSuccess('');
    try {
      const res = await mariadbApi.updateConfig(targetScope, { ...state.managed, ...values } as MariadbManagedConfig);
      reportSaved(message, res.data?.applyError);
      if (targetScope !== scopeId) {
        await refreshScopes();
        setScopeId(targetScope);
      } else {
        await load();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save MariaDB configuration');
    } finally {
      setSavingKey(null);
    }
  };

  const handleReset = async (key: string) => {
    setSavingKey(key);
    setError('');
    setSuccess('');
    try {
      const res = await mariadbApi.resetConfig(scopeId);
      reportSaved(`Reset MariaDB config to base for ${scopeId}`, res.data?.applyError);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reset MariaDB config');
    } finally {
      setSavingKey(null);
    }
  };

  const handleReapply = async () => {
    setIsApplying(true);
    setError('');
    setSuccess('');
    try {
      setSuccess((await mariadbApi.reapply(scopeId)).data?.response ?? 'Managed variables applied');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to apply MariaDB config');
    } finally {
      setIsApplying(false);
    }
  };

  const live = state?.live ?? {};
  const files: PerFileConfigFile[] = state
    ? MARIADB_CONFIG_SECTIONS.map((section) => {
      const fields = section.fields.filter((field) => (
        !(state.flavor === 'mariadb' && field.key === 'maxExecutionTime')
        && !(state.flavor === 'mysql' && field.key === 'maxStatementTime')
      ));
      return {
        key: section.key,
        label: section.label,
        description: section.description,
        icon: appIcons[section.icon as keyof typeof appIcons] ?? appIcons.mariadbConfig,
        // An empty field leaves the server's own value, so show what that is.
        fields: fields.map((field) => (live[field.key] === undefined ? field : {
          ...field,
          placeholder: `Server: ${live[field.key]}`,
          help: field.type === 'select' ? [field.help, `Server: ${live[field.key]}.`].filter(Boolean).join(' ') : field.help,
        })),
        values: Object.fromEntries(fields.map((field) => [field.key, state.managed[field.key]])),
        baseValues: base ? Object.fromEntries(fields.map((field) => [field.key, base[field.key]])) : undefined,
        rendered,
      };
    })
    : [];

  return (
    <PerFileConfigPage
      title="MariaDB Config"
      icon={appIcons.mariadbConfig}
      description="Managed dynamic variables, applied live with SET GLOBAL and re-applied after a restart reverts them. Leave a field empty to keep the server's own setting."
      files={files}
      scopeId={scopeId}
      scopes={scopes}
      onScopeChange={setScopeId}
      onSaveFile={(key, values) => save(key, scopeId, values, `MariaDB config saved for ${scopeId === 'default' ? 'Default (base)' : scopeId}`)}
      onSaveFileAs={(key, values, newScopeId) => save(key, newScopeId, values, `Saved MariaDB override for ${newScopeId}`)}
      onResetFile={handleReset}
      savingKey={savingKey}
      loading={loading}
      error={error}
      success={success}
      headerActions={
        <>
          <Button variant="secondary" onClick={() => void load()}><RefreshCw className="h-4 w-4" />Refresh</Button>
          {canReapply && <Button variant="secondary" onClick={handleReapply} isLoading={isApplying}><RotateCw className="h-4 w-4" />Re-apply</Button>}
        </>
      }
      aside={state && state.serverSettings.length > 0 ? (
        <div className="card p-4">
          <h3 className="text-sm font-semibold">Server-managed settings</h3>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Read-only in Admin. Managed on the database server.</p>
          <ul className="mt-2 space-y-1 text-xs">
            {state.serverSettings.map((setting) => (
              <li key={setting.name} className="space-y-0.5">
                <code className="block break-all text-gray-600 dark:text-gray-300">{setting.name}</code>
                <span className="block break-all text-gray-400">{setting.setting}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : undefined}
    />
  );
}
