/**
 * Admins management page - restricted to admin role only.
 */

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, Bell, Plus, Edit, Trash2, Shield, Eye, Pencil, KeyRound, ShieldOff, X, Users } from 'lucide-react';
import { adminsApi, apiKeysApi, ApiError, type ApiKey } from '../api/client';
import { AdminNotice, SettingsCard, StatusBadge } from '../components/administration/AdminPrimitives';
import { Table } from '../components/ui/Table';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { MetricTabs, type MetricTab } from '../components/ui/MetricTabs';
import { PageHeader } from '../components/ui/PageHeader';
import { appIcons } from '../constants/appIcons';
import { useAuth } from '../hooks/useAuth';
import { useConfirm } from '../context/ConfirmContext';
import { AdminNotificationsPage } from './AdminNotifications';
import { AuditLogPage } from './AuditLog';
import type { Admin, AdminRole } from '../types';

const ROLE_LABELS: Record<AdminRole, string> = {
  viewer: 'Viewer (Read-only)',
  editor: 'Editor',
  admin: 'Full admin',
};

const ROLE_ICONS: Record<AdminRole, typeof Shield> = {
  viewer: Eye,
  editor: Pencil,
  admin: Shield,
};

type AccessTab = 'admins' | 'notifications' | 'apiKeys' | 'activity';

const ACCESS_TABS: readonly MetricTab<AccessTab>[] = [
  { id: 'admins', label: 'Administrators', icon: Users },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'apiKeys', label: 'API Keys', icon: KeyRound },
  { id: 'activity', label: 'Activity log', icon: Activity },
];

function initialAccessTab(queryTab: string | null): AccessTab {
  if (ACCESS_TABS.some(tab => tab.id === queryTab)) return queryTab as AccessTab;
  const saved = localStorage.getItem('robin-admin.access.tab');
  return ACCESS_TABS.some((tab) => tab.id === saved) ? saved as AccessTab : 'admins';
}

export function AdminsPage() {
  const [searchParams] = useSearchParams();
  const confirm = useConfirm();
  const { user } = useAuth();
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [activeTab, setActiveTab] = useState<AccessTab>(() => initialAccessTab(searchParams.get('tab')));

  // Modal states
  const [showModal, setShowModal] = useState(false);
  const [editingAdmin, setEditingAdmin] = useState<Admin | null>(null);
  const [formName, setFormName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formRole, setFormRole] = useState<AdminRole>('viewer');
  const [formAllowedCidrs, setFormAllowedCidrs] = useState('');
  const [formDisabled, setFormDisabled] = useState(false);
  const [formError, setFormError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [newApiKey, setNewApiKey] = useState({
    name: '',
    role: 'viewer' as AdminRole,
    scopes: ['reports:read'],
    allowedCidrs: '',
    expiresAt: '',
  });
  const [createdApiKey, setCreatedApiKey] = useState('');
  useEffect(() => {
    const queryTab = searchParams.get('tab');
    if (ACCESS_TABS.some(tab => tab.id === queryTab)) setActiveTab(queryTab as AccessTab);
    if (searchParams.get('preset') === 'telemetry') {
      setNewApiKey(current => ({ ...current, role: 'viewer', scopes: ['telemetry:write'] }));
    }
  }, [searchParams]);

  const fetchAdmins = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await adminsApi.list(page, 50);
      setAdmins(response.data ?? []);
      setTotalPages(response.pagination?.totalPages ?? 1);
      setTotal(response.pagination?.total ?? 0);
    } catch (err) {
      setError('Failed to load admins');
    } finally {
      setIsLoading(false);
    }
  }, [page]);

  const fetchApiKeys = useCallback(async () => {
    try {
      const response = await apiKeysApi.list();
      setApiKeys(response.data ?? []);
    } catch {
      setError('Failed to load API keys');
    }
  }, []);

  useEffect(() => {
    fetchAdmins();
    fetchApiKeys();
  }, [fetchAdmins, fetchApiKeys]);

  useEffect(() => {
    localStorage.setItem('robin-admin.access.tab', activeTab);
  }, [activeTab]);

  const openCreateModal = () => {
    setEditingAdmin(null);
    setFormName('');
    setFormEmail('');
    setFormPassword('');
    setFormRole('viewer');
    setFormAllowedCidrs('');
    setFormDisabled(false);
    setFormError('');
    setShowModal(true);
  };

  const openEditModal = (admin: Admin) => {
    setEditingAdmin(admin);
    setFormName(admin.name);
    setFormEmail(admin.email);
    setFormPassword('');
    setFormRole(admin.role);
    setFormAllowedCidrs(admin.allowedCidrs.join('\n'));
    setFormDisabled(admin.disabled);
    setFormError('');
    setShowModal(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setIsSaving(true);

    try {
      if (editingAdmin) {
        await adminsApi.update(editingAdmin.id, {
          name: formName,
          email: formEmail,
          password: formPassword || undefined,
          role: formRole,
          allowedCidrs: formAllowedCidrs,
          disabled: formDisabled,
        });
      } else {
        if (!formPassword) {
          setFormError('Password is required');
          setIsSaving(false);
          return;
        }
        await adminsApi.create({
          name: formName,
          email: formEmail,
          password: formPassword,
          role: formRole,
          allowedCidrs: formAllowedCidrs,
          disabled: formDisabled,
        });
      }
      setShowModal(false);
      fetchAdmins();
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(err.message);
      } else {
        setFormError('An unexpected error occurred');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (admin: Admin) => {
    if (admin.id === user?.id) {
      alert('You cannot delete yourself');
      return;
    }
    if (!(await confirm(`Delete admin ${admin.name} <${admin.email}>?`))) return;

    try {
      await adminsApi.delete(admin.id);
      fetchAdmins();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to delete admin');
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString();
  };

  const toggleScope = (scope: string) => {
    const scopes = new Set(newApiKey.scopes);
    if (scopes.has(scope)) scopes.delete(scope);
    else scopes.add(scope);
    setNewApiKey({ ...newApiKey, scopes: [...scopes] });
  };

  const handleCreateApiKey = async () => {
    try {
      const response = await apiKeysApi.create({
        ...newApiKey,
        expiresAt: newApiKey.expiresAt || undefined,
      });
      setCreatedApiKey(response.data?.plainText ?? '');
      setNewApiKey({
        name: '',
        role: 'viewer',
        scopes: searchParams.get('preset') === 'telemetry' ? ['telemetry:write'] : ['reports:read'],
        allowedCidrs: '',
        expiresAt: '',
      });
      await fetchApiKeys();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create API key');
    }
  };

  const handleRevokeApiKey = async (id: number) => {
    if (!(await confirm('Revoke this API key?'))) return;
    try {
      await apiKeysApi.revoke(id);
      await fetchApiKeys();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to revoke API key');
    }
  };

  const API_KEY_SCOPES = [
    'users:read', 'users:write', 'aliases:read', 'aliases:write', 'queue:read', 'queue:write',
    'mail:send', 'fleet:read', 'fleet:write', 'metrics:read', 'reporting:read',
    'reporting:write', 'reports:read', 'reports:ingest', 'telemetry:read', 'telemetry:write', 'telemetry:manage', 'audit:read', 'admin:*',
  ];

  const columns = [
    { key: 'name', header: 'Name' },
    { key: 'email', header: 'Email' },
    {
      key: 'role',
      header: 'Role',
      render: (admin: Admin) => {
        const Icon = ROLE_ICONS[admin.role];
        return (
          <span className="flex items-center gap-1.5">
            <Icon className="w-4 h-4" />
            {ROLE_LABELS[admin.role]}
          </span>
        );
      },
    },
    {
      key: 'disabled',
      header: 'Status',
      render: (admin: Admin) => (
        <StatusBadge tone={admin.disabled ? 'warning' : 'success'}>{admin.disabled ? 'Disabled' : 'Enabled'}</StatusBadge>
      ),
    },
    {
      key: 'allowedCidrs',
      header: 'CIDR Restrictions',
      render: (admin: Admin) => (
        admin.allowedCidrs.length > 0
          ? <span className="text-sm text-gray-700 dark:text-gray-300">{admin.allowedCidrs.join(', ')}</span>
          : <span className="text-sm text-gray-500 dark:text-gray-400">No extra restrictions</span>
      ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      render: (admin: Admin) => formatDate(admin.createdAt),
    },
    {
      key: 'lastLogin',
      header: 'Last login',
      render: (admin: Admin) =>
        admin.lastLogin ? formatDate(admin.lastLogin) : 'Never',
    },
    {
      key: 'actions',
      header: 'Actions',
      className: 'w-24',
      render: (admin: Admin) => (
        <div className="flex gap-1">
          <button
            onClick={() => openEditModal(admin)}
            className="p-1.5 hover:bg-gray-100 dark:hover:bg-robin-gray-700 rounded-sm"
            title="Edit"
          >
            <Edit className="w-4 h-4" />
          </button>
          <button
            onClick={() => handleDelete(admin)}
            disabled={admin.id === user?.id}
            className="p-1.5 hover:bg-red-100 dark:hover:bg-red-900/20 rounded-sm text-red-600 disabled:opacity-50 disabled:cursor-not-allowed"
            title={admin.id === user?.id ? 'Cannot delete yourself' : 'Delete'}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.access}
        title="Access & Audit"
        description="Manage operators, notification opt-ins, automation credentials, and administrative history."
        actions={activeTab === 'admins' ? (
          <Button onClick={openCreateModal}>
            <Plus className="w-4 h-4 mr-2" />
            Add administrator
          </Button>
        ) : undefined}
      />

      {error && <AdminNotice tone="error">{error}</AdminNotice>}

      <MetricTabs tabs={ACCESS_TABS} activeTab={activeTab} onChange={setActiveTab} />

      {activeTab === 'admins' && (
        <div className="card overflow-hidden">
          <Table
            columns={columns}
            data={admins}
            keyField="id"
            isLoading={isLoading}
            emptyMessage="No admins found"
            pagination={{
              page,
              totalPages,
              total,
              onPageChange: setPage,
            }}
          />
        </div>
      )}

      {activeTab === 'notifications' && <AdminNotificationsPage embedded />}

      {activeTab === 'apiKeys' && (
        <SettingsCard title="API Keys" description="Manage automation access for scripts and integrations." icon={KeyRound}>
          {createdApiKey && (
            <AdminNotice tone="success">
              <div className="font-medium">New API key. This is shown once.</div>
              <code className="mt-2 block break-all">{createdApiKey}</code>
              <Button variant="secondary" className="mt-3" onClick={() => setCreatedApiKey('')}>
                <X className="w-4 h-4" />
                Hide
              </Button>
            </AdminNotice>
          )}
          <div className="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
            <Input label="Key name" value={newApiKey.name} onChange={(e) => setNewApiKey({ ...newApiKey, name: e.target.value })} placeholder="Metrics exporter" />
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium mb-1">Role ceiling</label>
                <select className="input w-full" value={newApiKey.role} onChange={(e) => setNewApiKey({ ...newApiKey, role: e.target.value as AdminRole })}>
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <Input label="Expires at" type="date" value={newApiKey.expiresAt} onChange={(e) => setNewApiKey({ ...newApiKey, expiresAt: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Scopes</label>
              <div className="grid gap-2 sm:grid-cols-2">
                {API_KEY_SCOPES.map((scope) => (
                  <label key={scope} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={newApiKey.scopes.includes(scope)} onChange={() => toggleScope(scope)} className="h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange" />
                    {scope}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Key IP allowlist</label>
              <textarea className="input min-h-20 w-full" value={newApiKey.allowedCidrs} onChange={(e) => setNewApiKey({ ...newApiKey, allowedCidrs: e.target.value })} placeholder="198.51.100.10/32" />
            </div>
            <Button onClick={handleCreateApiKey}>
              <Plus className="w-4 h-4 mr-2" />
              Create key
            </Button>
          </div>
          <div className="space-y-3">
            {apiKeys.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">No API keys have been created.</p>
            ) : (
              apiKeys.map((key) => (
                <div key={key.id} className="rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium">{key.name}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                        <span>{key.keyPrefix}...</span>
                        <StatusBadge tone="info">{key.role}</StatusBadge>
                        <span>{key.scopes.join(', ')}</span>
                      </div>
                      <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">Last used {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'never'}{key.lastUsedIp ? ` from ${key.lastUsedIp}` : ''}</div>
                    </div>
                    {!key.revokedAt && <Button variant="danger" onClick={() => handleRevokeApiKey(key.id)}>Revoke</Button>}
                  </div>
                </div>
              ))
            )}
          </div>
        </SettingsCard>
      )}

      {activeTab === 'activity' && <AuditLogPage embedded />}

      {/* Create/Edit Modal */}
      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={editingAdmin ? 'Edit admin' : 'Create admin'}
      >
        <form onSubmit={handleSave} className="space-y-4">
          {formError && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-red-600 dark:text-red-400 text-sm">
              {formError}
            </div>
          )}

          <Input
            label="Name"
            type="text"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder="Robin Admin"
            required
          />

          <Input
            label="Email"
            type="email"
            value={formEmail}
            onChange={(e) => setFormEmail(e.target.value)}
            placeholder="admin@example.com"
            required
          />

          <Input
            label={editingAdmin ? 'Password (leave blank to keep current)' : 'Password'}
            type="password"
            value={formPassword}
            onChange={(e) => setFormPassword(e.target.value)}
            placeholder="••••••••"
            required={!editingAdmin}
          />

          <div>
            <label className="block text-sm font-medium mb-1">Role</label>
            <select
              value={formRole}
              onChange={(e) => setFormRole(e.target.value as AdminRole)}
              className="input w-full"
            >
              {Object.entries(ROLE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {formRole === 'viewer' && 'Can view all data but cannot make changes'}
              {formRole === 'editor' && 'Can manage users, aliases, and queue'}
              {formRole === 'admin' && 'Full access including admin management'}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Allowed CIDRs</label>
            <textarea
              className="input min-h-24 w-full"
              value={formAllowedCidrs}
              onChange={(e) => setFormAllowedCidrs(e.target.value)}
              placeholder={'203.0.113.0/24\n2001:db8::/32'}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Optional extra restriction for this administrator only. These CIDRs are checked in addition to the global IP allowlist.
            </p>
          </div>

          <label className="flex items-start gap-3 rounded-lg border border-gray-200 p-3 text-sm dark:border-robin-gray-700">
            <input
              type="checkbox"
              checked={formDisabled}
              onChange={(e) => setFormDisabled(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange"
            />
            <span>
              <span className="flex items-center gap-2 font-medium">
                <ShieldOff className="h-4 w-4" />
                Disabled
              </span>
              <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                Disabled admins cannot sign in or request password recovery.
              </span>
            </span>
          </label>

          <div className="flex justify-end gap-2 pt-4">
            <Button type="button" variant="secondary" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button type="submit" isLoading={isSaving}>
              {editingAdmin ? 'Save changes' : 'Create admin'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
