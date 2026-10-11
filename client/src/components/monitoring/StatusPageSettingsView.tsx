import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { ApiError, statusPageApi } from '../../api/client';
import type { StatusPageSettings } from '../../types/status-page';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';

export function StatusPageSettingsView() {
  const [form, setForm] = useState<StatusPageSettings | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  useEffect(() => {
    let cancelled = false;
    statusPageApi.adminSummary().then(response => {
      if (!response.data?.settings) throw new Error('Settings missing');
      if (!cancelled) setForm(response.data.settings);
    }).catch(err => { if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load status page settings'); });
    return () => { cancelled = true; };
  }, []);
  const save = async () => {
    if (!form) return;
    setWorking(true); setError(''); setSuccess('');
    try {
      const response = await statusPageApi.updateSettings(form);
      if (!response.data) throw new Error('Settings missing');
      setForm(response.data); setSuccess('Status page settings saved');
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to save status page settings'); }
    finally { setWorking(false); }
  };
  return <section className="space-y-4" aria-label="Status page settings">
    {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    {success && <p role="status" className="text-sm text-green-700 dark:text-green-400">{success}</p>}
    {!form ? (!error && <Spinner label="Loading status page settings" />) : <form onSubmit={event => { event.preventDefault(); void save(); }} className="space-y-5">
      <fieldset disabled={working} className="grid gap-4 border-t border-gray-200 pt-5 dark:border-robin-gray-700 lg:grid-cols-2">
        <Input label="Company name" required value={form.companyName} onChange={event => setForm({ ...form, companyName: event.target.value })} />
        <Input label="Company URL" value={form.companyUrl ?? ''} onChange={event => setForm({ ...form, companyUrl: event.target.value || null })} />
        <Input label="Logo URL" value={form.logoUrl ?? ''} onChange={event => setForm({ ...form, logoUrl: event.target.value || null })} />
        <Input label="Custom domain" value={form.customDomain ?? ''} onChange={event => setForm({ ...form, customDomain: event.target.value || null })} />
        <Input label="Timezone" value={form.timezone} onChange={event => setForm({ ...form, timezone: event.target.value })} />
        <Input label="History days" type="number" min={1} max={365} required value={form.historyDays} onChange={event => setForm({ ...form, historyDays: Number(event.target.value) })} />
        <label className="text-sm font-medium">Theme<select className="input mt-1 w-full" value={form.theme} onChange={event => setForm({ ...form, theme: event.target.value as StatusPageSettings['theme'] })}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        <Input label="Announcement" value={form.announcement ?? ''} onChange={event => setForm({ ...form, announcement: event.target.value || null })} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.published} onChange={event => setForm({ ...form, published: event.target.checked })} />Published</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.subscribable} onChange={event => setForm({ ...form, subscribable: event.target.checked })} />Email subscriptions</label>
      </fieldset>
      <fieldset disabled={working} className="grid gap-4 border-t border-gray-200 pt-5 dark:border-robin-gray-700 lg:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">Pages and incidents</legend>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.incidentHistoryEnabled} onChange={event => setForm({ ...form, incidentHistoryEnabled: event.target.checked })} />Previous incidents page and a page per incident</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.maintenancePageEnabled} onChange={event => setForm({ ...form, maintenancePageEnabled: event.target.checked })} />Maintenance page</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.feedsEnabled} onChange={event => setForm({ ...form, feedsEnabled: event.target.checked })} />RSS and JSON feeds of incidents</label>
        <span />
        <div className="space-y-1"><Input label="Group failures into one incident within (minutes)" type="number" min={0} max={1440} required value={form.incidentGroupingMinutes} onChange={event => setForm({ ...form, incidentGroupingMinutes: Number(event.target.value) })} /><p className="text-xs text-gray-500 dark:text-gray-400">Failures that start while an incident is open, or this many minutes after it resolved, join it. 0 gives every failure its own incident.</p></div>
        <div className="space-y-1"><Input label="Recent incidents on the main page (days)" type="number" min={0} max={90} required value={form.homeIncidentDays} onChange={event => setForm({ ...form, homeIncidentDays: Number(event.target.value) })} /><p className="text-xs text-gray-500 dark:text-gray-400">Resolved incidents from this many days are listed under the services. 0 lists none.</p></div>
      </fieldset>
      <Button type="submit" disabled={working}><Save className="h-4 w-4" />{working ? 'Saving...' : 'Save'}</Button>
    </form>}
  </section>;
}
