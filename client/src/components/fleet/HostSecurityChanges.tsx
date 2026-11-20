import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { ApiError, hostSecurityApi } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import type { HostSecurityDiff, HostSecurityDiffItem, HostSecuritySnapshot } from '../../types/host-security';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { SecurityBadge, SecurityError, hostSecuritySectionLabels, securityFieldLabel, securityFieldValue } from './hostSecurityUi';

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
  item?: HostSecurityDiffItem;
  itemCount: number;
  sectionCounts: Map<HostSecurityDiffItem['section'], number>;
  establishesBaseline: boolean;
};

export function HostSecurityChanges({ hostId, hostName, diff, snapshot }: {
  hostId: string; hostName: string; diff: HostSecurityDiff; snapshot?: HostSecuritySnapshot;
}) {
  const { user } = useAuth();
  const client = useQueryClient();
  const [limit, setLimit] = useState(100);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: ['host-security', 'hosts'] }),
    client.invalidateQueries({ queryKey: ['host-security', 'host', hostId] }),
  ]);
  const mutation = useMutation({
    mutationFn: (selection: Approval) => hostSecurityApi.approve(hostId, {
      snapshotId: selection.snapshotId,
      baselineRevision: selection.baselineRevision,
      itemIds: selection.item ? [selection.item.id] : undefined,
      reason: reason.trim() || undefined,
    }),
    onSuccess: async (_data, selection) => {
      await refresh();
      setNotice(selection.establishesBaseline ? 'Baseline approved.' : 'Changes approved.');
      setApproval(null);
    },
    onError: async error => {
      if (error instanceof ApiError && error.status === 409) await refresh();
    },
  });
  const matchesSnapshot = snapshot?.id === diff.snapshotId;
  const completeCoverage = matchesSnapshot && snapshot && Object.values(snapshot.sections).every(section => section.status === 'ok' && section.complete);
  const readableChanges = matchesSnapshot ? diff.items.filter(item => snapshot?.sections[item.section].status === 'ok') : [];
  const canApproveBaseline = matchesSnapshot && !!snapshot && Object.values(snapshot.sections).some(section => section.status === 'ok');
  const canApproveAll = canApproveBaseline && (diff.baselinePending || readableChanges.length > 0);
  const approvalChanged = approval && (
    approval.snapshotId !== diff.snapshotId || approval.baselineRevision !== diff.baselineRevision || !matchesSnapshot
  );
  const conflict = mutation.error instanceof ApiError && mutation.error.status === 409;

  function review(item?: HostSecurityDiffItem) {
    const sectionCounts = new Map<HostSecurityDiffItem['section'], number>();
    if (!item) {
      for (const change of readableChanges) sectionCounts.set(change.section, (sectionCounts.get(change.section) ?? 0) + 1);
    }
    setNotice('');
    setReason('');
    mutation.reset();
    setApproval({
      snapshotId: diff.snapshotId,
      baselineRevision: diff.baselineRevision,
      item,
      itemCount: item ? 1 : readableChanges.length,
      sectionCounts,
      establishesBaseline: diff.baselinePending,
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (approval && !approvalChanged && !conflict && !mutation.isPending && user?.role === 'admin') mutation.mutate(approval);
  }

  const approvalCount = approval
    ? approval.itemCount + (approval.itemCount === 1 ? ' readable change' : ' readable changes')
    : '';
  const approvalTitle = approval?.item ? 'Approve change' : approval?.establishesBaseline ? 'Approve baseline' : 'Approve readable changes';

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
        {user?.role === 'admin' && (
          <Button variant="secondary" disabled={!canApproveAll || mutation.isPending} onClick={() => review()}>
            <ShieldCheck aria-hidden="true" className="h-4 w-4" />
            {diff.baselinePending ? 'Review baseline' : 'Review all readable changes'}
          </Button>
        )}
      </div>
      {notice && <p role="status" className="px-4 pt-4 text-sm text-green-700 dark:text-green-300">{notice}</p>}
      {diff.items.length === 0 && (
        <p className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
          {diff.baselinePending ? 'No items were reported for baseline comparison.'
            : completeCoverage ? 'No differences from the baseline.' : 'No differences were found in the reported inventory.'}
        </p>
      )}
      <ul className="divide-y divide-gray-200 dark:divide-robin-gray-700">
        {diff.items.slice(0, limit).map(item => (
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
            {user?.role === 'admin' && matchesSnapshot && snapshot?.sections[item.section].status === 'ok' && (
              <Button size="sm" variant="secondary" aria-label={'Review change: ' + changeTitle(item)} onClick={() => review(item)}>Review change</Button>
            )}
          </li>
        ))}
      </ul>
      {diff.items.length > limit && (
        <div className="border-t border-gray-200 px-4 py-3 dark:border-robin-gray-700">
          <Button variant="secondary" size="sm" onClick={() => setLimit(limit + 100)}>Show more changes</Button>
        </div>
      )}
      {approval && user?.role === 'admin' && (
        <Modal isOpen title={approvalTitle} size="lg" onClose={() => { if (!mutation.isPending) setApproval(null); }}>
          <form className="space-y-4" onSubmit={submit}>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {approval.establishesBaseline ? 'Set the baseline for ' : 'Update the baseline for '}<strong>{hostName}</strong>.
              {' '}This approval will be recorded in the audit log.
            </p>
            {approval.item ? (
              <>
                <p className="wrap-anywhere text-sm font-medium">{changeTitle(approval.item)}</p>
                <ChangeComparison item={approval.item} />
              </>
            ) : (
              <div className="space-y-2">
                <p className="text-sm font-medium">{approvalCount}</p>
                {approval.sectionCounts.size > 0 && (
                  <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 text-sm dark:divide-robin-gray-700 dark:border-robin-gray-700">
                    {[...approval.sectionCounts].map(([section, count]) => (
                      <li key={section} className="flex justify-between gap-3 px-3 py-2">
                        <span>{hostSecuritySectionLabels[section]}</span><span className="tabular-nums">{count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <Input label="Approval reason (optional)" maxLength={512} value={reason} onChange={event => setReason(event.target.value)} disabled={mutation.isPending} />
            <SecurityError error={mutation.error} label="Approval failed" />
            {approvalChanged && !conflict && <p role="alert" className="text-sm text-amber-800 dark:text-amber-200">The snapshot or baseline changed. Close this dialog and review the current changes.</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" disabled={mutation.isPending} onClick={() => setApproval(null)}>Cancel</Button>
              <Button type="submit" isLoading={mutation.isPending} disabled={!!approvalChanged || conflict}>{approvalTitle}</Button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
