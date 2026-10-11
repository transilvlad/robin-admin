import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { ApiError, rspamdApi } from '../../api/client';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';

/**
 * Set or remove the Rspamd controller password robin-admin authenticates with.
 * The password is write-only: the server only reports whether one is set.
 */
export function RspamdControllerPassword({
  serviceId,
  hasPassword,
  onSaved,
}: {
  serviceId: string;
  hasPassword: boolean;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const close = () => {
    setOpen(false);
    setPassword('');
    setError('');
  };

  const save = async (value: string) => {
    setSaving(true);
    setError('');
    try {
      await rspamdApi.updateSettings({ rspamdControllerPassword: value }, serviceId);
      close();
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save the controller password');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span>Password {hasPassword ? 'set' : 'not set'}</span>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          <KeyRound className="h-3.5 w-3.5" />
          {hasPassword ? 'Change' : 'Set'}
        </Button>
      </div>
      <Modal isOpen={open} onClose={close} title="Rspamd controller password" size="sm">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (password) void save(password);
          }}
        >
          <p className="text-sm text-gray-600 dark:text-gray-300">
            The plaintext password for the controller&apos;s <code>password</code> setting. robin-admin sends it on
            privileged requests (<code>/stat</code>, <code>/healthy</code>, learning) and never shows it again.
          </p>
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={hasPassword ? 'New password' : 'Password'}
            aria-label="Controller password"
            className="input w-full"
          />
          {error && <div className="rounded-sm border border-red-200 bg-red-50 p-2 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">{error}</div>}
          <div className="flex justify-between gap-2">
            {hasPassword ? (
              <Button type="button" variant="danger" disabled={saving} onClick={() => void save('')}>
                Remove password
              </Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
              <Button type="submit" disabled={saving || !password}>Save</Button>
            </div>
          </div>
        </form>
      </Modal>
    </>
  );
}
