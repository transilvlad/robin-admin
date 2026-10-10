import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, Pause, Play, RefreshCw, RotateCcw, Send, Trash2 } from 'lucide-react';
import { ApiError, postfixApi } from '../../api/client';
import { useConfirm } from '../../context/ConfirmContext';
import { formatBytes } from '../../utils/format';
import type { PostfixQueueAction, PostfixQueueMessage } from '../../types';
import { BulkActionBar } from '../ui/BulkActionBar';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { SearchInput } from '../ui/SearchInput';
import { SegmentedFilter } from '../ui/SegmentedFilter';
import { Table } from '../ui/Table';

const QUEUE_FILTERS = ['all', 'active', 'deferred', 'hold', 'incoming'] as const;
type QueueFilter = typeof QUEUE_FILTERS[number];

const QUEUE_BADGE: Record<string, string> = {
  active: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  deferred: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  hold: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
};

const ACTION_LABELS: Record<PostfixQueueAction, string> = {
  hold: 'Hold',
  release: 'Release',
  requeue: 'Requeue',
  delete: 'Delete',
};

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError || err instanceof Error ? err.message : fallback;
}

/**
 * Postfix queue browser: `postqueue -j` listing plus per-message view
 * (`postcat`) and hold/release/requeue/delete/deliver actions, all run by the
 * service's robin-agent.
 */
export function PostfixQueuePanel({ serviceId }: { serviceId: string }) {
  const confirm = useConfirm();
  const [messages, setMessages] = useState<PostfixQueueMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [viewing, setViewing] = useState<{ queueId: string; content: string | null } | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const response = await postfixApi.getQueue(serviceId);
      const list = response.data ?? [];
      setMessages(list);
      setSelected((prev) => new Set(list.filter((m) => prev.has(m.queueId)).map((m) => m.queueId)));
    } catch (err) {
      setError(errorMessage(err, 'Failed to list the Postfix queue'));
    } finally {
      setIsLoading(false);
    }
  }, [serviceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return messages.filter((m) => (
      (filter === 'all' || m.queueName === filter || (filter === 'incoming' && m.queueName === 'maildrop'))
      && (!needle
        || m.queueId.toLowerCase().includes(needle)
        || m.sender.toLowerCase().includes(needle)
        || m.recipients.some((r) => r.address.toLowerCase().includes(needle)))
    ));
  }, [messages, filter, search]);

  const run = async (label: string, work: () => Promise<{ data?: { response: string } }>) => {
    setRunning(true);
    setError('');
    setSuccess('');
    try {
      const response = await work();
      setSuccess(response.data?.response || `${label} done`);
      await load();
    } catch (err) {
      setError(errorMessage(err, `${label} failed`));
    } finally {
      setRunning(false);
    }
  };

  const applyAction = async (action: PostfixQueueAction, queueIds: string[]) => {
    if (queueIds.length === 0) return;
    if (action === 'delete' && !(await confirm(`Delete ${queueIds.length} queued message${queueIds.length === 1 ? '' : 's'}? This cannot be undone.`))) {
      return;
    }
    await run(ACTION_LABELS[action], () => postfixApi.queueAction(serviceId, action, queueIds));
    setSelected(new Set());
  };

  const view = async (queueId: string) => {
    setViewing({ queueId, content: null });
    try {
      const response = await postfixApi.getQueuedMessage(serviceId, queueId);
      setViewing({ queueId, content: response.data?.content ?? '' });
    } catch (err) {
      setViewing({ queueId, content: `# ${errorMessage(err, 'Failed to read the message')}` });
    }
  };

  const toggle = (queueId: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(queueId)) next.delete(queueId);
    else next.add(queueId);
    return next;
  });

  const allVisibleSelected = visible.length > 0 && visible.every((m) => selected.has(m.queueId));
  const counts = useMemo(() => {
    const byQueue: Record<string, number> = {};
    // The Incoming tab covers maildrop too (where requeued messages wait).
    for (const m of messages) {
      const tab = m.queueName === 'maildrop' ? 'incoming' : m.queueName;
      byQueue[tab] = (byQueue[tab] ?? 0) + 1;
    }
    return byQueue;
  }, [messages]);

  const columns = [
    {
      key: 'select',
      header: (
        <input
          type="checkbox"
          aria-label="Select all visible messages"
          checked={allVisibleSelected}
          onChange={() => setSelected(allVisibleSelected ? new Set() : new Set(visible.map((m) => m.queueId)))}
          className="h-4 w-4 accent-robin-orange"
        />
      ),
      className: 'w-10',
      render: (m: PostfixQueueMessage) => (
        <input
          type="checkbox"
          aria-label={`Select ${m.queueId}`}
          checked={selected.has(m.queueId)}
          onChange={() => toggle(m.queueId)}
          className="h-4 w-4 accent-robin-orange"
        />
      ),
    },
    { key: 'queueId', header: 'Queue ID', className: 'font-mono text-xs' },
    {
      key: 'queueName',
      header: 'Queue',
      render: (m: PostfixQueueMessage) => (
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${QUEUE_BADGE[m.queueName] ?? 'bg-gray-100 text-gray-700 dark:bg-robin-gray-800 dark:text-gray-300'}`}>
          {m.queueName}
        </span>
      ),
    },
    {
      key: 'arrivalTime',
      header: 'Arrived',
      className: 'whitespace-nowrap text-xs',
      render: (m: PostfixQueueMessage) => (m.arrivalTime ? new Date(m.arrivalTime).toLocaleString() : '—'),
    },
    { key: 'size', header: 'Size', className: 'text-xs', render: (m: PostfixQueueMessage) => formatBytes(m.size) },
    { key: 'sender', header: 'Sender', className: 'max-w-56 truncate text-xs', render: (m: PostfixQueueMessage) => m.sender || '<>' },
    {
      key: 'recipients',
      header: 'Recipients',
      className: 'max-w-md text-xs',
      render: (m: PostfixQueueMessage) => (
        <div className="space-y-0.5">
          {m.recipients.slice(0, 3).map((r) => (
            <div key={r.address} className="truncate" title={r.delayReason ?? undefined}>
              {r.address}
              {r.delayReason && <span className="block truncate text-red-600 dark:text-red-400">{r.delayReason}</span>}
            </div>
          ))}
          {m.recipients.length > 3 && <div className="text-gray-500">+{m.recipients.length - 3} more</div>}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      className: 'w-40',
      render: (m: PostfixQueueMessage) => (
        <div className="flex gap-1">
          <button type="button" onClick={() => void view(m.queueId)} className="rounded-sm p-1.5 hover:bg-gray-100 dark:hover:bg-robin-gray-800" title="View message">
            <Eye className="h-4 w-4" />
          </button>
          {m.queueName !== 'hold' && (
            <button type="button" disabled={running} onClick={() => void run('Deliver', () => postfixApi.deliverMessage(serviceId, m.queueId))} className="rounded-sm p-1.5 text-green-600 hover:bg-green-100 dark:hover:bg-green-900/20" title="Deliver now">
              <Send className="h-4 w-4" />
            </button>
          )}
          {m.queueName === 'hold' ? (
            <button type="button" disabled={running} onClick={() => void applyAction('release', [m.queueId])} className="rounded-sm p-1.5 text-blue-600 hover:bg-blue-100 dark:hover:bg-blue-900/20" title="Release from hold">
              <Play className="h-4 w-4" />
            </button>
          ) : (
            <button type="button" disabled={running} onClick={() => void applyAction('hold', [m.queueId])} className="rounded-sm p-1.5 text-purple-600 hover:bg-purple-100 dark:hover:bg-purple-900/20" title="Put on hold">
              <Pause className="h-4 w-4" />
            </button>
          )}
          <button type="button" disabled={running} onClick={() => void applyAction('delete', [m.queueId])} className="rounded-sm p-1.5 text-red-600 hover:bg-red-100 dark:hover:bg-red-900/20" title="Delete">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ),
    },
  ];

  const selectedIds = Array.from(selected);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Queue ID, sender, or recipient" />
        <SegmentedFilter
          ariaLabel="Queue"
          options={QUEUE_FILTERS.map((value) => ({
            value,
            label: value.charAt(0).toUpperCase() + value.slice(1),
            count: value === 'all' ? undefined : counts[value],
          }))}
          value={filter}
          onChange={setFilter}
        />
        <Button variant="secondary" onClick={() => void load()} disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <BulkActionBar count={selectedIds.length}>
        <Button size="sm" variant="secondary" disabled={running} onClick={() => void applyAction('hold', selectedIds)}>
          <Pause className="h-4 w-4" /> Hold
        </Button>
        <Button size="sm" variant="secondary" disabled={running} onClick={() => void applyAction('release', selectedIds)}>
          <Play className="h-4 w-4" /> Release
        </Button>
        <Button size="sm" variant="secondary" disabled={running} onClick={() => void applyAction('requeue', selectedIds)}>
          <RotateCcw className="h-4 w-4" /> Requeue
        </Button>
        <Button size="sm" variant="danger" disabled={running} onClick={() => void applyAction('delete', selectedIds)}>
          <Trash2 className="h-4 w-4" /> Delete
        </Button>
      </BulkActionBar>

      {error && <div className="rounded-sm border border-red-200 bg-red-50 p-3 text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">{error}</div>}
      {success && <div className="rounded-sm border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300">{success}</div>}

      <div className="card">
        <Table
          columns={columns}
          data={visible}
          keyField="queueId"
          isLoading={isLoading}
          emptyMessage={messages.length === 0 ? 'The Postfix queue is empty' : 'No queued messages match the filter'}
        />
      </div>

      <Modal isOpen={viewing !== null} onClose={() => setViewing(null)} title={`Queued message ${viewing?.queueId ?? ''}`} size="xl">
        {viewing?.content === null ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-all rounded-sm bg-gray-50 p-4 text-xs dark:bg-robin-gray-900">{viewing?.content}</pre>
        )}
      </Modal>
    </div>
  );
}
