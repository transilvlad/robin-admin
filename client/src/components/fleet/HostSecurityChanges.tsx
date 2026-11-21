import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { ApiError, hostSecurityApi } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import type { HostSecurityCurrentDiff, HostSecurityDiffItem } from '../../types/host-security';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { SecurityBadge, SecurityError, SecurityTime, hostSecuritySectionLabels, securityFieldLabel, securityFieldValue } from './hostSecurityUi';

const changeLabels = { added: 'Added', removed: 'Removed', changed: 'Changed' };
const changeTones = { added: 'info', removed: 'warning', changed: 'neutral' } as const;
const sshSettingLabels: Record<string, string> = {
  passwordauthentication: 'Password authentication',
  pubkeyauthentication: 'Public-key authentication',
  kbdinteractiveauthentication: 'Keyboard-interactive authentication',
  permitrootlogin: 'Root login',
  permitemptypasswords: 'Empty passwords',
  authenticationmethods: 'Authentication methods',
  allowusers: 'Allowed users',
  allowgroups: 'Allowed groups',
  denyusers: 'Denied users',
  denygroups: 'Denied groups',
  maxauthtries: 'Maximum authentication attempts',
};

function changeTitle(item: HostSecurityDiffItem) {
  if (item.section === 'sshKeys') {
    const key = item.after ?? item.before;
    if (key) return key.comment ? key.comment + ' · ' + key.user : 'SSH key for ' + key.user;
  }
  if (item.section === 'patching') return 'System updates and reboot status';
  if (item.section === 'listeners') {
    const listener = item.after ?? item.before;
    if (listener) {
      const address = listener.address.includes(':') ? `[${listener.address}]` : listener.address;
      return `${listener.protocol.toUpperCase()} ${address}:${listener.port}`;
    }
  }
  return item.section === 'sshd' ? sshSettingLabels[item.itemId] ?? item.itemId : item.itemId;
}

function ChangeComparison({ item }: { item: HostSecurityDiffItem }) {
  const before = item.before ? new Map<string, unknown>(Object.entries(item.before)) : new Map<string, unknown>();
  const after = item.after ? new Map<string, unknown>(Object.entries(item.after)) : new Map<string, unknown>();
  const fields = [...new Set([...before.keys(), ...after.keys()])].filter(field =>
    JSON.stringify(before.get(field)) !== JSON.stringify(after.get(field)));
  return (
    <div className="table-container rounded-lg border border-gray-200 dark:border-robin-gray-700" role="region" aria-label="Change comparison" tabIndex={0}>
      <table className="table">
        <thead><tr><th scope="col">Field</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
        <tbody>
          {fields.map(field => (
            <tr key={field}>
              <th scope="row" className="px-3 py-2 text-left text-sm font-medium">{securityFieldLabel(field)}</th>
              <td className="min-w-36 wrap-anywhere">{securityFieldValue(before.get(field))}</td>
              <td className="min-w-36 wrap-anywhere">{securityFieldValue(after.get(field))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Approval = {
  snapshotId: string;
  baselineRevision: number;
  items: HostSecurityDiffItem[];
  single: boolean;
};

function ApprovalChange({ item, selected, onToggle }: {
  item: HostSecurityDiffItem; selected: boolean; onToggle: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="space-y-2 p-3">
      <label className="flex items-start gap-3 text-sm">
        <input className="mt-1 shrink-0 accent-robin-orange" type="checkbox" checked={selected} onChange={onToggle} />
        <span className="min-w-0 flex-1">
          <span className="block wrap-anywhere font-medium">{changeTitle(item)}</span>
          <span className="block text-xs text-gray-500 dark:text-gray-400">{hostSecuritySectionLabels[item.section]}</span>
        </span>
        <SecurityBadge tone={changeTones[item.change]}>{changeLabels[item.change]}</SecurityBadge>
      </label>
      <details className="pl-6" onToggle={event => setExpanded(event.currentTarget.open)}>
        <summary className="cursor-pointer text-sm text-robin-orange">Compare before and after</summary>
        {expanded && <div className="pt-2"><ChangeComparison item={item} /></div>}
      </details>
    </li>
  );
}

function ApprovalSelection({ items, selected, onSelect, disabled }: {
  items: HostSecurityDiffItem[]; selected: Set<string>; onSelect: (selection: Set<string>) => void; disabled: boolean;
}) {
  const [limit, setLimit] = useState(50);
  if (items.length === 0) return <p className="text-sm">The readable inventory contains no changes.</p>;
  return (
    <fieldset className="min-w-0 space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium">{selected.size} of {items.length} selected</legend>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={disabled || selected.size === items.length}
          onClick={() => onSelect(new Set(items.map(item => item.id)))}>Select all</Button>
        <Button type="button" variant="secondary" size="sm" disabled={disabled || selected.size === 0}
          onClick={() => onSelect(new Set())}>Clear selection</Button>
      </div>
      <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-robin-gray-700 dark:border-robin-gray-700">
        {items.slice(0, limit).map(item => (
          <ApprovalChange key={item.id} item={item} selected={selected.has(item.id)} onToggle={() => {
            const next = new Set(selected);
            if (next.has(item.id)) next.delete(item.id);
            else next.add(item.id);
            onSelect(next);
          }} />
        ))}
      </ul>
      {items.length > limit && <Button type="button" variant="secondary" size="sm" onClick={() => setLimit(limit + 50)}>
        Show more changes ({limit} of {items.length} shown)
      </Button>}
    </fieldset>
  );
}

export function HostSecurityChanges({ hostId, hostName, diff, changes, canSetBaseline, completeCoverage }: {
  hostId: string;
  hostName: string;
  diff: HostSecurityCurrentDiff;
  changes: HostSecurityDiffItem[] | undefined;
  canSetBaseline: boolean;
  completeCoverage: boolean;
}) {
  const { user } = useAuth();
  const client = useQueryClient();
  const [limit, setLimit] = useState(100);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: ['host-security', 'hosts'] }),
    client.invalidateQueries({ queryKey: ['host-security', 'host', hostId] }),
  ]);
  const mutation = useMutation({
    mutationFn: ({ review, itemIds }: { review: Approval; itemIds?: string[] }) => hostSecurityApi.approve(hostId, {
      snapshotId: review.snapshotId,
      baselineRevision: review.baselineRevision,
      itemIds,
      reason: reason.trim() || undefined,
    }),
    onSuccess: async (_data, { review }) => {
      await refresh();
      setNotice(review.baselineRevision === 0 ? 'Baseline approved.' : 'Changes approved.');
      setApproval(null);
    },
    onError: async error => {
      if (error instanceof ApiError && error.status === 409) await refresh();
    },
  });
  const changeCount = changes?.length ?? 0;
  const canReview = diff.baselinePending ? canSetBaseline : changeCount > 0;
  const approvalChanged = approval && (
    approval.snapshotId !== diff.snapshotId || approval.baselineRevision !== diff.baselineRevision || !changes
  );
  const conflict = mutation.error instanceof ApiError && mutation.error.status === 409;
  const reviewLocked = !!approvalChanged || conflict || mutation.isPending;
  const canSubmit = !!approval && !reviewLocked
    && (selectedIds.size > 0 || (approval.baselineRevision === 0 && approval.items.length === 0));

  function review(item?: HostSecurityDiffItem) {
    if (!changes) return;
    const items = item ? [item] : changes;
    setNotice('');
    setReason('');
    mutation.reset();
    setSelectedIds(new Set(items.map(change => change.id)));
    setApproval({
      snapshotId: diff.snapshotId,
      baselineRevision: diff.baselineRevision,
      items,
      single: !!item,
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!approval || !canSubmit || user?.role !== 'admin') return;
    const all = !approval.single && selectedIds.size === approval.items.length;
    mutation.mutate({ review: approval, itemIds: all ? undefined : [...selectedIds] });
  }

  const singleItem = approval?.single ? approval.items[0] : undefined;
  const approvalTitle = singleItem ? 'Approve change' : approval?.baselineRevision === 0 ? 'Approve baseline' : 'Approve selected changes';

  return (
    <section aria-labelledby="baseline-changes-heading" className="card overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-robin-gray-700">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="baseline-changes-heading" className="font-semibold">Baseline changes</h2>
            {diff.baselinePending && <SecurityBadge tone="info">Baseline pending</SecurityBadge>}
          </div>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {diff.baselinePending ? 'Review the collected inventory before establishing a baseline.' : 'Compare reported changes with the approved baseline.'}
          </p>
        </div>
        {user?.role === 'admin' && (diff.baselinePending || canReview) && (
          <Button variant="secondary" disabled={!canReview || mutation.isPending} onClick={() => review()}>
            <ShieldCheck aria-hidden="true" className="h-4 w-4" />
            {diff.baselinePending ? 'Review baseline' : `Review ${changeCount} ${changeCount === 1 ? 'change' : 'changes'}`}
          </Button>
        )}
      </div>
      {diff.lastApproval && (
        <div className="border-b border-gray-200 bg-gray-50 px-4 py-3 text-sm dark:border-robin-gray-700 dark:bg-robin-gray-900/40">
          <h3 className="font-medium">Last approval</h3>
          <p className="wrap-anywhere text-gray-600 dark:text-gray-300">
            {diff.lastApproval.approver} · <SecurityTime value={diff.lastApproval.approvedAt} />
          </p>
          {diff.lastApproval.reason && <p className="wrap-anywhere">{diff.lastApproval.reason}</p>}
        </div>
      )}
      {notice && <p role="status" className="px-4 pt-4 text-sm text-green-700 dark:text-green-300">{notice}</p>}
      {changeCount === 0 && (
        <p className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
          {!changes ? 'Waiting for the snapshot for this comparison.'
            : diff.baselinePending ? 'No items were reported for baseline comparison.'
              : completeCoverage ? 'No differences from the baseline.' : 'No differences were found in the reported inventory.'}
        </p>
      )}
      {changes && changes.length > 0 && <ul className="divide-y divide-gray-200 dark:divide-robin-gray-700">
        {changes.slice(0, limit).map(item => (
          <li key={item.id} className="flex flex-wrap items-start gap-3 p-4 sm:flex-nowrap">
            <details className="min-w-0 flex-1">
              <summary className="cursor-pointer">
                <span className="ml-2 inline-flex max-w-[calc(100%-1.25rem)] flex-wrap items-center gap-2 align-middle">
                  <span className="wrap-anywhere font-medium">{changeTitle(item)}</span>
                  <SecurityBadge tone={changeTones[item.change]}>{changeLabels[item.change]}</SecurityBadge>
                </span>
              </summary>
              <div className="mt-3 space-y-3">
                {item.itemId !== changeTitle(item) && item.section === 'sshd' && (
                  <code className="text-xs text-gray-500 dark:text-gray-400">{item.itemId}</code>
                )}
                <ChangeComparison item={item} />
              </div>
            </details>
            <span className="w-full text-xs text-gray-500 sm:w-auto sm:self-center dark:text-gray-400">{hostSecuritySectionLabels[item.section]}</span>
            {user?.role === 'admin' && (
              <Button size="sm" variant="secondary" aria-label={'Review change: ' + changeTitle(item)} onClick={() => review(item)}>Review change</Button>
            )}
          </li>
        ))}
      </ul>}
      {changeCount > limit && (
        <div className="border-t border-gray-200 px-4 py-3 dark:border-robin-gray-700">
          <Button variant="secondary" size="sm" onClick={() => setLimit(limit + 100)}>Show more changes</Button>
        </div>
      )}
      {approval && user?.role === 'admin' && (
        <Modal isOpen title={approvalTitle} size="lg" onClose={() => { if (!mutation.isPending) setApproval(null); }}>
          <form className="space-y-4" onSubmit={submit}>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {approval.baselineRevision === 0 ? 'Set the baseline for ' : 'Update the baseline for '}<strong>{hostName}</strong>.
              {' '}This approval will be recorded in the audit log.
            </p>
            {singleItem ? (
              <>
                <p className="wrap-anywhere text-sm font-medium">{changeTitle(singleItem)}</p>
                <ChangeComparison item={singleItem} />
              </>
            ) : (
              <ApprovalSelection items={approval.items} selected={selectedIds} onSelect={setSelectedIds} disabled={reviewLocked} />
            )}
            <Input label="Approval reason (optional)" maxLength={512} value={reason} onChange={event => setReason(event.target.value)} disabled={mutation.isPending} />
            <SecurityError error={mutation.error} label="Approval failed" />
            {approvalChanged && !conflict && <p role="alert" className="text-sm text-amber-800 dark:text-amber-200">The snapshot or baseline changed. Close this dialog and review the current changes.</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" disabled={mutation.isPending} onClick={() => setApproval(null)}>Cancel</Button>
              <Button type="submit" isLoading={mutation.isPending} disabled={!canSubmit}>{approvalTitle}</Button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
