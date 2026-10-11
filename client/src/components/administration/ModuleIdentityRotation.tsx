import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, RefreshCw, RotateCcw, Shield } from 'lucide-react';
import { moduleIdentityApi, type ModuleIdentityReadiness, type ModuleIdentityRotationStatus } from '../../api/client';
import { SettingsCard } from './AdminPrimitives';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';

function remaining(value: string): string {
  const ms = Math.max(0, Date.parse(value) - Date.now());
  const minutes = Math.ceil(ms / 60_000);
  return minutes > 1 ? `${minutes} minutes` : 'less than a minute';
}

export function ModuleIdentityRotation({ disabled }: { disabled: boolean }) {
  const [status, setStatus] = useState<ModuleIdentityRotationStatus>();
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [rollbackAcknowledged, setRollbackAcknowledged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const response = await moduleIdentityApi.get();
      if (!response.data) throw new Error('Module identity rotation status is unavailable.');
      setStatus(response.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load module identity rotation status.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!disabled) void load();
    else setLoading(false);
  }, [disabled]);

  async function run(label: string, action: () => Promise<{ data?: ModuleIdentityRotationStatus }>) {
    setWorking(label);
    setError('');
    setNotice('');
    try {
      const response = await action();
      if (!response.data) throw new Error('Module identity rotation did not return its updated state.');
      setStatus(response.data);
      setNotice(label);
      setRollbackAcknowledged(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Module identity rotation failed.');
    } finally {
      setWorking('');
    }
  }

  async function acknowledge(phase: 'activation' | 'retirement', moduleSlug: string) {
    const note = evidence[`${phase}:${moduleSlug}`] ?? '';
    await run(`Trust readiness recorded for ${moduleSlug}`, () => moduleIdentityApi.acknowledge(phase, moduleSlug, note));
    setEvidence(current => ({ ...current, [`${phase}:${moduleSlug}`]: '' }));
  }

  function readinessRows(phase: 'activation' | 'retirement', rows: ModuleIdentityReadiness[]) {
    return rows.map(row => {
      const field = `${phase}:${row.moduleSlug}`;
      return (
        <div key={field} className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-robin-gray-700">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{row.moduleSlug}</span>
            <span className={row.ready ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'}>
              {row.ready ? `Acknowledged ${row.acknowledgedAt ? new Date(row.acknowledgedAt).toLocaleString() : ''}` : 'Restart and acknowledge required'}
            </span>
          </div>
          {row.ready && row.evidence && <p className="whitespace-pre-wrap text-xs text-gray-600 dark:text-gray-300">{row.evidence}</p>}
          {!row.ready && (
            <>
              <label className="block text-xs text-gray-600 dark:text-gray-300" htmlFor={field}>
                Evidence that this backend process loaded the displayed public trust document
              </label>
              <textarea
                id={field}
                className="input min-h-16 w-full"
                value={evidence[field] ?? ''}
                onChange={event => setEvidence(current => ({ ...current, [field]: event.target.value }))}
                maxLength={500}
                disabled={disabled || !!working}
                placeholder="For example: restarted robin-tools and verified the pinned key IDs"
              />
              <div className="flex justify-end">
                <Button
                  variant="secondary"
                  disabled={disabled || !!working || (evidence[field] ?? '').trim().length < 8}
                  isLoading={working === `Trust readiness recorded for ${row.moduleSlug}`}
                  onClick={() => void acknowledge(phase, row.moduleSlug)}
                >
                  Acknowledge readiness
                </Button>
              </div>
            </>
          )}
        </div>
      );
    });
  }

  const activationReady = status?.activationReadiness.every(row => row.ready) ?? false;
  const retirementReady = status?.retirementReadiness.every(row => row.ready) ?? false;
  const retentionElapsed = Boolean(status?.retiring && Date.parse(status.retiring.retireAfter) <= Date.now());
  const backendSetChanged = status
    ? JSON.stringify(status.affectedModules) !== JSON.stringify(status.configuredModules)
    : false;

  return (
    <SettingsCard
      title="Module identity signing keys"
      description="Rotate only Admin's module-request assertion key. The issuer stays stable; license, instance, Sheriff, encryption keys, and administrator UUIDs are unaffected."
      icon={KeyRound}
      action={
        <Button variant="secondary" disabled={disabled || loading || !!working} onClick={() => void load()} aria-label="Reload identity rotation status">
          <RefreshCw className="h-4 w-4" />
        </Button>
      }
    >
      {error && <div role="alert" className="mb-4 text-sm text-red-600">{error}</div>}
      {notice && <div role="status" className="mb-4 text-sm text-green-700">{notice}</div>}
      {loading ? <Spinner /> : status && (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div><span className="text-xs text-gray-500">Stage</span><div className="font-medium">{status.stage}</div></div>
            <div><span className="text-xs text-gray-500">Stable issuer</span><div className="break-all font-mono text-xs">{status.issuer}</div></div>
            <div><span className="text-xs text-gray-500">Active key ID</span><div className="break-all font-mono text-xs">{status.active.kid}</div></div>
            <div><span className="text-xs text-gray-500">Published trust fingerprint</span><div className="break-all font-mono text-xs">{status.trustFingerprint}</div></div>
          </div>

          <div className="rounded-lg bg-gray-50 p-3 text-sm dark:bg-robin-gray-800/60">
            <div className="font-medium">Public trust currently published</div>
            <div className="mt-1 break-all font-mono text-xs">{status.trust.keys.map(key => key.kid).join(', ')}</div>
            <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">
              {status.trustExportConfigured
                ? 'The document contains public keys only and is written to the configured Admin export. A writable export does not prove a backend loaded it; each backend caches pins until restarted.'
                : 'The document contains public keys only. No automatic Admin trust-export file is configured; download and distribute this document to each backend. Readiness must still be acknowledged after restart.'}
            </p>
            <Link className="mt-2 inline-block text-sm text-robin-orange hover:underline" to="/administration/integration?tab=modules">
              Open Modules trust download
            </Link>
          </div>

          {status.configuredModules.length === 0 && (
            <p className="text-sm text-gray-600 dark:text-gray-300">No module backend credentials are configured, so there are no backend processes requiring readiness acknowledgments.</p>
          )}

          {status.pending && (
            <section className="space-y-3 border-t border-gray-200 pt-4 dark:border-robin-gray-700">
              <h3 className="font-medium">Pending key {status.pending.kid}</h3>
              <p className="text-sm text-gray-600 dark:text-gray-300">
                Admin has published the active and pending public keys together. Restart every affected module backend after it loads this trust, then record operator evidence below. Activation is blocked until all configured backends are acknowledged.
              </p>
              {backendSetChanged && <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">The configured backend set changed after preparation. Cancel this pending key and prepare again to capture the current set.</p>}
              {readinessRows('activation', status.activationReadiness)}
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="secondary" disabled={disabled || !!working} isLoading={working === 'Pending key cancelled'} onClick={() => void run('Pending key cancelled', moduleIdentityApi.cancel)}>
                  Cancel pending key
                </Button>
                <Button disabled={disabled || !!working || !activationReady || backendSetChanged} isLoading={working === 'Signing key activated'} onClick={() => void run('Signing key activated', moduleIdentityApi.activate)}>
                  Activate pending key
                </Button>
              </div>
            </section>
          )}

          {status.retiring && (
            <section className="space-y-3 border-t border-gray-200 pt-4 dark:border-robin-gray-700">
              <h3 className="font-medium">Retained verification key {status.retiring.kid}</h3>
              {!status.retiring.trustRemovalPreparedAt ? (
                <>
                  <p className="text-sm text-gray-600 dark:text-gray-300">
                    The old key remains in the published trust set until {new Date(status.retiring.retireAfter).toLocaleString()} so outstanding assertions expire. {retentionElapsed ? 'The retention interval has elapsed.' : `The remaining minimum is ${remaining(status.retiring.retireAfter)}.`}
                  </p>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      variant="secondary"
                      disabled={disabled || !!working || !retentionElapsed}
                      isLoading={working === 'Retirement trust prepared'}
                      onClick={() => void run('Retirement trust prepared', moduleIdentityApi.prepareRetirement)}
                    >
                      Publish trust without old key
                    </Button>
                    <label className="flex w-full items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
                      <input type="checkbox" checked={rollbackAcknowledged} onChange={event => setRollbackAcknowledged(event.target.checked)} disabled={disabled || !!working} />
                      <span>I understand rollback resumes signing with the retained key; assertions already minted with the current key remain valid for up to 60 seconds.</span>
                    </label>
                    <Button
                      variant="secondary"
                      disabled={disabled || !!working || !rollbackAcknowledged}
                      isLoading={working === 'Signing key rolled back'}
                      onClick={() => void run('Signing key rolled back', moduleIdentityApi.rollback)}
                    >
                      <RotateCcw className="h-4 w-4" /> Roll back signer
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm text-gray-600 dark:text-gray-300">
                    The public trust export now omits the retained key. Restart each backend so its process loads the active-only trust, then record evidence before final retirement.
                  </p>
                  {backendSetChanged && (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">The configured backend set changed after retirement trust preparation. Refresh readiness for the current set.</p>
                      <Button variant="secondary" disabled={disabled || !!working} isLoading={working === 'Retirement readiness refreshed'} onClick={() => void run('Retirement readiness refreshed', moduleIdentityApi.prepareRetirement)}>
                        Refresh retirement readiness
                      </Button>
                    </div>
                  )}
                  {readinessRows('retirement', status.retirementReadiness)}
                  <div className="flex justify-end">
                    <Button disabled={disabled || !!working || !retentionElapsed || !retirementReady || backendSetChanged} isLoading={working === 'Retained key retired'} onClick={() => void run('Retained key retired', moduleIdentityApi.retire)}>
                      <Shield className="h-4 w-4" /> Retire old key
                    </Button>
                  </div>
                </>
              )}
            </section>
          )}

          {!status.pending && !status.retiring && (
            <div className="flex justify-end border-t border-gray-200 pt-4 dark:border-robin-gray-700">
              <Button disabled={disabled || !!working} isLoading={working === 'Pending key prepared'} onClick={() => void run('Pending key prepared', moduleIdentityApi.prepare)}>
                Prepare rotation
              </Button>
            </div>
          )}
        </div>
      )}
    </SettingsCard>
  );
}
