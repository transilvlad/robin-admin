import { useEffect, useMemo, useState } from 'react';
import { KeyRound, RefreshCw, RotateCw, Save, ShieldOff } from 'lucide-react';
import { ApiError, rspamdApi } from '../api/client';
import type { RspamdDkimDomain, RspamdDkimSelector } from '../types';
import { PageServiceSelector } from '../components/fleet/PageServiceSelector';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import { useServices } from '../context/ServiceContext';

interface DomainEditor {
  domain: string;
  signDomain: string;
  enabled: boolean;
  autoRotateEnabled: boolean;
  rotateIntervalDays: number;
  retainOldDays: number;
}

interface ImportKeyEditor {
  selector: string;
  privateKey: string;
}

const EMPTY_DOMAIN: DomainEditor = {
  domain: '',
  signDomain: '',
  enabled: true,
  autoRotateEnabled: false,
  rotateIntervalDays: 90,
  retainOldDays: 30,
};

const EMPTY_IMPORT: ImportKeyEditor = {
  selector: '',
  privateKey: '',
};

function mapDomainToEditor(domain: RspamdDkimDomain): DomainEditor {
  return {
    domain: domain.domain,
    signDomain: domain.signDomain,
    enabled: domain.enabled,
    autoRotateEnabled: domain.autoRotateEnabled,
    rotateIntervalDays: domain.rotateIntervalDays ?? 90,
    retainOldDays: domain.retainOldDays,
  };
}

export function RspamdDkimPage() {
  const { selectedRspamdService } = useServices();
  const [domains, setDomains] = useState<RspamdDkimDomain[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectors, setSelectors] = useState<RspamdDkimSelector[]>([]);
  const [createForm, setCreateForm] = useState<DomainEditor>(EMPTY_DOMAIN);
  const [editForm, setEditForm] = useState<DomainEditor>(EMPTY_DOMAIN);
  const [importForm, setImportForm] = useState<ImportKeyEditor>(EMPTY_IMPORT);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const selected = useMemo(
    () => domains.find((domain) => domain.id === selectedId) ?? null,
    [domains, selectedId]
  );

  const suggestedSelector = useMemo(
    () => buildSuggestedSelector(selectors),
    [selectors]
  );

  const loadDomains = async (preferredId?: number | null) => {
    setIsLoading(true);
    try {
      const response = await rspamdApi.listDomains();
      const nextDomains = response.data ?? [];
      setDomains(nextDomains);
      const nextSelectedId = preferredId ?? selectedId ?? nextDomains[0]?.id ?? null;
      setSelectedId(nextSelectedId);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load DKIM identities');
    } finally {
      setIsLoading(false);
    }
  };

  const loadSelectors = async (domainId: number) => {
    try {
      const response = await rspamdApi.listSelectors(domainId);
      setSelectors(response.data ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load DKIM keys');
    }
  };

  useEffect(() => {
    if (selectedRspamdService) {
      void loadDomains();
    } else {
      setDomains([]);
      setSelectedId(null);
      setSelectors([]);
    }
  }, [selectedRspamdService]);

  useEffect(() => {
    if (!selectedRspamdService || !selectedId) {
      setSelectors([]);
      return;
    }
    void loadSelectors(selectedId);
  }, [selectedId, selectedRspamdService]);

  useEffect(() => {
    if (selected) {
      setEditForm(mapDomainToEditor(selected));
    } else {
      setEditForm(EMPTY_DOMAIN);
    }
  }, [selected]);

  useEffect(() => {
    setImportForm({
      selector: suggestedSelector,
      privateKey: '',
    });
  }, [selectedId, suggestedSelector]);

  if (!selectedRspamdService) {
    return (
      <div className="space-y-6">
        <PageHeader
          icon={appIcons.rspamdDkim}
          title="Rspamd DKIM keys"
          description="Select an enabled Rspamd service before managing the shared DKIM signing catalog."
          actions={<PageServiceSelector serviceType="rspamd" capability="dkim" />}
        />
        <div className="rounded-lg border border-dashed border-gray-300 px-6 py-10 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
          No enabled Rspamd service is currently selected.
        </div>
      </div>
    );
  }

  const refresh = async () => {
    await loadDomains(selectedId);
    if (selectedId) {
      await loadSelectors(selectedId);
    }
  };

  const handleCreateDomain = async () => {
    setIsSaving(true);
    setError('');
    setSuccess('');
    try {
      const response = await rspamdApi.createDomain({
        ...createForm,
        domain: createForm.domain.trim(),
        signDomain: createForm.signDomain.trim() || createForm.domain.trim(),
      });
      const created = response.data;
      setCreateForm(EMPTY_DOMAIN);
      await loadDomains(created?.id ?? null);
      setSuccess('Signing identity added');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add signing identity');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveDomain = async () => {
    if (!selected) return;
    setIsSaving(true);
    setError('');
    setSuccess('');
    try {
      await rspamdApi.updateDomain(selected.id, {
        ...editForm,
        domain: editForm.domain.trim(),
        signDomain: editForm.signDomain.trim() || editForm.domain.trim(),
      });
      await refresh();
      setSuccess('Signing identity updated');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update signing identity');
    } finally {
      setIsSaving(false);
    }
  };

  const handleGenerateKey = async () => {
    if (!selected) return;
    setIsSaving(true);
    setError('');
    setSuccess('');
    try {
      if (selected.activeSelector) {
        await rspamdApi.rotateKey(selected.id);
        setSuccess('Generated key activated and previous key retired');
      } else {
        await rspamdApi.createKey(selected.id);
        setSuccess('First DKIM key generated');
      }
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to generate DKIM key');
    } finally {
      setIsSaving(false);
    }
  };

  const handleImportKey = async () => {
    if (!selected) return;
    setIsSaving(true);
    setError('');
    setSuccess('');
    try {
      await rspamdApi.importKey(selected.id, {
        selector: importForm.selector.trim(),
        privateKey: importForm.privateKey,
      });
      await refresh();
      setSuccess(selected.activeSelector ? 'Existing key imported and activated' : 'Existing key imported');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to import DKIM key');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRevoke = async (selectorId: number) => {
    setError('');
    setSuccess('');
    try {
      await rspamdApi.revokeSelector(selectorId);
      await refresh();
      setSuccess('DKIM key revoked');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to revoke DKIM key');
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner className="text-robin-orange" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.rspamdDkim}
        title="Rspamd DKIM keys"
        description={<>Manage signing identities, active keys, DNS publication, and rotation policy for <strong>{selectedRspamdService.name}</strong>.</>}
        actions={(
          <>
            <PageServiceSelector serviceType="rspamd" capability="dkim" />
            <Button variant="secondary" onClick={() => void refresh()}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          </>
        )}
      />

      {error && <div className="rounded-lg bg-red-100 p-3 text-red-700 dark:bg-red-900/20 dark:text-red-400">{error}</div>}
      {success && <div className="rounded-lg bg-green-100 p-3 text-green-700 dark:bg-green-900/20 dark:text-green-400">{success}</div>}

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <div className="space-y-6">
          <section className="card space-y-4 p-6">
            <div>
              <h2 className="text-lg font-semibold">Signing identities</h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Each identity represents one domain, its optional <span className="font-mono">d=</span> signing domain, and the active DKIM key for that scope.
              </p>
            </div>

            {domains.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-300 p-6 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
                No signing identities yet.
              </div>
            ) : (
              <div className="space-y-3">
                {domains.map((domain) => (
                  <button
                    key={domain.id}
                    className={`w-full rounded-lg border p-4 text-left transition-colors ${
                      selectedId === domain.id
                        ? 'border-robin-orange bg-robin-orange/5'
                        : 'border-gray-200 hover:border-robin-orange/50 dark:border-robin-gray-700'
                    }`}
                    onClick={() => setSelectedId(domain.id)}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="font-medium text-gray-900 dark:text-white">{domain.domain}</div>
                        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          d={domain.signDomain}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 text-[11px] font-medium">
                        <span className={`rounded-full px-2 py-0.5 ${domain.enabled ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-gray-100 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300'}`}>
                          {domain.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                        <span className={`rounded-full px-2 py-0.5 ${domain.autoRotateEnabled ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'bg-gray-100 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300'}`}>
                          {domain.autoRotateEnabled ? 'Auto-rotate on' : 'Auto-rotate off'}
                        </span>
                      </div>
                    </div>
                    <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                      Active key: <span className="font-mono">{domain.activeSelector ?? 'none yet'}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="card space-y-4 p-6">
            <div>
              <h2 className="text-lg font-semibold">Add signing identity</h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Create a new DKIM identity before generating or importing its first active key.
              </p>
            </div>

            <div className="grid gap-4">
              <Input
                label="Domain"
                value={createForm.domain}
                onChange={(event) => setCreateForm((current) => ({ ...current, domain: event.target.value }))}
                placeholder="example.com"
              />
              <Input
                label="Signing domain (d=)"
                value={createForm.signDomain}
                onChange={(event) => setCreateForm((current) => ({ ...current, signDomain: event.target.value }))}
                placeholder="Defaults to the domain"
              />
              <div className="grid gap-4 md:grid-cols-2">
                <Input
                  label="Rotate after days"
                  type="number"
                  value={createForm.rotateIntervalDays}
                  onChange={(event) => setCreateForm((current) => ({
                    ...current,
                    rotateIntervalDays: parseInt(event.target.value, 10) || 90,
                  }))}
                />
                <Input
                  label="Retain old days"
                  type="number"
                  value={createForm.retainOldDays}
                  onChange={(event) => setCreateForm((current) => ({
                    ...current,
                    retainOldDays: parseInt(event.target.value, 10) || 30,
                  }))}
                />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <ToggleCard
                  label="Identity enabled"
                  description="Disabled identities stay in the catalog but are skipped for signing."
                  checked={createForm.enabled}
                  onChange={(checked) => setCreateForm((current) => ({ ...current, enabled: checked }))}
                />
                <ToggleCard
                  label="Auto-rotate"
                  description="Generate a replacement key automatically after the configured interval."
                  checked={createForm.autoRotateEnabled}
                  onChange={(checked) => setCreateForm((current) => ({ ...current, autoRotateEnabled: checked }))}
                />
              </div>
              <Button onClick={handleCreateDomain} isLoading={isSaving}>
                <Save className="h-4 w-4" />
                Add signing identity
              </Button>
            </div>
          </section>
        </div>

        <div className="space-y-6">
          {!selected ? (
            <div className="card rounded-lg border border-dashed border-gray-300 p-8 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
              Select a signing identity to edit its settings and manage DKIM keys.
            </div>
          ) : (
            <>
              <section className="card space-y-4 p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Identity settings</h2>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      Control the domain, signing domain, activation state, and automatic rotation policy.
                    </p>
                  </div>
                  <div className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300">
                    Current active key: <span className="font-mono">{selected.activeSelector ?? 'none'}</span>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <Input
                    label="Domain"
                    value={editForm.domain}
                    onChange={(event) => setEditForm((current) => ({ ...current, domain: event.target.value }))}
                  />
                  <Input
                    label="Signing domain (d=)"
                    value={editForm.signDomain}
                    onChange={(event) => setEditForm((current) => ({ ...current, signDomain: event.target.value }))}
                    placeholder="Defaults to the domain"
                  />
                  <Input
                    label="Rotate after days"
                    type="number"
                    value={editForm.rotateIntervalDays}
                    onChange={(event) => setEditForm((current) => ({
                      ...current,
                      rotateIntervalDays: parseInt(event.target.value, 10) || 90,
                    }))}
                  />
                  <Input
                    label="Retain old days"
                    type="number"
                    value={editForm.retainOldDays}
                    onChange={(event) => setEditForm((current) => ({
                      ...current,
                      retainOldDays: parseInt(event.target.value, 10) || 30,
                    }))}
                  />
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <ToggleCard
                    label="Identity enabled"
                    description="Disabled identities are kept for reference but are not selected for signing."
                    checked={editForm.enabled}
                    onChange={(checked) => setEditForm((current) => ({ ...current, enabled: checked }))}
                  />
                  <ToggleCard
                    label="Auto-rotate"
                    description="When enabled, Robin Admin generates and activates a replacement key on schedule."
                    checked={editForm.autoRotateEnabled}
                    onChange={(checked) => setEditForm((current) => ({ ...current, autoRotateEnabled: checked }))}
                  />
                </div>

                <div className="flex justify-end">
                  <Button onClick={handleSaveDomain} isLoading={isSaving}>
                    <Save className="h-4 w-4" />
                    Save identity
                  </Button>
                </div>
              </section>

              <section className="card space-y-4 p-6">
                <div>
                  <h2 className="text-lg font-semibold">Key management</h2>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    Generate a new active key or import an existing private key. The active key is always the one Robin uses immediately.
                  </p>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
                    <div className="font-medium text-gray-900 dark:text-white">Generate managed key</div>
                    <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                      Selector defaults to today&apos;s date and falls back to letter suffixes when that selector already exists.
                    </p>
                    <div className="mt-4 rounded-lg bg-gray-50 p-3 text-xs text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300">
                      Next selector: <span className="font-mono">{suggestedSelector}</span>
                    </div>
                    <div className="mt-4">
                      <Button variant="secondary" onClick={handleGenerateKey} isLoading={isSaving}>
                        {selected.activeSelector ? <RotateCw className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
                        {selected.activeSelector ? 'Generate and activate replacement key' : 'Generate first active key'}
                      </Button>
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
                    <div className="font-medium text-gray-900 dark:text-white">Import existing key</div>
                    <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                      Paste an RSA private key in PEM format. Robin Admin derives the public key and publishes the matching DNS value for you.
                    </p>
                    <div className="mt-4 space-y-4">
                      <Input
                        label="Selector"
                        value={importForm.selector}
                        onChange={(event) => setImportForm((current) => ({ ...current, selector: event.target.value }))}
                      />
                      <label className="block space-y-1 text-sm">
                        <span className="block font-medium text-gray-700 dark:text-gray-300">RSA private key</span>
                        <textarea
                          value={importForm.privateKey}
                          onChange={(event) => setImportForm((current) => ({ ...current, privateKey: event.target.value }))}
                          rows={8}
                          className="input min-h-48 font-mono text-xs"
                          placeholder="-----BEGIN PRIVATE KEY-----"
                        />
                      </label>
                    </div>
                    <div className="mt-4">
                      <Button variant="secondary" onClick={handleImportKey} isLoading={isSaving}>
                        <KeyRound className="h-4 w-4" />
                        {selected.activeSelector ? 'Import and activate replacement key' : 'Import active key'}
                      </Button>
                    </div>
                  </div>
                </div>
              </section>

              <section className="card space-y-4 p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">DKIM keys</h2>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      Publish <span className="font-mono">selector._domainkey.{selected.signDomain}</span> with the TXT value shown for the active key.
                    </p>
                  </div>
                  <div className={`rounded-full px-3 py-1 text-xs font-medium ${
                    selected.autoRotateEnabled
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                      : 'bg-gray-100 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300'
                  }`}>
                    {selected.autoRotateEnabled ? `Auto-rotate every ${selected.rotateIntervalDays ?? 90} days` : 'Auto-rotate disabled'}
                  </div>
                </div>

                {selectors.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-gray-300 p-8 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
                    No DKIM keys yet for this identity.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {selectors.map((selector) => (
                      <div key={selector.id} className="rounded-lg border border-gray-200 p-4 dark:border-robin-gray-700">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="font-medium text-gray-900 dark:text-white">{selector.selector}</div>
                              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                selector.state === 'active'
                                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                                  : selector.state === 'retired'
                                    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                                    : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                              }`}>
                                {selector.state}
                              </span>
                            </div>
                            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                              {selector.state === 'active'
                                ? 'Signing; the fleet agent delivers this key to Rspamd'
                                : selector.hasPrivateKey
                                  ? `Private key kept${selector.purgeAfter ? ` until ${new Date(selector.purgeAfter).toLocaleDateString()}` : ''}`
                                  : 'Private key purged'}
                            </div>
                          </div>
                          {selector.state !== 'active' && (
                            <Button variant="secondary" size="sm" onClick={() => void handleRevoke(selector.id)}>
                              <ShieldOff className="h-4 w-4" />
                              Revoke
                            </Button>
                          )}
                        </div>

                        <div className="mt-4 grid gap-3 lg:grid-cols-2">
                          <KeyInfoBlock
                            label="DNS host"
                            value={`${selector.selector}._domainkey.${selected.signDomain}`}
                          />
                          <KeyInfoBlock
                            label="TXT value"
                            value={selector.publicKeyTxt}
                          />
                          <KeyInfoBlock
                            label="Activated"
                            value={new Date(selector.activatedAt).toLocaleString()}
                          />
                          <KeyInfoBlock
                            label="Retire or purge"
                            value={selector.purgeAfter ? new Date(selector.purgeAfter).toLocaleString() : 'Managed by rotation policy'}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ToggleCard({
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
    <label className="flex items-start gap-3 rounded-xl border border-gray-200 p-4 text-sm dark:border-robin-gray-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange"
      />
      <div>
        <div className="font-medium text-gray-700 dark:text-gray-300">{label}</div>
        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{description}</div>
      </div>
    </label>
  );
}

function KeyInfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm bg-gray-50 p-3 text-xs dark:bg-robin-gray-900">
      <div className="mb-2 font-semibold text-gray-700 dark:text-gray-300">{label}</div>
      <div className="break-all font-mono text-gray-600 dark:text-gray-300">{value}</div>
    </div>
  );
}

function buildSuggestedSelector(selectors: RspamdDkimSelector[], date = new Date()): string {
  const prefix = date.toISOString().slice(0, 10).replace(/-/g, '');
  const existing = new Set(
    selectors
      .map((selector) => selector.selector.toLowerCase())
      .filter((selector) => selector === prefix || selector.startsWith(prefix))
  );
  if (!existing.has(prefix)) {
    return prefix;
  }
  for (const suffix of 'abcdefghijklmnopqrstuvwxyz') {
    const candidate = `${prefix}${suffix}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  return `${prefix}-next`;
}
