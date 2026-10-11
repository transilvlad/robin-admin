import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { Download, RefreshCw, Save, Shield } from 'lucide-react';
import { Link } from 'react-router-dom';
import { modulePolicyApi, type ModuleHostPolicy } from '../../api/client';
import { SettingsCard } from './AdminPrimitives';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Spinner } from '../ui/Spinner';

export interface ModuleHostPoliciesHandle { saveAll(): Promise<boolean>; reset(): Promise<void> }
export const ModuleHostPolicies = forwardRef<ModuleHostPoliciesHandle, { disabled: boolean }>(function ModuleHostPolicies({ disabled }, ref) {
  const [policies, setPolicies] = useState<ModuleHostPolicy[]>([]);
  const [trust, setTrust] = useState<{ issuer: string; keys: unknown[] }>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string>();
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  async function load() {
    setLoading(true); setError(''); setSuccess('');
    try {
      const response = await modulePolicyApi.get();
      if (!response.data) throw new Error('Module policies unavailable');
      setPolicies(response.data.policies); setTrust(response.data.trust);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load module policies'); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (!disabled) void load(); else setLoading(false); }, [disabled]);
  function change(slug: string, update: Partial<ModuleHostPolicy>) {
    setPolicies(current => current.map(policy => policy.slug === slug ? { ...policy, ...update } : policy));
  }
  async function save(policy: ModuleHostPolicy) {
    setSaving(policy.slug); setError(''); setSuccess('');
    try {
      const response = await modulePolicyApi.save(policy);
      if (!response.data) throw new Error('Module policy was not saved');
      change(policy.slug, response.data);
      setSuccess(`Policy saved for ${policy.slug}`);
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save module policy'); return false; }
    finally { setSaving(undefined); }
  }
  useImperativeHandle(ref, () => ({
    reset: load,
    async saveAll() {
      if (disabled || loading || saving) return false;
      for (const policy of policies) if (!(await save(policy))) return false;
      return true;
    },
  }));
  function downloadTrust() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(trust, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'robin-admin-identity-trust.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <SettingsCard title="Module access and uploads" icon={Shield}
    action={<div className="flex gap-2">
      <Button variant="secondary" disabled={disabled || !trust} onClick={downloadTrust} aria-label="Download identity public keys" title="Download identity public keys"><Download className="h-4 w-4" /></Button>
      <Button variant="secondary" disabled={disabled || loading} onClick={() => void load()} aria-label="Reload module policies" title="Reload module policies"><RefreshCw className="h-4 w-4" /></Button>
    </div>}>
    {error && <div role="alert" className="mb-4 text-sm text-red-600">{error}</div>}
    {success && <div role="status" className="mb-4 text-sm text-green-700">{success}</div>}
    {loading ? <Spinner /> : <div className="divide-y divide-gray-200 dark:divide-gray-700">
      {policies.map(policy => <div key={policy.slug} className="grid min-w-0 gap-4 py-4 md:grid-cols-2 xl:grid-cols-5">
        <div className="min-w-0 wrap-break-word text-sm font-medium">{policy.slug}</div>
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={policy.directoryRead} disabled={disabled || !!saving} onChange={e => change(policy.slug, { directoryRead: e.target.checked })} />Admin directory</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={policy.lifecycleRead} disabled={disabled || !!saving} onChange={e => change(policy.slug, { lifecycleRead: e.target.checked })} />Account lifecycle events</label>
        </div>
        <Input label="Maximum body (MiB)" type="number" min={1} max={64} value={policy.maxBodyMiB} disabled={disabled || !!saving} onChange={e => change(policy.slug, { maxBodyMiB: Number(e.target.value) })} />
        <Input label="Backend timeout (seconds)" type="number" min={5} max={120} value={policy.timeoutSeconds} disabled={disabled || !!saving} onChange={e => change(policy.slug, { timeoutSeconds: Number(e.target.value) })} />
        <div className="flex items-end"><Button disabled={disabled || !!saving} isLoading={saving === policy.slug} onClick={() => void save(policy)} aria-label={`Save policy for ${policy.slug}`} title={`Save policy for ${policy.slug}`}><Save className="h-4 w-4" /></Button></div>
      </div>)}
    </div>}
    {trust && (
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="break-all text-xs text-gray-500">{trust.issuer}</div>
        <Link className="text-sm text-robin-orange hover:underline" to="/administration/security?tab=identity">
          Manage signing-key rotation
        </Link>
      </div>
    )}
  </SettingsCard>;
});
