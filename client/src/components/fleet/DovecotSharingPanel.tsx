import { useState } from 'react';
import { dovecotApi } from '../../api/client';
import { useConfirm } from '../../context/ConfirmContext';
import type { DovecotAclState } from '../../types';
import { Button } from '../ui/Button';

const PRESETS = {
  read: ['lookup', 'read'],
  seen: ['lookup', 'read', 'write-seen'],
  write: ['lookup', 'read', 'write', 'write-seen', 'write-deleted', 'insert', 'post', 'expunge', 'create', 'delete'],
};

export function DovecotSharingPanel({ serviceId }: { serviceId: string }) {
  const confirm = useConfirm();
  const [owner, setOwner] = useState('');
  const [mailbox, setMailbox] = useState('INBOX');
  const [member, setMember] = useState('');
  const [preset, setPreset] = useState<keyof typeof PRESETS>('read');
  const [state, setState] = useState<DovecotAclState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const run = async (operation: 'get' | 'set' | 'delete') => {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      if (operation !== 'get' && !(await confirm(
        operation === 'set'
          ? `Replace ${member}'s named-user ACL on ${owner}/${mailbox} with ${PRESETS[preset].join(', ')}? This does not grant send-as.`
          : `Remove ${member}'s named-user ACL on ${owner}/${mailbox}? Other group/global rights may still permit access.`,
      ))) return;
      setState(null);
      const response = operation === 'get'
        ? await dovecotApi.getAcl(serviceId, owner, mailbox)
        : operation === 'set'
          ? await dovecotApi.setAcl(serviceId, owner, mailbox, member, PRESETS[preset])
          : await dovecotApi.deleteAcl(serviceId, owner, mailbox, member);
      if (!response.data || (operation !== 'get' && response.data.applied !== true)) {
        throw new Error('Backend readback was not confirmed. Read the ACL before retrying any change.');
      }
      setState(response.data);
      if (operation !== 'get') setSuccess('Named-user ACL change confirmed by backend readback. Reconnect clients to re-evaluate access.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ACL operation failed; read back before retrying.');
    } finally {
      setBusy(false);
    }
  };

  const clearReadback = () => { setState(null); setSuccess(''); };
  return (
    <div className="card space-y-4 p-4">
      <h2 className="text-lg font-semibold">Shared mailbox ACL</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Requires backend ACL/shared-namespace provisioning. This edits the mailbox ACL, not routing or send-as grants.
        Readback shows stored entries, not effective access through every group or global policy.
      </p>
      <fieldset disabled={busy} className="space-y-4">
        <div className="flex flex-wrap gap-3">
          <label className="text-sm">Owner address
            <input className="input mt-1 block" type="email" value={owner} onChange={(e) => { setOwner(e.target.value); clearReadback(); }} />
          </label>
          <label className="text-sm">Mailbox
            <input className="input mt-1 block" value={mailbox} onChange={(e) => { setMailbox(e.target.value); clearReadback(); }} />
          </label>
          <Button variant="secondary" disabled={!owner.trim() || !mailbox.trim()} onClick={() => void run('get')}>Read ACL</Button>
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="text-sm">Member address
            <input className="input mt-1 block" type="email" value={member} onChange={(e) => setMember(e.target.value)} />
          </label>
          <label className="text-sm">Rights
            <select className="input mt-1 block" value={preset} onChange={(e) => setPreset(e.target.value as keyof typeof PRESETS)}>
              <option value="read">Read only</option>
              <option value="seen">Read and mark seen</option>
              <option value="write">Read and write (no ACL administration)</option>
            </select>
          </label>
          <Button disabled={!owner.trim() || !mailbox.trim() || !member.trim()} onClick={() => void run('set')}>Set member ACL</Button>
          <Button variant="secondary" disabled={!owner.trim() || !mailbox.trim() || !member.trim()} onClick={() => void run('delete')}>Remove member ACL</Button>
        </div>
      </fieldset>
      {error && <div role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</div>}
      {success && <div role="status" className="text-sm text-green-700 dark:text-green-300">{success}</div>}
      {state && (
        <div className="overflow-x-auto">
          <p className="text-sm">Backend readback: {state.owner} / {state.mailbox}</p>
          <table className="mt-2 min-w-full text-left text-sm">
            <thead><tr><th>Identifier</th><th>Scope</th><th>Rights</th></tr></thead>
            <tbody>{state.entries.map((entry) => (
              <tr key={`${entry.identifier}:${entry.global}`}>
                <td>{entry.identifier}</td><td>{entry.global ? 'Global' : 'Mailbox'}</td><td>{entry.rights.join(', ') || 'None'}</td>
              </tr>
            ))}</tbody>
          </table>
          {state.entries.length === 0 && <p className="text-sm">No explicit ACL entries returned.</p>}
        </div>
      )}
    </div>
  );
}
