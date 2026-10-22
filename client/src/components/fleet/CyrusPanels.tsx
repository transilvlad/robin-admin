import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { ApiError, cyrusApi } from '../../api/client';
import { formatBytes } from '../../utils/format';
import type { CyrusQuotaResult, CyrusSession, CyrusUserLookup } from '../../types';
import { Button } from '../ui/Button';
import { Table } from '../ui/Table';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError || err instanceof Error ? err.message : fallback;
}

function Notice({ tone, children }: { tone: 'error' | 'info'; children: string }) {
  const styles = {
    error: 'border-red-200 bg-red-50 text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400',
    info: 'border-gray-200 bg-gray-50 text-gray-600 dark:border-robin-gray-700 dark:bg-robin-gray-800 dark:text-gray-300',
  };
  return <div className={`rounded-sm border p-3 text-sm ${styles[tone]}`}>{children}</div>;
}

export function CyrusSessionsPanel({ serviceId }: { serviceId: string }) {
  const [sessions, setSessions] = useState<CyrusSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      setSessions((await cyrusApi.getSessions(serviceId)).data ?? []);
    } catch (err) {
      setError(errorMessage(err, 'Failed to list Cyrus sessions'));
    } finally {
      setIsLoading(false);
    }
  }, [serviceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return sessions
      .filter((s) => !needle || s.user.toLowerCase().includes(needle) || s.ip.includes(needle))
      .map((s) => ({ ...s, key: `${s.user}:${s.service}:${s.pid}:${s.ip}` }));
  }, [sessions, search]);

  const users = new Set(sessions.map((s) => s.user).filter(Boolean)).size;
  const columns = [
    { key: 'user', header: 'User', className: 'text-sm' },
    { key: 'service', header: 'Service', className: 'text-xs uppercase' },
    { key: 'ip', header: 'Client IP', className: 'font-mono text-xs' },
    { key: 'host', header: 'Client host', className: 'font-mono text-xs' },
    { key: 'pid', header: 'PID', className: 'font-mono text-xs' },
    { key: 'mailbox', header: 'Mailbox' },
    { key: 'state', header: 'State' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="User or client IP" className="input w-72 pl-10" />
        </div>
        <Button variant="secondary" onClick={() => void load()} disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {sessions.length} connection{sessions.length === 1 ? '' : 's'} · {users} user{users === 1 ? '' : 's'}
        </span>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="card">
        <Table columns={columns} data={visible} keyField="key" isLoading={isLoading} emptyMessage="No active Cyrus sessions" />
      </div>
    </div>
  );
}

function QuotaTable({ quota, showUser }: { quota: CyrusQuotaResult; showUser: boolean }) {
  if (!quota.available) return <Notice tone="info">{quota.reason ?? 'Quota information is unavailable.'}</Notice>;
  if (!quota.rows.length) return <Notice tone="info">No quota is configured.</Notice>;
  return <div className="overflow-x-auto"><table className="min-w-full text-sm">
    <thead><tr className="text-left text-xs text-gray-500 dark:text-gray-400">
      {showUser && <th className="px-3 py-2">User</th>}<th className="px-3 py-2">Root</th><th className="px-3 py-2">Storage used</th><th className="px-3 py-2">Storage limit</th><th className="px-3 py-2">Used %</th><th className="px-3 py-2">Messages</th><th className="px-3 py-2">Folders</th>
    </tr></thead><tbody className="divide-y divide-gray-100 dark:divide-robin-gray-800">
      {quota.rows.map((row) => <tr key={row.root}>
        {showUser && <td className="px-3 py-2">{row.user}</td>}<td className="px-3 py-2">{row.root}</td>
        <td className="px-3 py-2">{formatBytes(row.storageUsedKiB * 1024)}</td>
        <td className="px-3 py-2">{row.storageLimitKiB === null ? 'Unlimited' : formatBytes(row.storageLimitKiB * 1024)}</td>
        <td className="px-3 py-2">{row.storagePercent === null ? '—' : row.storagePercent + '%'}</td>
        <td className="px-3 py-2">{row.messages.toLocaleString()}</td><td className="px-3 py-2">{row.folders.toLocaleString()}</td>
      </tr>)}
    </tbody></table></div>;
}

export function CyrusQuotaPanel({ serviceId, canLookup = true }: { serviceId: string; canLookup?: boolean }) {
  const [user, setUser] = useState('');
  const [lookup, setLookup] = useState<CyrusUserLookup | null>(null);
  const [allQuota, setAllQuota] = useState<CyrusQuotaResult | null>(null);
  const [busy, setBusy] = useState<'lookup' | 'quota' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setLookup(null);
    setAllQuota(null);
    setError('');
  }, [serviceId]);

  const runLookup = async (event: FormEvent) => {
    event.preventDefault();
    if (!user.trim()) return;
    setBusy('lookup');
    setError('');
    try {
      setLookup((await cyrusApi.lookupUser(serviceId, user.trim())).data ?? null);
    } catch (err) {
      setError(errorMessage(err, 'Failed to look up the user'));
    } finally {
      setBusy(null);
    }
  };

  const loadAllQuota = async () => {
    setBusy('quota');
    setError('');
    try {
      setAllQuota((await cyrusApi.getQuota(serviceId)).data ?? null);
    } catch (err) {
      setError(errorMessage(err, 'Failed to read quota'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      {error && <Notice tone="error">{error}</Notice>}
      {canLookup && <div className="card p-4">
        <h2 className="text-lg font-semibold">Look up a mailbox</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Looks up the Cyrus mailbox path and quota usage.</p>
        <form onSubmit={runLookup} className="mt-4 flex flex-wrap gap-2">
          <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="user@example.com" className="input w-80" />
          <Button type="submit" variant="secondary" isLoading={busy === 'lookup'} disabled={busy !== null || !user.trim()}>
            <Search className="h-4 w-4" /> Look up
          </Button>
        </form>
        {lookup && (
          <div className="mt-4 space-y-4">
            {!lookup.exists ? (
              <Notice tone="info">{`${lookup.user} does not exist.`}</Notice>
            ) : (
              <>
                <div className="grid gap-2 md:grid-cols-2">
                  {Object.entries(lookup.fields).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between gap-4 rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-robin-gray-800">
                      <span className="text-gray-500 dark:text-gray-400">{key}</span>
                      <span className="truncate font-mono text-xs" title={value}>{value}</span>
                    </div>
                  ))}
                </div>
                {lookup.quota && <QuotaTable quota={lookup.quota} showUser={false} />}
              </>
            )}
          </div>
        )}
      </div>}

      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Quota across all users</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Reads quota roots and resource usage from Cyrus.</p>
          </div>
          <Button variant="secondary" onClick={() => void loadAllQuota()} isLoading={busy === 'quota'} disabled={busy !== null}>
            <RefreshCw className="h-4 w-4" /> {allQuota ? 'Reload' : 'Load quota'}
          </Button>
        </div>
        {allQuota && <div className="mt-4"><QuotaTable quota={allQuota} showUser /></div>}
      </div>
    </div>
  );
}
