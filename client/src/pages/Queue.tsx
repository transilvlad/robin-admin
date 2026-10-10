/**
 * Queue management page.
 */

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Play, Trash2, RotateCcw } from 'lucide-react';
import { queueApi, ApiError } from '../api/client';
import { Table } from '../components/ui/Table';
import { Button } from '../components/ui/Button';
import { BulkActionBar } from '../components/ui/BulkActionBar';
import { SearchInput } from '../components/ui/SearchInput';
import { SegmentedFilter } from '../components/ui/SegmentedFilter';
import { PageHeader } from '../components/ui/PageHeader';
import { useCanEdit } from '../hooks/useAuth';
import { useServices } from '../context/ServiceContext';
import { PageServiceSelector } from '../components/fleet/PageServiceSelector';
import { getProtocolBadgeClass } from '../constants/protocols';
import { appIcons } from '../constants/appIcons';
import { useConfirm } from '../context/ConfirmContext';
import type { QueueItem } from '../types';

// State colors for queue items (Robin uses READY/CLAIMED/DEAD)
function getStateStyle(state: string): string {
  const s = state.toLowerCase();
  if (s === 'ready') return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400';
  if (s === 'claimed') return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400';
  if (s === 'dead') return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400';
  return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';
}

const STATE_FILTERS = [
  { value: '', label: 'All' },
  { value: 'READY', label: 'Ready' },
  { value: 'CLAIMED', label: 'Claimed' },
  { value: 'DEAD', label: 'Dead' },
] as const;
type StateFilter = typeof STATE_FILTERS[number]['value'];

// The search runs on the server, so wait for typing to pause before querying.
const SEARCH_DEBOUNCE_MS = 300;

export function QueuePage() {
  const confirm = useConfirm();
  const canEdit = useCanEdit();
  const { selectedRobinService } = useServices();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('');
  const [stateCounts, setStateCounts] = useState<Record<string, number>>({});
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [success, setSuccess] = useState('');

  const fetchQueue = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const [response, stats] = await Promise.all([
        queueApi.list(page, 50, {
          state: stateFilter || undefined,
          search: search || undefined,
        }),
        queueApi.getStats().catch(() => null),
      ]);
      setItems(response.data ?? []);
      setStateCounts(stats?.data?.byState ?? {});
      setTotalPages(response.pagination?.totalPages ?? 1);
      setTotal(response.pagination?.total ?? 0);
      setSelectedItems(new Set());
    } catch (err) {
      setError('Failed to load queue');
    } finally {
      setIsLoading(false);
    }
  }, [page, search, stateFilter]);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = searchInput.trim();
      setSearch((current) => {
        if (current !== next) setPage(1);
        return next;
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Runs a queue action, reports its outcome in the banners, and re-lists.
  const runAction = async (label: string, work: () => Promise<unknown>) => {
    setError('');
    setSuccess('');
    try {
      await work();
      setSuccess(`${label} requested`);
      await fetchQueue();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `${label} failed`);
    }
  };

  const toggleSelect = (uid: string) => {
    setSelectedItems((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) {
        next.delete(uid);
      } else {
        next.add(uid);
      }
      return next;
    });
  };

  const selectAll = () => {
    if (selectedItems.size === items.length) {
      setSelectedItems(new Set());
    } else {
      setSelectedItems(new Set(items.map((i) => i.queueUid)));
    }
  };

  const serviceId = selectedRobinService?.serviceId;
  const selectedUids = Array.from(selectedItems);
  const plural = (n: number) => `${n} item${n === 1 ? '' : 's'}`;

  const handleRetry = (uid: string) => runAction('Retry', () => queueApi.retry(uid, serviceId));

  const handleDelete = async (uid: string) => {
    if (!(await confirm('Delete this queue item?'))) return;
    await runAction('Delete', () => queueApi.delete(uid, serviceId));
  };

  const handleBounce = async (uid: string) => {
    if (!(await confirm('Bounce this queue item?'))) return;
    await runAction('Bounce', () => queueApi.bounce(uid, serviceId));
  };

  const handleBulkRetry = () => runAction(`Retry of ${plural(selectedUids.length)}`, () => queueApi.bulkRetry(selectedUids, serviceId));

  const handleBulkDelete = async () => {
    if (!(await confirm(`Delete ${plural(selectedUids.length)}?`))) return;
    await runAction(`Delete of ${plural(selectedUids.length)}`, () => queueApi.bulkDelete(selectedUids, serviceId));
  };

  const handleBulkBounce = async () => {
    if (!(await confirm(`Bounce ${plural(selectedUids.length)}?`))) return;
    await runAction(`Bounce of ${plural(selectedUids.length)}`, () => queueApi.bulkBounce(selectedUids, serviceId));
  };

  const formatDate = (epoch: number) => {
    return new Date(epoch).toLocaleString();
  };

  const columns = [
    {
      key: 'select',
      header: (
        <input
          type="checkbox"
          checked={selectedItems.size === items.length && items.length > 0}
          onChange={selectAll}
          className="h-4 w-4 accent-robin-orange"
        />
      ),
      className: 'w-10',
      render: (item: QueueItem) => (
        <input
          type="checkbox"
          checked={selectedItems.has(item.queueUid)}
          onChange={() => toggleSelect(item.queueUid)}
          className="h-4 w-4 accent-robin-orange"
        />
      ),
    },
    { key: 'queueUid', header: 'UID', className: 'font-mono text-xs' },
    { 
      key: 'state', 
      header: 'State',
      render: (item: QueueItem) => (
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getStateStyle(item.state)}`}>
          {item.state}
        </span>
      ),
    },
    { 
      key: 'protocol', 
      header: 'Protocol',
      render: (item: QueueItem) => (
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getProtocolBadgeClass(item.protocol || 'unknown')}`}>
          {item.protocol || '-'}
        </span>
      ),
    },
    { key: 'retryCount', header: 'Retries' },
    {
      key: 'createdEpoch',
      header: 'Created',
      render: (item: QueueItem) => formatDate(item.createdEpoch),
    },
    {
      key: 'lastError',
      header: 'Last error',
      className: 'max-w-xs truncate',
      render: (item: QueueItem) => (
        <span className="text-xs text-red-600 dark:text-red-400" title={item.lastError || ''}>
          {item.lastError?.substring(0, 50) || '-'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      className: 'w-32',
      render: (item: QueueItem) =>
        canEdit ? (
          <div className="flex gap-1">
            <button
              onClick={() => handleRetry(item.queueUid)}
              className="p-1.5 hover:bg-green-100 dark:hover:bg-green-900/20 rounded-sm text-green-600"
              title="Retry"
            >
              <Play className="w-4 h-4" />
            </button>
            <button
              onClick={() => handleBounce(item.queueUid)}
              className="p-1.5 hover:bg-yellow-100 dark:hover:bg-yellow-900/20 rounded-sm text-yellow-600"
              title="Bounce"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
            <button
              onClick={() => handleDelete(item.queueUid)}
              className="p-1.5 hover:bg-red-100 dark:hover:bg-red-900/20 rounded-sm text-red-600"
              title="Delete"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.queue}
        title="Robin queue"
        description="Inspect, search, retry, bounce, and delete messages currently queued for delivery."
        actions={<PageServiceSelector  capability="queue" />}
      />

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput value={searchInput} onChange={setSearchInput} placeholder="Queue or session ID" />
          <SegmentedFilter
            ariaLabel="Queue state"
            options={STATE_FILTERS.map((option) => ({
              ...option,
              count: option.value ? stateCounts[option.value] : undefined,
            }))}
            value={stateFilter}
            onChange={(value) => {
              setStateFilter(value);
              setPage(1);
            }}
          />
          <Button variant="secondary" onClick={() => void fetchQueue()} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {canEdit && (
          <BulkActionBar count={selectedUids.length}>
            <Button size="sm" variant="secondary" onClick={() => void handleBulkRetry()}>
              <Play className="h-4 w-4" /> Retry
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void handleBulkBounce()}>
              <RotateCcw className="h-4 w-4" /> Bounce
            </Button>
            <Button size="sm" variant="danger" onClick={() => void handleBulkDelete()}>
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          </BulkActionBar>
        )}

        {error && <div className="rounded-sm border border-red-200 bg-red-50 p-3 text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">{error}</div>}
        {success && <div className="rounded-sm border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300">{success}</div>}

        <div className="card">
          <Table
            columns={columns}
            data={items}
            keyField="queueUid"
            isLoading={isLoading}
            emptyMessage={search || stateFilter ? 'No queued messages match the filter' : 'The Robin queue is empty'}
            pagination={{
              page,
              totalPages,
              total,
              onPageChange: setPage,
            }}
          />
        </div>
      </div>
    </div>
  );
}
