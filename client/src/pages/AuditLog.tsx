/**
 * Audit log viewer page.
 */

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Eye } from 'lucide-react';
import { auditApi } from '../api/client';
import { Table } from '../components/ui/Table';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { AdminNotice, SettingsCard, StatusBadge } from '../components/administration/AdminPrimitives';
import { appIcons } from '../constants/appIcons';
import type { AuditLogEntry } from '../types';

const ACTION_FILTERS = [
  { value: '', label: 'All actions' },
  { value: 'admin.login', label: 'Admin login' },
  { value: 'admin.logout', label: 'Admin logout' },
  { value: 'admin.login_failed', label: 'Login failed' },
  { value: 'admin.login_locked', label: 'Login locked' },
  { value: 'admin.create', label: 'Administrator created' },
  { value: 'admin.update', label: 'Administrator updated' },
  { value: 'admin.delete', label: 'Administrator deleted' },
  { value: 'api_key.create', label: 'API Key Created' },
  { value: 'api_key.revoke', label: 'API Key Revoked' },
  { value: 'api_key.delete', label: 'API Key Deleted' },
  { value: 'ip_jail.create', label: 'IP Jail Created' },
  { value: 'ip_jail.update', label: 'IP Jail Updated' },
  { value: 'ip_jail.lift', label: 'IP Jail Lifted' },
  { value: 'config.update', label: 'Administration settings updated' },
];

function actionGroup(action: string): string {
  if (action.includes('login_locked') || action.includes('login_failed')) return 'security';
  if (action.includes('login')) return 'login';
  if (action.includes('logout')) return 'logout';
  if (action.endsWith('.create')) return 'create';
  if (action.endsWith('.update')) return 'update';
  if (action.endsWith('.delete') || action.endsWith('.revoke')) return 'delete';
  if (action.startsWith('api_key.')) return 'access';
  return 'update';
}

function actionTone(action: string): 'neutral' | 'success' | 'warning' | 'error' | 'info' {
  const group = actionGroup(action);
  if (group === 'create') return 'success';
  if (group === 'delete' || group === 'security') return 'error';
  if (group === 'login') return 'warning';
  if (group === 'access') return 'info';
  return 'neutral';
}

function actionLabel(action: string): string {
  return action
    .split('.')
    .map((part) => part.replace(/_/g, ' '))
    .join(' / ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

export function AuditLogPage({ embedded = false }: { embedded?: boolean }) {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [entityFilter, setEntityFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');

  // Detail modal
  const [selectedEntry, setSelectedEntry] = useState<AuditLogEntry | null>(null);

  const fetchLogs = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await auditApi.list(page, 50, {
        entityType: entityFilter || undefined,
        action: actionFilter || undefined,
      });
      setEntries(response.data ?? []);
      setTotalPages(response.pagination?.totalPages ?? 1);
      setTotal(response.pagination?.total ?? 0);
    } catch (err) {
      setError('Failed to load audit log');
    } finally {
      setIsLoading(false);
    }
  }, [page, entityFilter, actionFilter]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString();
  };

  const columns = [
    {
      key: 'createdAt',
      header: 'Time',
      render: (entry: AuditLogEntry) => (
        <span className="text-sm">{formatDate(entry.createdAt)}</span>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      render: (entry: AuditLogEntry) => (
        <StatusBadge tone={actionTone(entry.action)}>{actionLabel(entry.action)}</StatusBadge>
      ),
    },
    { key: 'entityType', header: 'Entity' },
    { key: 'entityId', header: 'Entity ID' },
    {
      key: 'adminId',
      header: 'Admin',
      render: (entry: AuditLogEntry) => entry.adminEmail || `ID: ${entry.adminId}`,
    },
    {
      key: 'actions',
      header: '',
      className: 'w-12',
      render: (entry: AuditLogEntry) => (
        <button
          onClick={() => setSelectedEntry(entry)}
          className="p-1.5 hover:bg-gray-100 dark:hover:bg-robin-gray-700 rounded-sm"
          title="View details"
        >
          <Eye className="w-4 h-4" />
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {!embedded && (
        <PageHeader
          icon={appIcons.auditLog}
          title="Activity log"
          description="Review administrative actions, access events, and security changes."
          actions={
            <Button variant="secondary" onClick={fetchLogs}>
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
          }
        />
      )}
      {embedded && (
        <div className="flex justify-end">
          <Button variant="secondary" onClick={fetchLogs}>
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
        </div>
      )}

      {error && <AdminNotice tone="error">{error}</AdminNotice>}

      <SettingsCard
        title="Filters"
        description={`Showing ${entries.length.toLocaleString()} of ${total.toLocaleString()} activity entries on this page.`}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm font-medium">
            Entity
            <select
              value={entityFilter}
              onChange={(e) => {
                setEntityFilter(e.target.value);
                setPage(1);
              }}
              className="input mt-1 w-full"
            >
              <option value="">All entities</option>
              <option value="admin">Admin</option>
              <option value="user">User</option>
              <option value="alias">Alias</option>
              <option value="auto_alias">Auto alias</option>
              <option value="queue">Queue</option>
              <option value="api-key">API Key</option>
              <option value="ip-jail">IP Jail</option>
            </select>
          </label>

          <label className="block text-sm font-medium">
            Action
            <select
              value={actionFilter}
              onChange={(e) => {
                setActionFilter(e.target.value);
                setPage(1);
              }}
              className="input mt-1 w-full"
            >
              {ACTION_FILTERS.map((option) => (
                <option key={option.value || 'all'} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </SettingsCard>

      <div className="card overflow-hidden">
        <Table
          columns={columns}
          data={entries}
          keyField="id"
          isLoading={isLoading}
          emptyMessage="No audit log entries found"
          pagination={{
            page,
            totalPages,
            total,
            onPageChange: setPage,
          }}
        />
      </div>

      {/* Detail Modal */}
      <Modal
        isOpen={!!selectedEntry}
        onClose={() => setSelectedEntry(null)}
        title="Activity entry"
      >
        {selectedEntry && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-500 dark:text-gray-400">
                  Time
                </label>
                <p>{formatDate(selectedEntry.createdAt)}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-500 dark:text-gray-400">
                  Admin
                </label>
                <p>{selectedEntry.adminEmail || `ID: ${selectedEntry.adminId}`}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-500 dark:text-gray-400">
                  Action
                </label>
                <StatusBadge tone={actionTone(selectedEntry.action)}>{actionLabel(selectedEntry.action)}</StatusBadge>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-500 dark:text-gray-400">
                  Entity
                </label>
                <p>
                  {selectedEntry.entityType} / {selectedEntry.entityId}
                </p>
              </div>
            </div>

            {(selectedEntry.oldValues || selectedEntry.newValues) && (
              <div>
                <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                  Changes
                </label>
                <pre className="p-3 bg-gray-100 dark:bg-robin-gray-700 rounded-sm text-sm overflow-auto max-h-64">
                  {JSON.stringify({ old: selectedEntry.oldValues, new: selectedEntry.newValues }, null, 2)}
                </pre>
              </div>
            )}

            <div className="flex justify-end pt-4">
              <Button variant="secondary" onClick={() => setSelectedEntry(null)}>
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
