import { useCallback, useEffect, useState } from 'react';
import { mailPolicyApi } from '../api/client';
import { useIsAdmin } from '../hooks/useAuth';
import { useConfirm } from '../context/ConfirmContext';
import { MailboxTabs } from '../components/layout/MailboxTabs';
import { PageHeader } from '../components/ui/PageHeader';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Table } from '../components/ui/Table';
import { appIcons } from '../constants/appIcons';
import type { MailDomain, SenderGrant } from '../types/mail-policy';

const emptyDomain: MailDomain = { domain: '', enabled: true, plus_addressing: false, catch_all: null };
const emptyGrant: SenderGrant = { account: '', address: '', grant_type: 'primary' };

export function MailPolicyPage() {
  const admin = useIsAdmin();
  const confirm = useConfirm();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [domains, setDomains] = useState<MailDomain[]>([]);
  const [grants, setGrants] = useState<SenderGrant[]>([]);
  const [domainPage, setDomainPage] = useState(1);
  const [grantPage, setGrantPage] = useState(1);
  const [domainTotal, setDomainTotal] = useState(0);
  const [grantTotal, setGrantTotal] = useState(0);
  const [domain, setDomain] = useState<MailDomain>(emptyDomain);
  const [grant, setGrant] = useState<SenderGrant>(emptyGrant);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const status = await mailPolicyApi.status();
      if (!status.data) throw new Error('Mail policy status unavailable');
      setAvailable(status.data.available);
      if (!status.data.available) return;
      const [d, g] = await Promise.all([mailPolicyApi.domains(domainPage), mailPolicyApi.grants(grantPage)]);
      setDomains(d.data ?? []);
      setGrants(g.data ?? []);
      setDomainTotal(d.pagination?.total ?? 0);
      setGrantTotal(g.pagination?.total ?? 0);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load mail policy');
    }
  }, [domainPage, grantPage]);
  useEffect(() => { void load(); }, [load]);

  const save = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try { await operation(); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to save mail policy'); }
    finally { setBusy(false); }
  };

  return <div>
    <PageHeader icon={appIcons.users} title="Domains & send-as" description="Explicit mail-domain policy and per-account sending identities." />
    <MailboxTabs />
    {error && <div role="alert" className="mb-4 text-red-600">{error}</div>}
    {available === false && <p className="card p-4">Mail policy schema is not installed. Apply the suite mail-control migration before using these controls. Existing mailbox schemas are not modified automatically.</p>}
    {available && <>
      <p className="mb-4 text-sm text-gray-500">Saved policy is enforced only by a Robin instance configured to use the suite identity queries. Routing aliases never grant send-as permission. These grants do not grant IMAP mailbox access.</p>
      <h2 className="mb-3 text-lg font-semibold">Domains</h2>
      <div className="card mb-4"><Table<MailDomain> keyField="domain" data={domains}
        columns={[
          { key: 'domain', header: 'Domain' },
          { key: 'enabled', header: 'Enabled', render: d => d.enabled ? 'Yes' : 'No' },
          { key: 'plus_addressing', header: 'Plus addressing', render: d => d.plus_addressing ? 'On' : 'Off' },
          { key: 'catch_all', header: 'Catch-all', render: d => d.catch_all ?? 'Off' },
          ...(admin ? [{ key: 'edit', header: 'Actions', render: (d: MailDomain) => <Button variant="secondary" onClick={() => setDomain(d)}>Edit</Button> }] : []),
        ]}
        pagination={{ page: domainPage, totalPages: Math.ceil(domainTotal / 50), total: domainTotal, onPageChange: setDomainPage }} /></div>
      {admin && <form className="card mb-6 space-y-3 p-4" onSubmit={e => { e.preventDefault(); void save(async () => { await mailPolicyApi.saveDomain(domain); setDomain(emptyDomain); }); }}>
        <Input label="Domain" value={domain.domain} onChange={e => setDomain({ ...domain, domain: e.target.value })} required />
        <label className="flex gap-2"><input type="checkbox" checked={domain.enabled} onChange={e => setDomain({ ...domain, enabled: e.target.checked })} />Domain enabled</label>
        <label className="flex gap-2"><input type="checkbox" checked={domain.plus_addressing} onChange={e => setDomain({ ...domain, plus_addressing: e.target.checked })} />Allow plus addressing</label>
        <Input label="Catch-all local mailbox (blank disables)" type="email" value={domain.catch_all ?? ''} onChange={e => setDomain({ ...domain, catch_all: e.target.value || null })} />
        <Button type="submit" disabled={busy}>Save domain policy</Button>
      </form>}
      <h2 className="mb-3 text-lg font-semibold">Sender grants</h2>
      <div className="card mb-4"><Table<SenderGrant & { key: string }> keyField="key" data={grants.map(g => ({ ...g, key: `${g.account}:${g.address}` }))}
        columns={[
          { key: 'account', header: 'Authenticated account' },
          { key: 'address', header: 'Allowed sender' },
          { key: 'grant_type', header: 'Type' },
          ...(admin ? [{ key: 'revoke', header: 'Actions', render: (g: SenderGrant) => <Button variant="secondary" disabled={busy} onClick={async () => {
            if (await confirm(`Revoke ${g.address} for ${g.account}?`)) void save(() => mailPolicyApi.revokeGrant(g));
          }}>Revoke</Button> }] : []),
        ]}
        pagination={{ page: grantPage, totalPages: Math.ceil(grantTotal / 50), total: grantTotal, onPageChange: setGrantPage }} /></div>
      {admin && <form className="card space-y-3 p-4" onSubmit={e => { e.preventDefault(); void save(async () => { await mailPolicyApi.saveGrant(grant); setGrant(emptyGrant); }); }}>
        <Input label="Authenticated account" type="email" value={grant.account} onChange={e => setGrant({ ...grant, account: e.target.value })} required />
        <Input label="Allowed sender address" type="email" value={grant.address} onChange={e => setGrant({ ...grant, address: e.target.value })} required />
        <label className="block">Grant type<select className="input mt-1" value={grant.grant_type} onChange={e => setGrant({ ...grant, grant_type: e.target.value as SenderGrant['grant_type'] })}>
          <option value="primary">Primary account</option><option value="alias">Alias</option><option value="delegated">Delegated mailbox sender</option>
        </select></label>
        <p className="text-sm text-gray-500">Primary grants must match the account. Alias grants require a routing alias; delegated grants require a local mailbox. Enforced submission requires a primary grant too.</p>
        <Button type="submit" disabled={busy}>Save sender grant</Button>
      </form>}
    </>}
  </div>;
}
