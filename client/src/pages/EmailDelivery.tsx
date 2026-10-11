import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { Mail, Send, Server, Trash2 } from 'lucide-react';
import { ApiError, emailApi } from '../api/client';
import { AdminNotice, SettingsCard, StatusBadge } from '../components/administration/AdminPrimitives';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { MetricTabs, type MetricTab } from '../components/ui/MetricTabs';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import type {
  EmailRelay,
  EmailRelayType,
  EmailSenderProfile,
  EmailSmtpSecurity,
  EmailTransportAdminView,
  EmailTlsMode,
} from '../types/email';

type Tab = 'relays' | 'senders';

const TABS: readonly MetricTab<Tab>[] = [
  { id: 'relays', label: 'Relays', icon: Server },
  { id: 'senders', label: 'Senders', icon: Mail },
];

interface RelayForm {
  id: number | null;
  name: string;
  relayType: EmailRelayType;
  enabled: boolean;
  priority: number;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: EmailSmtpSecurity;
  tlsMode: EmailTlsMode;
  username: string;
  password: string;
  robinServiceId: string;
  postfixServiceId: string;
}

function emptyRelayForm(): RelayForm {
  return {
    id: null,
    name: '',
    relayType: 'smtp',
    enabled: true,
    priority: 100,
    smtpHost: '',
    smtpPort: '25',
    smtpSecurity: 'starttls',
    tlsMode: 'strict',
    username: '',
    password: '',
    robinServiceId: '',
    postfixServiceId: '',
  };
}

export function EmailDeliveryPage() {
  const [summary, setSummary] = useState<EmailTransportAdminView | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const saved = localStorage.getItem('robin-admin.outbound-email.tab');
    return saved === 'senders' ? 'senders' : 'relays';
  });
  const [relayForm, setRelayForm] = useState<RelayForm>(emptyRelayForm);
  const [senderEdit, setSenderEdit] = useState<Record<string, EmailSenderProfile>>({});
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const load = async () => {
    try {
      const response = await emailApi.transport();
      setSummary(response.data ?? null);
      setSenderEdit(Object.fromEntries((response.data?.senderProfiles ?? []).map((profile) => [profile.profileKey, profile])));
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load outbound email settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    localStorage.setItem('robin-admin.outbound-email.tab', activeTab);
  }, [activeTab]);

  const run = async (message: string, action: () => Promise<void>) => {
    setWorking(true);
    setError('');
    setSuccess('');
    try {
      await action();
      setSuccess(message);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
    } finally {
      setWorking(false);
    }
  };

  const saveRelay = () => run('Relay saved', async () => {
    await emailApi.saveRelay({
      id: relayForm.id,
      name: relayForm.name,
      relayType: relayForm.relayType,
      enabled: relayForm.enabled,
      priority: relayForm.priority,
      smtpHost: relayForm.smtpHost || null,
      smtpPort: relayForm.smtpPort ? Number(relayForm.smtpPort) : null,
      smtpSecurity: relayForm.smtpSecurity,
      tlsMode: relayForm.tlsMode,
      username: relayForm.username || null,
      password: relayForm.password || undefined,
      robinServiceId: relayForm.robinServiceId || null,
      postfixServiceId: relayForm.postfixServiceId || null,
    });
    setRelayForm(emptyRelayForm());
  });

  const editRelay = (relay: EmailRelay) => setRelayForm({
    id: relay.id,
    name: relay.name,
    relayType: relay.relayType,
    enabled: relay.enabled,
    priority: relay.priority,
    smtpHost: relay.smtpHost ?? '',
    smtpPort: relay.smtpPort ? String(relay.smtpPort) : '',
    smtpSecurity: relay.smtpSecurity,
    tlsMode: relay.tlsMode,
    username: relay.username ?? '',
    password: '',
    robinServiceId: relay.robinServiceId ?? '',
    postfixServiceId: relay.postfixServiceId ?? '',
  });

  const saveSender = (profile: EmailSenderProfile) => run('Sender profile saved', async () => {
    await emailApi.updateSender(profile.profileKey, {
      fromName: profile.fromName,
      fromEmail: profile.fromEmail,
      replyTo: profile.replyTo,
      envelopeFrom: profile.envelopeFrom,
      enabled: profile.enabled,
      relayIds: profile.relayIds,
    });
  });

  if (loading) return <div className="flex justify-center py-10"><Spinner className="text-robin-orange" /></div>;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Send}
        title="Outbound email"
        description="Application-wide relays and sender identities used by password recovery, alerts, and status page mail."
        actions={<Button variant="secondary" onClick={() => void load()}>Refresh</Button>}
      />

      <div aria-live="polite" className="space-y-2">
        {error && <AdminNotice tone="error">{error}</AdminNotice>}
        {success && <AdminNotice tone="success">{success}</AdminNotice>}
      </div>

      <MetricTabs tabs={TABS} activeTab={activeTab} onChange={setActiveTab} />

      {activeTab === 'relays' && summary && (
        <Relays
          summary={summary}
          form={relayForm}
          setForm={setRelayForm}
          save={saveRelay}
          editRelay={editRelay}
          deleteRelay={(id) => run('Relay deleted', async () => { await emailApi.deleteRelay(id); })}
          working={working}
        />
      )}
      {activeTab === 'senders' && summary && (
        <Senders
          summary={summary}
          senderEdit={senderEdit}
          setSenderEdit={setSenderEdit}
          saveSender={saveSender}
          sendTest={(profileKey) => run('Test email queued', async () => { await emailApi.sendTest({ profileKey }); })}
          working={working}
        />
      )}
    </div>
  );
}

function Relays({ summary, form, setForm, save, editRelay, deleteRelay, working }: {
  summary: EmailTransportAdminView;
  form: RelayForm;
  setForm: (form: RelayForm) => void;
  save: () => void;
  editRelay: (relay: EmailRelay) => void;
  deleteRelay: (id: number) => void;
  working: boolean;
}) {
  return (
    <div className="grid gap-6 xl:grid-cols-[420px_1fr]">
      <SettingsCard
        title={form.id ? 'Edit relay' : 'Add relay'}
        description="Relays are tried by priority. Sender profiles can either use all enabled relays or a specific subset."
      >
        <div className="space-y-4">
          <Input label="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Type">
              <select className="input" value={form.relayType} onChange={(event) => setForm({ ...form, relayType: event.target.value as EmailRelayType })}>
                <option value="smtp">Local SMTP</option>
                <option value="robin">Robin service</option>
                <option value="postfix">Postfix SMTP</option>
              </select>
            </Field>
            <Input label="Priority" type="number" value={form.priority} onChange={(event) => setForm({ ...form, priority: Number(event.target.value) || 0 })} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="SMTP host" value={form.smtpHost} onChange={(event) => setForm({ ...form, smtpHost: event.target.value })} />
            <Input label="SMTP port" type="number" value={form.smtpPort} onChange={(event) => setForm({ ...form, smtpPort: event.target.value })} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Security">
              <select className="input" value={form.smtpSecurity} onChange={(event) => setForm({ ...form, smtpSecurity: event.target.value as EmailSmtpSecurity })}>
                <option value="none">None</option>
                <option value="starttls">STARTTLS</option>
                <option value="tls">Implicit TLS</option>
              </select>
            </Field>
            <Field label="TLS verification">
              <select className="input" value={form.tlsMode} onChange={(event) => setForm({ ...form, tlsMode: event.target.value as EmailTlsMode })}>
                <option value="strict">Strict</option>
                <option value="allow_self_signed">Trust self-signed</option>
              </select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Username" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
            <Input label={form.id ? 'Password (blank keeps existing)' : 'Password'} type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Robin service id" value={form.robinServiceId} onChange={(event) => setForm({ ...form, robinServiceId: event.target.value })} />
            <Input label="Postfix service id" value={form.postfixServiceId} onChange={(event) => setForm({ ...form, postfixServiceId: event.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-robin-orange" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />
            Enabled
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setForm(emptyRelayForm())}>Clear</Button>
            <Button onClick={save} disabled={working || !form.name}>Save relay</Button>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="Configured relays" description="Current failover order and transport endpoints.">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-gray-50 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300">
              <tr>{['Relay', 'Type', 'Endpoint', 'Priority', 'State', 'Actions'].map((heading) => <th key={heading} className="px-4 py-3 font-medium">{heading}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {summary.relays.map((relay) => (
                <tr key={relay.id}>
                  <td className="px-4 py-3 font-medium">{relay.name}</td>
                  <td className="px-4 py-3">{formatRelayType(relay.relayType)}</td>
                  <td className="wrap-break-word px-4 py-3">{relay.smtpHost ? `${relay.smtpHost}:${relay.smtpPort ?? ''}` : relay.robinServiceId || relay.postfixServiceId || '-'}</td>
                  <td className="px-4 py-3">{relay.priority}</td>
                  <td className="px-4 py-3"><StatusBadge tone={relay.enabled ? 'success' : 'neutral'}>{relay.enabled ? 'Enabled' : 'Disabled'}</StatusBadge></td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => editRelay(relay)}>Edit</Button>
                      <Button size="sm" variant="danger" onClick={() => deleteRelay(relay.id)} disabled={working} aria-label={`Delete ${relay.name}`}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {!summary.relays.length && <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">No relays configured.</td></tr>}
            </tbody>
          </table>
        </div>
      </SettingsCard>
    </div>
  );
}

function Senders({ summary, senderEdit, setSenderEdit, saveSender, sendTest, working }: {
  summary: EmailTransportAdminView;
  senderEdit: Record<string, EmailSenderProfile>;
  setSenderEdit: Dispatch<SetStateAction<Record<string, EmailSenderProfile>>>;
  saveSender: (profile: EmailSenderProfile) => void;
  sendTest: (profileKey: EmailSenderProfile['profileKey']) => void;
  working: boolean;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {summary.senderProfiles.map((profile) => {
        const draft = senderEdit[profile.profileKey] ?? profile;
        return (
          <section key={profile.profileKey} className="card p-5">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">{profile.displayName}</h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{formatProfilePurpose(profile.profileKey)}</p>
              </div>
              <StatusBadge tone={draft.enabled ? 'success' : 'neutral'}>{draft.enabled ? 'Enabled' : 'Disabled'}</StatusBadge>
            </div>
            <div className="space-y-4">
              <Input label="From name" value={draft.fromName} onChange={(event) => setSenderEdit((current) => ({ ...current, [profile.profileKey]: { ...draft, fromName: event.target.value } }))} />
              <Input label="From email" type="email" value={draft.fromEmail} onChange={(event) => setSenderEdit((current) => ({ ...current, [profile.profileKey]: { ...draft, fromEmail: event.target.value } }))} />
              <Input label="Reply-To" value={draft.replyTo ?? ''} onChange={(event) => setSenderEdit((current) => ({ ...current, [profile.profileKey]: { ...draft, replyTo: event.target.value || null } }))} />
              <Input label="Envelope sender" value={draft.envelopeFrom ?? ''} onChange={(event) => setSenderEdit((current) => ({ ...current, [profile.profileKey]: { ...draft, envelopeFrom: event.target.value || null } }))} />
              <RelayChecks relays={summary.relays} selected={draft.relayIds} onChange={(relayIds) => setSenderEdit((current) => ({ ...current, [profile.profileKey]: { ...draft, relayIds } }))} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-robin-orange" checked={draft.enabled} onChange={(event) => setSenderEdit((current) => ({ ...current, [profile.profileKey]: { ...draft, enabled: event.target.checked } }))} />
                Enabled
              </label>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => saveSender(draft)} disabled={working || !draft.fromName || !draft.fromEmail}>Save sender</Button>
                <Button variant="secondary" onClick={() => sendTest(profile.profileKey)} disabled={working}>Send test</Button>
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}

function RelayChecks({ relays, selected, onChange }: { relays: EmailRelay[]; selected: number[]; onChange: (ids: number[]) => void }) {
  const toggle = (id: number) => onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  return (
    <div>
      <div className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">Relay policy</div>
      <div className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-robin-gray-700">
        {relays.length === 0 && <div className="text-sm text-gray-500">No relays configured. Empty policy will use all enabled relays once added.</div>}
        {relays.map((relay) => (
          <label key={relay.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-2">
              <input type="checkbox" className="h-4 w-4 accent-robin-orange" checked={selected.includes(relay.id)} onChange={() => toggle(relay.id)} />
              {relay.name}
            </span>
            <StatusBadge tone={relay.enabled ? 'success' : 'neutral'}>{relay.enabled ? 'Enabled' : 'Disabled'}</StatusBadge>
          </label>
        ))}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block space-y-1"><span className="block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</span>{children}</label>;
}

function formatRelayType(value: EmailRelayType): string {
  if (value === 'smtp') return 'Local SMTP';
  if (value === 'robin') return 'Robin service';
  return 'Postfix SMTP';
}

function formatProfilePurpose(value: EmailSenderProfile['profileKey']): string {
  if (value === 'alerts') return 'Alert and monitoring notifications';
  if (value === 'status') return 'Public status page notifications';
  return 'System mail and password recovery';
}
