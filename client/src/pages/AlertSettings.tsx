import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Activity, Bell, LineChart, Pause, Play, RefreshCw, Send, Settings, Trash2 } from 'lucide-react';
import { alertsApi, configApi, ApiError } from '../api/client';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { MetricTabs, type MetricTab } from '../components/ui/MetricTabs';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import { OperationsPolicyFields } from '../components/administration/OperationsPolicyFields';
import { TelemetryAlertRules } from '../components/administration/TelemetryAlertRules';
import { operationsDefaults } from '../constants/operationsSettings';
import type {
  AlertCatalogEntry,
  AlertDelivery,
  AlertJson,
  AlertSubscription,
  AlertWebhook,
  AlertWebhookAdapter,
  AlertWebhookResponse,
} from '../types/alerts';

type AlertTab = 'webhooks' | 'rules' | 'policy' | 'deliveries';

const ALERT_TABS: readonly MetricTab<AlertTab>[] = [
  { id: 'webhooks', label: 'Destinations', icon: Bell },
  { id: 'rules', label: 'Telemetry rules', icon: LineChart },
  { id: 'policy', label: 'Policy', icon: Settings },
  { id: 'deliveries', label: 'Deliveries', icon: Activity },
];

interface WebhookForm {
  id: number | null;
  name: string;
  adapter: AlertWebhookAdapter;
  webhookUrl: string;
  enabled: boolean;
  subscriptions: AlertSubscription[];
  consecutiveFailures: number;
  repeatIntervalSeconds: number | null;
  notifyRecovery: boolean;
  sentryOrg: string;
  sentryApiUrl: string;
  /** Write-only: empty keeps the stored token. */
  sentryApiToken: string;
  hasSentryToken: boolean;
}

const ADAPTER_LABELS: Record<AlertWebhookAdapter, string> = { slack: 'Slack', generic: 'Generic JSON', sentry: 'Sentry' };

const emptyForm = (catalog: AlertCatalogEntry[]): WebhookForm => ({
  id: null,
  name: '',
  adapter: 'slack',
  webhookUrl: '',
  enabled: false,
  subscriptions: catalog.map((entry) => ({
    alertType: entry.key,
    enabled: false,
    threshold: entry.defaultThreshold,
  })),
  consecutiveFailures: 3,
  repeatIntervalSeconds: 14400,
  notifyRecovery: true,
  sentryOrg: '',
  sentryApiUrl: '',
  sentryApiToken: '',
  hasSentryToken: false,
});

export function AlertSettingsPage() {
  const [data, setData] = useState<AlertWebhookResponse | null>(null);
  const [deliveries, setDeliveries] = useState<AlertDelivery[]>([]);
  const [form, setForm] = useState<WebhookForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<AlertJson | null>(null);
  const [confirmation, setConfirmation] = useState<{ kind: 'test' | 'delete'; webhook: AlertWebhook } | null>(null);
  const [pauseTarget, setPauseTarget] = useState<AlertWebhook | null>(null);
  const [pauseUntil, setPauseUntil] = useState('');
  const [pauseReason, setPauseReason] = useState('');
  const [deliveryRetentionDays, setDeliveryRetentionDays] = useState(30);
  const [policy, setPolicy] = useState(operationsDefaults);
  const [activeTab, setActiveTab] = useState<AlertTab>(() => {
    const saved = localStorage.getItem('robin-admin.alerts.tab');
    return saved === 'rules' || saved === 'policy' || saved === 'deliveries' ? saved : 'webhooks';
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [webhooks, history] = await Promise.all([alertsApi.listWebhooks(), alertsApi.listDeliveries()]);
      setData(webhooks.data ?? null);
      setDeliveries(history.data ?? []);
      if (webhooks.data?.runtime.deliveryRetentionDays) {
        setDeliveryRetentionDays(webhooks.data.runtime.deliveryRetentionDays);
      }
      const runtime = webhooks.data?.runtime;
      if (runtime) setPolicy({
        ...operationsDefaults(), alertsEnabled: runtime.enabled, alertInstanceName: runtime.instanceName,
        alertEvaluationIntervalMs: runtime.evaluationIntervalMs,
        alertDeliveryIntervalMs: runtime.workerIntervalMs, alertDeliveryConcurrency: runtime.deliveryConcurrency,
        alertDeliveryExpiryMs: runtime.deliveryExpiryMs,
        alertDeliveryMaxAttempts: runtime.maxAttempts, alertRetryBaseMs: runtime.baseRetryDelayMs,
        alertRetryMaxMs: runtime.maxRetryDelayMs,
      });
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load alerts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    localStorage.setItem('robin-admin.alerts.tab', activeTab);
  }, [activeTab]);

  const selectedWebhook = useMemo(
    () => data?.webhooks.find((webhook) => webhook.id === form?.id) ?? null,
    [data, form?.id],
  );

  const editWebhook = (webhook: AlertWebhook) => {
    setForm({
      id: webhook.id,
      name: webhook.name,
      adapter: webhook.adapter,
      webhookUrl: '',
      enabled: webhook.enabled,
      subscriptions: webhook.subscriptions,
      consecutiveFailures: webhook.consecutiveFailures,
      repeatIntervalSeconds: webhook.repeatIntervalSeconds,
      notifyRecovery: webhook.notifyRecovery,
      sentryOrg: webhook.sentryOrg ?? '',
      sentryApiUrl: webhook.sentryApiUrl ?? '',
      sentryApiToken: '',
      hasSentryToken: webhook.hasSentryToken,
    });
  };

  const run = async (successMessage: string, action: () => Promise<void>) => {
    setWorking(true);
    setError('');
    setMessage('');
    try {
      await action();
      setMessage(successMessage);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
    } finally {
      setWorking(false);
    }
  };

  const save = () => {
    if (!form) return;
    void run('Webhook saved', async () => {
      const payload = {
        name: form.name,
        adapter: form.adapter,
        enabled: form.enabled,
        subscriptions: form.subscriptions,
        consecutiveFailures: form.consecutiveFailures,
        repeatIntervalSeconds: form.repeatIntervalSeconds,
        notifyRecovery: form.notifyRecovery,
        ...(form.webhookUrl ? { webhookUrl: form.webhookUrl } : {}),
        ...(form.adapter === 'sentry' ? {
          sentryOrg: form.sentryOrg.trim() || null,
          sentryApiUrl: form.sentryApiUrl.trim() || null,
          ...(form.sentryApiToken ? { sentryApiToken: form.sentryApiToken } : {}),
        } : {}),
      };
      if (form.id) {
        await alertsApi.updateWebhook(form.id, payload);
      } else {
        if (!form.webhookUrl) throw new Error(form.adapter === 'sentry' ? 'A Sentry DSN is required' : 'A webhook URL is required');
        await alertsApi.createWebhook({ ...payload, webhookUrl: form.webhookUrl });
      }
      setForm(null);
    });
  };

  const confirmAction = () => {
    if (!confirmation) return;
    const { kind, webhook } = confirmation;
    setConfirmation(null);
    if (kind === 'delete') {
      void run('Webhook deleted', async () => {
        await alertsApi.deleteWebhook(webhook.id);
        if (form?.id === webhook.id) setForm(null);
      });
      return;
    }
    void run('Live test queued', async () => {
      await alertsApi.testWebhook(webhook.id);
    });
  };

  const savePause = () => {
    if (!pauseTarget) return;
    const target = pauseTarget;
    setPauseTarget(null);
    void run('Webhook paused', async () => {
      await alertsApi.pauseWebhook(target.id, {
        ...(pauseUntil ? { pausedUntil: new Date(pauseUntil).toISOString() } : {}),
        ...(pauseReason ? { reason: pauseReason } : {}),
      });
      setPauseUntil('');
      setPauseReason('');
    });
  };

  const saveAlertPolicy = () => {
    void run('Alert policy saved', async () => {
      await configApi.update({
        alertDeliveryRetentionDays: deliveryRetentionDays, alertsEnabled: policy.alertsEnabled,
        alertInstanceName: policy.alertInstanceName, alertEvaluationIntervalMs: policy.alertEvaluationIntervalMs,
        alertDeliveryIntervalMs: policy.alertDeliveryIntervalMs, alertDeliveryConcurrency: policy.alertDeliveryConcurrency,
        alertDeliveryExpiryMs: policy.alertDeliveryExpiryMs,
        alertDeliveryMaxAttempts: policy.alertDeliveryMaxAttempts, alertRetryBaseMs: policy.alertRetryBaseMs,
        alertRetryMaxMs: policy.alertRetryMaxMs,
      });
    });
  };

  if (loading) {
    return <div className="flex justify-center py-10"><Spinner className="text-robin-orange" /></div>;
  }

  const catalog = data?.catalog ?? [];
  const runtime = data?.runtime;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.alerts}
        title="Alerts"
        description="Send service health and resource alerts to Slack or generic HTTPS webhooks."
        actions={(
          <Button variant="secondary" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="h-4 w-4" />
            Refresh
          </Button>
        )}
      />

      <div aria-live="polite" className="space-y-2">
        {error && <Notice tone="error">{error}</Notice>}
        {message && <Notice tone="success">{message}</Notice>}
      </div>
      {runtime?.monitoringEnabled && !runtime.enabled && <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
        Monitoring is active, but alert delivery is disabled. Enable alert evaluation and delivery below to receive Monitoring notifications.
      </div>}

      <MetricTabs tabs={ALERT_TABS} activeTab={activeTab} onChange={setActiveTab} />

      {activeTab === 'webhooks' && (
        <div className="grid gap-6 xl:grid-cols-[360px_1fr]" data-testid="alert-cards">
          <section className="card p-5">
            <h2 className="text-base font-semibold">Alert routing</h2>
            <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">
              Webhooks choose alert types, failure confirmation, repeat cadence, and recovery notifications.
              Pausing a webhook stops notifications while service state continues to update.
            </p>
            <div className="mt-3 flex flex-wrap gap-2 text-sm">
              <Pill>{runtime?.enabled ? 'Evaluator running' : 'Evaluator disabled'}</Pill>
              <Pill>{runtime?.enabledWebhooks ?? 0} enabled webhooks</Pill>
              <Pill>{runtime?.pendingDeliveries ?? 0} pending deliveries</Pill>
              <Pill>{runtime?.failedDeliveries ?? 0} failed deliveries</Pill>
            </div>
          </section>

          <section className="card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">Destinations</h2>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                  Slack and generic webhooks, or a Sentry project (choose the Sentry format and enter its DSN). URLs and DSNs are encrypted and write-only; saving an empty one keeps the stored value.
                </p>
              </div>
              <Button onClick={() => setForm(emptyForm(catalog))}>Add destination</Button>
            </div>

            {data?.webhooks.length ? (
              <div className="mt-4 grid gap-3">
                {data.webhooks.map((webhook) => {
                  const paused = Boolean(webhook.pausedAt && (!webhook.pausedUntil || new Date(webhook.pausedUntil) > new Date()));
                  return (
                    <article key={webhook.id} className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="wrap-break-word font-medium">{webhook.name}</h3>
                          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                            {ADAPTER_LABELS[webhook.adapter]} · {webhook.enabled ? 'Enabled' : 'Disabled'} · {webhook.hasSecret ? (webhook.adapter === 'sentry' ? 'DSN stored' : 'URL stored') : (webhook.adapter === 'sentry' ? 'DSN missing' : 'URL missing')}
                            {webhook.adapter === 'sentry' && (webhook.hasSentryToken && webhook.sentryOrg ? ' · resolves issues on recovery' : ' · no API token, Sentry auto-resolves')}
                          </p>
                          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                            {webhook.subscriptions.filter((item) => item.enabled).length} alert types · {webhook.consecutiveFailures} failures · {formatRepeat(webhook.repeatIntervalSeconds)}
                          </p>
                          {paused && (
                            <p className="mt-2 wrap-break-word text-sm text-amber-700 dark:text-amber-300">
                              Paused{webhook.pausedUntil ? ` until ${formatDate(webhook.pausedUntil)}` : ''}{webhook.pauseReason ? ` — ${webhook.pauseReason}` : ''}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="secondary" onClick={() => editWebhook(webhook)}>Edit</Button>
                          <Button size="sm" variant="secondary" onClick={() => void run('Preview rendered', async () => {
                            const response = await alertsApi.previewWebhook(webhook.id);
                            setPreview(response.data?.payload ?? null);
                          })}>Preview</Button>
                          <Button size="sm" variant="secondary" onClick={() => setConfirmation({ kind: 'test', webhook })}>
                            <Send aria-hidden="true" className="h-4 w-4" />
                            Test
                          </Button>
                          {paused ? (
                            <Button size="sm" variant="secondary" onClick={() => void run('Webhook resumed', async () => {
                              await alertsApi.resumeWebhook(webhook.id);
                            })}>
                              <Play aria-hidden="true" className="h-4 w-4" />
                              Resume
                            </Button>
                          ) : (
                            <Button size="sm" variant="secondary" onClick={() => setPauseTarget(webhook)}>
                              <Pause aria-hidden="true" className="h-4 w-4" />
                              Pause
                            </Button>
                          )}
                          <Button size="sm" variant="danger" onClick={() => setConfirmation({ kind: 'delete', webhook })} aria-label={`Delete ${webhook.name}`}>
                            <Trash2 aria-hidden="true" className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <p className="mt-4 rounded-lg border border-dashed border-gray-300 p-5 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300">
                No webhooks are configured. Add one, select alert types, and preview its payload before enabling it.
              </p>
            )}
          </section>
        </div>
      )}

      {activeTab === 'rules' && <TelemetryAlertRules />}

      {activeTab === 'policy' && (
        <section className="space-y-4">
            <h2 className="text-base font-semibold">Delivery policy</h2>
            <label className="flex items-center gap-3 text-sm">
              <input type="checkbox" checked={policy.alertsEnabled} className="accent-robin-orange"
                onChange={event => setPolicy({ ...policy, alertsEnabled: event.target.checked })} />
              Enable alert evaluation and delivery
            </label>
            <Input label="Instance name" maxLength={100} value={policy.alertInstanceName}
              onChange={event => setPolicy({ ...policy, alertInstanceName: event.target.value })} />
            <OperationsPolicyFields section="alerts" policy={policy}
              onChange={(key, value) => setPolicy({ ...policy, [key]: value })} />
            <div className="space-y-4">
              <Input
                label="Delivery retention (days)"
                type="number"
                min={1}
                max={365}
                value={deliveryRetentionDays}
                onChange={(event) => setDeliveryRetentionDays(Number(event.target.value) || 30)}
              />
              <Button variant="secondary" onClick={saveAlertPolicy} disabled={working}>
                Save policy
              </Button>
            </div>
        </section>
      )}

      {activeTab === 'deliveries' && (
        <section className="card overflow-hidden">
          <div className="p-5">
            <h2 className="text-base font-semibold">Webhook delivery history</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
              Recent webhook delivery attempts and bounded receiver errors. Automatic retries are included in the attempt count.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-gray-50 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300">
                <tr>
                  {['Created', 'Webhook', 'Service', 'Alert', 'Status', 'Attempts', 'Next action'].map((heading) => (
                    <th key={heading} scope="col" className="px-4 py-3 font-medium">{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {deliveries.map((delivery) => (
                  <tr key={delivery.id}>
                    <td className="whitespace-nowrap px-4 py-3">{formatDate(delivery.createdAt)}</td>
                    <td className="max-w-48 wrap-break-word px-4 py-3">{delivery.webhookName}</td>
                    <td className="max-w-48 wrap-break-word px-4 py-3">{delivery.serviceName}</td>
                    <td className="whitespace-nowrap px-4 py-3">{delivery.alertType.replace(/_/g, ' ')}</td>
                    <td className="px-4 py-3"><DeliveryStatus status={delivery.status} /></td>
                    <td className="px-4 py-3">{delivery.attempts}</td>
                    <td className="max-w-72 wrap-break-word px-4 py-3">
                      {delivery.nextAttemptAt ? `Retry ${formatDate(delivery.nextAttemptAt)}` : delivery.error ?? '—'}
                    </td>
                  </tr>
                ))}
                {!deliveries.length && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500">No deliveries yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {form && (
        <Modal isOpen title={form.id ? `Edit ${selectedWebhook?.name ?? 'destination'}` : 'Add destination'} onClose={() => setForm(null)}>
          <WebhookEditor form={form} catalog={catalog} setForm={setForm} working={working} onSave={save} />
        </Modal>
      )}

      {preview && (
        <Modal isOpen title="Network-free preview" onClose={() => setPreview(null)}>
          <p className="mb-3 text-sm text-gray-600 dark:text-gray-300">This payload was rendered locally and was not sent.</p>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-gray-950 p-4 text-xs text-gray-100">
            {JSON.stringify(preview, null, 2)}
          </pre>
        </Modal>
      )}

      {confirmation && (
        <Modal isOpen title={confirmation.kind === 'test' ? 'Send live test?' : 'Delete destination?'} onClose={() => setConfirmation(null)}>
          <p className="wrap-break-word text-sm text-gray-600 dark:text-gray-300">
            {confirmation.kind === 'test'
              ? `This sends a real webhook to ${confirmation.webhook.name}. Preview first if you only need to inspect the payload.`
              : `This permanently deletes ${confirmation.webhook.name} and cancels its pending deliveries.`}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmation(null)}>Cancel</Button>
            <Button variant={confirmation.kind === 'delete' ? 'danger' : 'primary'} onClick={confirmAction}>
              {confirmation.kind === 'test' ? 'Send live test' : 'Delete webhook'}
            </Button>
          </div>
        </Modal>
      )}

      {pauseTarget && (
        <Modal isOpen title={`Pause ${pauseTarget.name}`} onClose={() => setPauseTarget(null)}>
          <div className="space-y-4">
            <Input label="Resume at" name="pausedUntil" autoComplete="off" type="datetime-local" value={pauseUntil} onChange={(event) => setPauseUntil(event.target.value)} />
            <Input label="Reason" name="pauseReason" autoComplete="off" value={pauseReason} onChange={(event) => setPauseReason(event.target.value)} />
            <p className="text-sm text-gray-600 dark:text-gray-300">Leave the resume time empty to pause until you resume manually.</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setPauseTarget(null)}>Cancel</Button>
              <Button onClick={savePause}>Pause webhook</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function WebhookEditor({ form, catalog, setForm, working, onSave }: {
  form: WebhookForm;
  catalog: AlertCatalogEntry[];
  setForm: (value: WebhookForm) => void;
  working: boolean;
  onSave: () => void;
}) {
  const updateSubscription = (entry: AlertCatalogEntry, changes: Partial<AlertSubscription>) => {
    // A webhook saved before an alert type existed has no entry for it yet.
    const existing = form.subscriptions.some((subscription) => subscription.alertType === entry.key);
    setForm({
      ...form,
      subscriptions: existing
        ? form.subscriptions.map((subscription) => (
          subscription.alertType === entry.key ? { ...subscription, ...changes } : subscription
        ))
        : [...form.subscriptions, { alertType: entry.key, enabled: false, threshold: entry.defaultThreshold, ...changes }],
    });
  };
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Name" name="webhookName" autoComplete="off" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <label className="space-y-1">
          <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">Format</span>
          <select name="webhookFormat" autoComplete="off" className="input" value={form.adapter} onChange={(event) => setForm({ ...form, adapter: event.target.value as AlertWebhookAdapter })}>
            <option value="slack">Slack</option>
            <option value="generic">Generic JSON</option>
            <option value="sentry">Sentry</option>
          </select>
        </label>
      </div>
      <Input
        label={form.adapter === 'sentry'
          ? (form.id ? 'Replace Sentry DSN' : 'Sentry DSN')
          : (form.id ? 'Replace HTTPS webhook URL' : 'HTTPS webhook URL')}
        type="url"
        name="webhookUrl"
        autoComplete="off"
        value={form.webhookUrl}
        placeholder={form.id ? 'Leave empty to keep the stored value' : form.adapter === 'sentry' ? 'https://<key>@o<org>.ingest.sentry.io/<project>' : 'https://…'}
        onChange={(event) => setForm({ ...form, webhookUrl: event.target.value })}
      />
      {form.adapter === 'sentry' && (
        <fieldset className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
          <legend className="px-1 text-sm font-semibold">Resolve issues on recovery (optional)</legend>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Each alert becomes one Sentry issue. With an organization and an API token (scope <code>event:write</code>),
            recoveries resolve the issue; without them, Sentry's auto-resolve applies.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Organization slug" name="sentryOrg" autoComplete="off" value={form.sentryOrg} onChange={(event) => setForm({ ...form, sentryOrg: event.target.value })} />
            <Input
              label={form.hasSentryToken ? 'Replace API token' : 'API token'}
              type="password"
              name="sentryApiToken"
              autoComplete="new-password"
              value={form.sentryApiToken}
              placeholder={form.hasSentryToken ? 'Leave empty to keep the stored token' : ''}
              onChange={(event) => setForm({ ...form, sentryApiToken: event.target.value })}
            />
          </div>
          <Input
            label="API URL (optional)"
            type="url"
            name="sentryApiUrl"
            autoComplete="off"
            value={form.sentryApiUrl}
            placeholder="Derived from the DSN, for example https://us.sentry.io"
            onChange={(event) => setForm({ ...form, sentryApiUrl: event.target.value })}
          />
        </fieldset>
      )}
      <fieldset>
        <legend className="text-sm font-semibold">Alert types</legend>
        <div className="mt-2 grid gap-3">
          {catalog.map((entry) => {
            const subscription = form.subscriptions.find((item) => item.alertType === entry.key)
              ?? { alertType: entry.key, enabled: false, threshold: entry.defaultThreshold };
            return (
              <div key={entry.key} className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <label className="flex min-w-0 gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange"
                      checked={subscription.enabled}
                      onChange={(event) => updateSubscription(entry, { enabled: event.target.checked })}
                    />
                    <span>
                      <span className="block font-medium">{entry.label}</span>
                      <span className="block text-sm text-gray-600 dark:text-gray-300">{entry.description}</span>
                      <span className="block text-xs text-gray-500">Applies to {entry.serviceTypes.join(', ')}.</span>
                    </span>
                  </label>
                  {entry.defaultThreshold !== null && (
                    <label className="flex items-center gap-2 text-sm">
                      <span>Threshold</span>
                      <input
                        aria-label={`${entry.label} threshold`}
                        className="input w-28"
                        type="number"
                        name={`${entry.key}Threshold`}
                        min={entry.minimum ?? undefined}
                        max={entry.maximum ?? undefined}
                        value={subscription.threshold ?? entry.defaultThreshold}
                        onChange={(event) => updateSubscription(entry, { threshold: Number(event.target.value) })}
                      />
                      <span>{entry.unit}</span>
                    </label>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </fieldset>
      <fieldset>
        <legend className="text-sm font-semibold">Notification timing</legend>
        <div className="mt-2 grid gap-4 sm:grid-cols-2">
          <Input label="Consecutive failures" name="consecutiveFailures" autoComplete="off" type="number" min={1} max={20} value={form.consecutiveFailures} onChange={(event) => setForm({ ...form, consecutiveFailures: Number(event.target.value) })} />
          <Input label="Repeat interval (seconds)" name="repeatIntervalSeconds" autoComplete="off" type="number" min={300} value={form.repeatIntervalSeconds ?? ''} onChange={(event) => setForm({ ...form, repeatIntervalSeconds: event.target.value ? Number(event.target.value) : null })} />
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-5">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.notifyRecovery} onChange={(event) => setForm({ ...form, notifyRecovery: event.target.checked })} className="h-4 w-4 accent-robin-orange" />
          Send recovery notifications
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} className="h-4 w-4 accent-robin-orange" />
          Enable webhook
        </label>
      </div>
      <div className="flex justify-end">
        <Button disabled={working || !form.name || (!form.id && !form.webhookUrl)} onClick={onSave}>Save webhook</Button>
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: 'error' | 'success'; children: string }) {
  return (
    <div className={`rounded-lg border p-3 text-sm ${
      tone === 'error'
        ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300'
        : 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300'
    }`}>{children}</div>
  );
}

function DeliveryStatus({ status }: { status: AlertDelivery['status'] }) {
  const classes: Record<AlertDelivery['status'], string> = {
    pending: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200',
    processing: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200',
    accepted: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200',
    failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200',
    cancelled: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200',
    expired: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
  };
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${classes[status]}`}>{status.charAt(0).toUpperCase() + status.slice(1)}</span>;
}

function Pill({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-gray-100 px-3 py-1 text-gray-700 dark:bg-robin-gray-800 dark:text-gray-200">{children}</span>;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function formatRepeat(seconds: number | null): string {
  if (seconds === null) return 'no repeats';
  if (seconds % 3600 === 0) return `repeat every ${seconds / 3600}h`;
  return `repeat every ${seconds}s`;
}
