import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { hostSecurityApi } from '../api/client';
import { SecurityBadge, SecurityError, SecurityPagination, SecurityTime, useSecurityPagination } from '../components/fleet/hostSecurityUi';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { Table, type Column } from '../components/ui/Table';
import { appIcons } from '../constants/appIcons';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import type { HostSecurityKnownAddress } from '../types/host-security';

const emptyAddress: HostSecurityKnownAddress = { id: '', network: '', label: '', expiresAt: null };
type AddressChange =
  | { kind: 'save'; entry: HostSecurityKnownAddress }
  | { kind: 'remove'; id: string };

export function HostSecurityAddressesPage() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const client = useQueryClient();
  const pagination = useSecurityPagination();
  const [entry, setEntry] = useState<HostSecurityKnownAddress | null>(null);
  const [notice, setNotice] = useState('');
  const addresses = useQuery({
    queryKey: ['host-security', 'addresses', pagination.cursor],
    queryFn: async () => (await hostSecurityApi.addresses(pagination.cursor)).data,
  });
  const mutation = useMutation({
    mutationFn: async (change: AddressChange) => {
      if (change.kind === 'remove') {
        await hostSecurityApi.deleteAddress(change.id);
      } else {
        const { id, network, label, expiresAt } = change.entry;
        await hostSecurityApi.saveAddress({ network: network.trim(), label: label.trim(), expiresAt }, id || undefined);
      }
    },
    onSuccess: async (_data, change) => {
      await client.invalidateQueries({ queryKey: ['host-security', 'addresses'] });
      setEntry(null);
      setNotice(change.kind === 'remove' ? 'Known address removed.' : 'Known address saved.');
    },
  });

  function edit(address: HostSecurityKnownAddress = emptyAddress) {
    mutation.reset();
    setNotice('');
    setEntry(address);
  }

  function close() {
    if (mutation.isPending) return;
    mutation.reset();
    setEntry(null);
  }

  async function remove(address: HostSecurityKnownAddress) {
    if (!(await confirm('Remove ' + address.label + ' (' + address.network + ') from known addresses?\nFuture sign-ins from this address will be checked against the remaining entries.'))) return;
    mutation.reset();
    setNotice('');
    mutation.mutate({ kind: 'remove', id: address.id });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (entry && !mutation.isPending && user?.role === 'admin') mutation.mutate({ kind: 'save', entry });
  }

  const columns: Column<HostSecurityKnownAddress>[] = [
    { key: 'label', header: 'Label', render: address => <span className="font-medium">{address.label}</span> },
    { key: 'network', header: 'IP / CIDR', render: address => <span className="whitespace-nowrap font-mono text-sm">{address.network}</span> },
    {
      key: 'expiresAt', header: 'Expiry (UTC)',
      render: address => address.expiresAt ? (
        <div className="flex flex-wrap items-center gap-2">
          <SecurityTime value={address.expiresAt} utc />
          {Date.parse(address.expiresAt) <= Date.now() && <SecurityBadge>Expired</SecurityBadge>}
        </div>
      ) : <span className="text-gray-500 dark:text-gray-400">Never</span>,
    },
  ];
  if (user?.role === 'admin') {
    columns.push({
      key: 'actions', header: <span className="block text-right">Actions</span>,
      render: address => (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" aria-label={'Edit ' + address.label} disabled={mutation.isPending} onClick={() => edit(address)}>Edit</Button>
          <Button size="sm" variant="danger" aria-label={'Remove ' + address.label} disabled={mutation.isPending} onClick={() => void remove(address)}>Remove</Button>
        </div>
      ),
    });
  }

  return (
    <div className="space-y-5">
      <Link className="inline-flex items-center gap-2 text-sm font-medium text-robin-orange hover:underline" to="/fleet/security">
        <ArrowLeft aria-hidden="true" className="h-4 w-4" /> All security hosts
      </Link>
      <PageHeader icon={appIcons.hostSecurity} title="Known addresses" description="Classify successful sign-ins from trusted IP addresses and networks." actions={
        user?.role === 'admin' && <Button disabled={mutation.isPending} onClick={() => edit()}>
          <Plus aria-hidden="true" className="h-4 w-4" /> Add address
        </Button>
      } />
      {notice && <p role="status" className="text-sm text-green-700 dark:text-green-300">{notice}</p>}
      {!entry && <SecurityError error={mutation.error} label="Could not remove the address" />}
      <section aria-label="Known address entries" className="card overflow-hidden">
        {addresses.error && <div className="p-4"><SecurityError error={addresses.error} label="Could not load known addresses" retry={() => void addresses.refetch()} isRetrying={addresses.isFetching} /></div>}
        {(addresses.isPending || addresses.data) && (
          <Table columns={columns} data={addresses.data?.items ?? []} keyField="id" scrollLabel="Known addresses"
            isLoading={addresses.isPending} emptyMessage={pagination.page === 1 ? 'No known addresses are configured.' : 'No known addresses on this page.'} />
        )}
        <SecurityPagination pagination={pagination} nextCursor={addresses.data?.nextCursor} busy={addresses.isFetching} />
      </section>
      {entry && user?.role === 'admin' && (
        <Modal isOpen title={entry.id ? 'Edit known address' : 'Add known address'} onClose={close}>
          <form className="space-y-4" onSubmit={submit}>
            <Input label="Label" required maxLength={128} value={entry.label}
              onChange={event => setEntry({ ...entry, label: event.target.value })} disabled={mutation.isPending} />
            <Input label="IP address or CIDR" required value={entry.network}
              onChange={event => setEntry({ ...entry, network: event.target.value })} disabled={mutation.isPending} />
            <Input label="Expiry (UTC, optional)" type="datetime-local" value={entry.expiresAt?.slice(0, 16) ?? ''}
              onChange={event => setEntry({ ...entry, expiresAt: event.target.value ? event.target.value + ':00Z' : null })} disabled={mutation.isPending} />
            <SecurityError error={mutation.error} label="Could not save the address" />
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" onClick={close} disabled={mutation.isPending}>Cancel</Button>
              <Button type="submit" isLoading={mutation.isPending} disabled={!entry.label.trim() || !entry.network.trim()}>
                {entry.id ? 'Save address' : 'Add address'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
