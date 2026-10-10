import { useCallback, useEffect, useState } from 'react';
import { ApiError, rspamdApi } from '../../api/client';
import { Button } from '../ui/Button';
import { RspamdControllerPassword } from './RspamdControllerPassword';

/**
 * Per-service Rspamd settings that aren't endpoints: the controller password
 * robin-admin authenticates with, and where robin-admin keeps training samples
 * and scan uploads. Training stays hidden until its directory is set.
 */
export function RspamdServiceSettings({ serviceId, onSaved }: { serviceId: string; onSaved: () => void }) {
  const [hasPassword, setHasPassword] = useState(false);
  const [trainingDir, setTrainingDir] = useState('');
  const [storeDir, setStoreDir] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await rspamdApi.getSettings(serviceId);
      const settings = res.data?.settings;
      setHasPassword(Boolean(settings?.hasControllerPassword));
      setTrainingDir(settings?.rspamdTrainingDir ?? '');
      setStoreDir(settings?.rspamdStoreDir ?? '');
    } catch {
      setMessage({ tone: 'error', text: 'Could not load the Rspamd settings' });
    }
  }, [serviceId]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await rspamdApi.updateSettings({ rspamdTrainingDir: trainingDir.trim(), rspamdStoreDir: storeDir.trim() }, serviceId);
      setMessage({ tone: 'ok', text: 'Storage settings saved' });
      onSaved();
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'Failed to save the storage settings' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4 border-t border-gray-200 pt-5 dark:border-robin-gray-700" aria-label="Rspamd access and storage">
      <div>
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Rspamd access and storage</h3>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Saved separately from the service. The directories are on robin-admin&apos;s own disk.
        </p>
      </div>
      <div className="rounded-lg border border-gray-200 p-3 text-sm dark:border-robin-gray-700">
        <div className="font-medium text-gray-700 dark:text-gray-300">Controller password</div>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Needed for statistics, logs, learning and classifier details.</p>
        <RspamdControllerPassword serviceId={serviceId} hasPassword={hasPassword} onSaved={() => { void load(); onSaved(); }} />
      </div>
      <form
        className="grid gap-3 md:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="space-y-1 text-sm">
          <span className="block font-medium text-gray-700 dark:text-gray-300">Training directory</span>
          <input className="input" value={trainingDir} onChange={(event) => setTrainingDir(event.target.value)} placeholder="/mnt/rspamd/store/training" />
          <span className="block text-xs text-gray-500 dark:text-gray-400">Where imported training samples are kept. Rspamd → Training needs it.</span>
        </label>
        <label className="space-y-1 text-sm">
          <span className="block font-medium text-gray-700 dark:text-gray-300">Store directory</span>
          <input className="input" value={storeDir} onChange={(event) => setStoreDir(event.target.value)} placeholder="/mnt/rspamd/store" />
          <span className="block text-xs text-gray-500 dark:text-gray-400">Keeps scanned messages so a scan can be replayed or learned.</span>
        </label>
        <div className="flex items-center justify-end gap-3 md:col-span-2">
          {message && (
            <span role="status" className={`text-xs ${message.tone === 'ok' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
              {message.text}
            </span>
          )}
          <Button type="submit" variant="secondary" isLoading={saving}>Save storage</Button>
        </div>
      </form>
    </section>
  );
}
