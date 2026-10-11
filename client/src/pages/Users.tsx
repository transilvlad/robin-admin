/**
 * Users management page.
 */

import { useState, useEffect, useCallback } from 'react';
import { Plus, Edit, Trash2, Search } from 'lucide-react';
import { usersApi, ApiError } from '../api/client';
import { Table } from '../components/ui/Table';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { MailboxTabs } from '../components/layout/MailboxTabs';
import { appIcons } from '../constants/appIcons';
import { useCanEdit } from '../hooks/useAuth';
import { useConfirm } from '../context/ConfirmContext';
import type { MailUser } from '../types';

export function UsersPage() {
  const canEdit = useCanEdit();
  const confirm = useConfirm();
  const [users, setUsers] = useState<MailUser[]>([]);
  const [optionalColumns, setOptionalColumns] = useState<string[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');

  // Modal states
  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState<MailUser | null>(null);
  const [formEmail, setFormEmail] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formUid, setFormUid] = useState('5000');
  const [formGid, setFormGid] = useState('5000');
  const [formError, setFormError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const fetchUsers = useCallback(async () => {
    setIsLoading(true);
    try {
      const [schema, response] = await Promise.all([usersApi.schema(), usersApi.list(page, 50, search || undefined)]);
      if (!schema.data) throw new Error('Mailbox schema unavailable');
      setOptionalColumns(schema.data.knownOptional);
      setError('');
      setUsers(response.data ?? []);
      setTotalPages(response.pagination?.totalPages ?? 1);
      setTotal(response.pagination?.total ?? 0);
    } catch (err) {
      setOptionalColumns(null);
      setError(err instanceof ApiError ? err.message : 'Failed to load users');
    } finally {
      setIsLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput);
    setPage(1);
  };

  const openCreateModal = () => {
    setEditingUser(null);
    setFormEmail('');
    setFormPassword('');
    setFormUid('5000');
    setFormGid('5000');
    setFormError('');
    setShowModal(true);
  };

  const openEditModal = (user: MailUser) => {
    setEditingUser(user);
    setFormEmail(user.email);
    setFormPassword('');
    setFormUid(String(user.uid));
    setFormGid(String(user.gid));
    setFormError('');
    setShowModal(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setIsSaving(true);

    try {
      if (editingUser) {
        await usersApi.update(editingUser.id, {
          email: formEmail !== editingUser.email ? formEmail : undefined,
          password: formPassword || undefined,
          uid: optionalColumns?.includes('uid') ? Number(formUid) : undefined,
          gid: optionalColumns?.includes('gid') ? Number(formGid) : undefined,
        });
      } else {
        await usersApi.create(formEmail, formPassword, optionalColumns?.includes('uid') ? Number(formUid) : undefined, optionalColumns?.includes('gid') ? Number(formGid) : undefined);
      }
      setShowModal(false);
      fetchUsers();
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

  const handleDelete = async (user: MailUser) => {
    if (!(await confirm(`Delete user ${user.email}?`))) return;

    try {
      await usersApi.delete(user.id);
      fetchUsers();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to delete user');
    }
  };

  const columns = [
    { key: 'email', header: 'Email' },
    ...(optionalColumns?.includes('uid') ? [{ key: 'uid', header: 'UID' }] : []),
    ...(optionalColumns?.includes('gid') ? [{ key: 'gid', header: 'GID' }] : []),
    {
      key: 'actions',
      header: 'Actions',
      className: 'w-24',
      render: (user: MailUser) =>
        canEdit ? (
          <div className="flex gap-1">
            <button
              onClick={() => openEditModal(user)}
              className="p-1.5 hover:bg-gray-100 dark:hover:bg-robin-gray-700 rounded-sm"
              title="Edit"
            >
              <Edit className="w-4 h-4" />
            </button>
            <button
              onClick={() => handleDelete(user)}
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
    <div>
      <div className="mb-6">
        <PageHeader
          icon={appIcons.users}
          title="Mail users"
          description="Manage mailbox accounts, their UID/GID, and passwords."
          actions={canEdit && optionalColumns !== null && (
            <Button onClick={openCreateModal}>
              <Plus className="w-4 h-4 mr-2" />
              Add user
            </Button>
          )}
        />
      </div>

      <MailboxTabs />

      {/* Search */}
      <form onSubmit={handleSearch} className="mb-4 flex gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by email..."
            className="input pl-10"
          />
        </div>
        <Button type="submit" variant="secondary">Search</Button>
      </form>

      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {!error && <div className="card">
        <Table
          columns={columns}
          data={users}
          keyField="id"
          isLoading={isLoading}
          emptyMessage="No users found"
          pagination={{
            page,
            totalPages,
            total,
            onPageChange: setPage,
          }}
        />
      </div>}
      {/* Create/Edit Modal */}
      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={editingUser ? 'Edit user' : 'Create user'}
      >
        <form onSubmit={handleSave} className="space-y-4">
          {formError && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-red-600 dark:text-red-400 text-sm">
              {formError}
            </div>
          )}

          <Input
            label="Email"
            type="email"
            value={formEmail}
            onChange={(e) => setFormEmail(e.target.value)}
            required
          />

          <Input
            label={editingUser ? 'New Password (leave blank to keep)' : 'Password'}
            type="password"
            value={formPassword}
            onChange={(e) => setFormPassword(e.target.value)}
            required={!editingUser}
          />

          <div className="grid grid-cols-2 gap-4">
            {optionalColumns?.includes('uid') && <Input
              label="UID"
              type="number"
              min={0}
              max={2147483647}
              value={formUid}
              onChange={(e) => setFormUid(e.target.value)}
              required
            />}
            {optionalColumns?.includes('gid') && <Input
              label="GID"
              type="number"
              min={0}
              max={2147483647}
              value={formGid}
              onChange={(e) => setFormGid(e.target.value)}
              required
            />}
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button type="button" variant="secondary" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button type="submit" isLoading={isSaving}>
              {editingUser ? 'Save changes' : 'Create user'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
