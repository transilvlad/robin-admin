/**
 * Aliases management page.
 */

import { useState, useEffect, useCallback } from 'react';
import { Plus, Edit, Trash2, Search } from 'lucide-react';
import { aliasesApi, ApiError } from '../api/client';
import { Table } from '../components/ui/Table';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { MailboxTabs } from '../components/layout/MailboxTabs';
import { appIcons } from '../constants/appIcons';
import { useCanEdit } from '../hooks/useAuth';
import { useConfirm } from '../context/ConfirmContext';
import type { Alias } from '../types';

export function AliasesPage() {
  const confirm = useConfirm();
  const canEdit = useCanEdit();
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');

  // Modal states
  const [showModal, setShowModal] = useState(false);
  const [editingAlias, setEditingAlias] = useState<Alias | null>(null);
  const [formSource, setFormSource] = useState('');
  const [formDestination, setFormDestination] = useState('');
  const [formError, setFormError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const fetchAliases = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await aliasesApi.list(page, 50, search || undefined);
      setError('');
      setAliases(response.data ?? []);
      setTotalPages(response.pagination?.totalPages ?? 1);
      setTotal(response.pagination?.total ?? 0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load aliases');
    } finally {
      setIsLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    fetchAliases();
  }, [fetchAliases]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput);
    setPage(1);
  };

  const openCreateModal = () => {
    setEditingAlias(null);
    setFormSource('');
    setFormDestination('');
    setFormError('');
    setShowModal(true);
  };

  const openEditModal = (alias: Alias) => {
    setEditingAlias(alias);
    setFormSource(alias.source);
    setFormDestination(alias.destination);
    setFormError('');
    setShowModal(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setIsSaving(true);

    try {
      if (editingAlias) {
        await aliasesApi.update(editingAlias.id, {
          source: formSource,
          destination: formDestination,
        });
      } else {
        await aliasesApi.create(formSource, formDestination);
      }
      setShowModal(false);
      fetchAliases();
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

  const handleDelete = async (alias: Alias) => {
    if (!(await confirm(`Delete alias ${alias.source} → ${alias.destination}?`))) return;

    try {
      await aliasesApi.delete(alias.id);
      fetchAliases();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to delete alias');
    }
  };

  const columns = [
    { key: 'source', header: 'Source' },
    { key: 'destination', header: 'Destination' },
    {
      key: 'actions',
      header: 'Actions',
      className: 'w-24',
      render: (alias: Alias) =>
        canEdit ? (
          <div className="flex gap-1">
            <button
              onClick={() => openEditModal(alias)}
              className="p-1.5 hover:bg-gray-100 dark:hover:bg-robin-gray-700 rounded-sm"
              title="Edit"
            >
              <Edit className="w-4 h-4" />
            </button>
            <button
              onClick={() => handleDelete(alias)}
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
          icon={appIcons.aliases}
          title="Aliases"
          description="Manage address aliases that forward mail to one or more recipients."
          actions={canEdit && !error && !isLoading && (
            <Button onClick={openCreateModal}>
              <Plus className="w-4 h-4 mr-2" />
              Add alias
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
            placeholder="Search aliases..."
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
          data={aliases}
          keyField="id"
          isLoading={isLoading}
          emptyMessage="No aliases found"
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
        title={editingAlias ? 'Edit alias' : 'Create alias'}
      >
        <form onSubmit={handleSave} className="space-y-4">
          {formError && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-red-600 dark:text-red-400 text-sm">
              {formError}
            </div>
          )}

          <Input
            label="Source"
            type="text"
            value={formSource}
            onChange={(e) => setFormSource(e.target.value)}
            placeholder="alias@example.com"
            required
          />

          <Input
            label="Destination"
            type="text"
            value={formDestination}
            onChange={(e) => setFormDestination(e.target.value)}
            placeholder="user@example.com"
            required
          />

          <div className="flex justify-end gap-2 pt-4">
            <Button type="button" variant="secondary" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button type="submit" isLoading={isSaving}>
              {editingAlias ? 'Save changes' : 'Create alias'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
