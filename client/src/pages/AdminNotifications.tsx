import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { ApiError, emailApi } from '../api/client';
import { Button } from '../components/ui/Button';
import { AdminNotice, AdminStat, SettingsCard, StatusBadge } from '../components/administration/AdminPrimitives';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import type { AdminEmailSubscription } from '../types/email';

export function AdminNotificationsPage({ embedded = false }: { embedded?: boolean }) {
  const [subscriptions, setSubscriptions] = useState<AdminEmailSubscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await emailApi.notificationRecipients();
      setSubscriptions(response.data ?? []);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load notification recipients');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  const save = (subscription: AdminEmailSubscription) => {
    void run('Notification preferences saved', async () => {
      await emailApi.updateAdminSubscription(subscription.adminId, {
        monitoringIssueOpened: subscription.monitoringIssueOpened,
        monitoringIssueRecovered: subscription.monitoringIssueRecovered,
        statusPageReports: subscription.statusPageReports,
        emailDeliveryFailure: subscription.emailDeliveryFailure,
      });
    });
  };

  const stats = useMemo(() => ({
    admins: subscriptions.filter((subscription) => !subscription.disabled).length,
    active: subscriptions.filter((subscription) => (
      !subscription.disabled
      && (subscription.monitoringIssueOpened || subscription.monitoringIssueRecovered || subscription.statusPageReports || subscription.emailDeliveryFailure)
    )).length,
    monitoring: subscriptions.filter((subscription) => !subscription.disabled && (subscription.monitoringIssueOpened || subscription.monitoringIssueRecovered)).length,
    status: subscriptions.filter((subscription) => !subscription.disabled && subscription.statusPageReports).length,
    emailFailures: subscriptions.filter((subscription) => !subscription.disabled && subscription.emailDeliveryFailure).length,
  }), [subscriptions]);

  if (loading) {
    return <div className="flex justify-center py-10"><Spinner className="text-robin-orange" /></div>;
  }

  return (
    <div className="space-y-6">
      {!embedded && (
        <PageHeader
          icon={appIcons.notifications}
          title="Notifications"
          description="Central admin recipient preferences for alert and operational email notifications."
          actions={<Button variant="secondary" onClick={() => void load()}><RefreshCw aria-hidden="true" className="h-4 w-4" />Refresh</Button>}
        />
      )}
      {embedded && (
        <div className="flex justify-end">
          <Button variant="secondary" onClick={() => void load()}><RefreshCw aria-hidden="true" className="h-4 w-4" />Refresh</Button>
        </div>
      )}

      <div aria-live="polite" className="space-y-2">
        {error && <AdminNotice tone="error">{error}</AdminNotice>}
        {message && <AdminNotice tone="success">{message}</AdminNotice>}
      </div>

      <section className="grid gap-4 md:grid-cols-5">
        <AdminStat label="Admins" value={stats.admins} />
        <AdminStat label="With any opt-in" value={stats.active} tone={stats.active ? 'success' : 'neutral'} />
        <AdminStat label="Monitoring" value={stats.monitoring} />
        <AdminStat label="Status incidents" value={stats.status} />
        <AdminStat label="Email failures" value={stats.emailFailures} />
      </section>

      <SettingsCard
        title="Admin email recipients"
        description="Per-admin opt-ins for operational email notifications."
      >
        <AdminEmailSubscriptions subscriptions={subscriptions} save={save} working={working} />
      </SettingsCard>
    </div>
  );
}

function AdminEmailSubscriptions({ subscriptions, save, working }: { subscriptions: AdminEmailSubscription[]; save: (subscription: AdminEmailSubscription) => void; working: boolean }) {
  const [drafts, setDrafts] = useState<Record<number, AdminEmailSubscription>>(() => Object.fromEntries(subscriptions.map((sub) => [sub.adminId, sub])));
  useEffect(() => {
    setDrafts(Object.fromEntries(subscriptions.map((sub) => [sub.adminId, sub])));
  }, [subscriptions]);

  const update = (adminId: number, patch: Partial<AdminEmailSubscription>) => {
    setDrafts((current) => ({ ...current, [adminId]: { ...current[adminId], ...patch } }));
  };

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-gray-50 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300">
          <tr>
            {['Admin', 'Status', 'Monitoring opened', 'Monitoring recovered', 'Status updates', 'Email failures', 'Actions'].map((heading) => (
              <th key={heading} className="px-4 py-3 font-medium">{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {subscriptions.map((subscription) => {
            const draft = drafts[subscription.adminId] ?? subscription;
            return (
              <tr key={subscription.adminId} className={subscription.disabled ? 'opacity-60' : ''}>
                <td className="px-4 py-3">
                  <div className="font-medium">{subscription.adminName}</div>
                  <div className="text-xs text-gray-500">{subscription.adminEmail}</div>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge tone={subscription.disabled ? 'neutral' : 'success'}>
                    {subscription.disabled ? 'Disabled' : 'Active'}
                  </StatusBadge>
                </td>
                {(['monitoringIssueOpened', 'monitoringIssueRecovered', 'statusPageReports', 'emailDeliveryFailure'] as const).map((key) => (
                  <td key={key} className="px-4 py-3">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-robin-orange"
                      checked={draft[key]}
                      disabled={subscription.disabled}
                      onChange={(event) => update(subscription.adminId, { [key]: event.target.checked })}
                    />
                  </td>
                ))}
                <td className="px-4 py-3">
                  <Button size="sm" variant="secondary" disabled={working || subscription.disabled} onClick={() => save(draft)}>Save</Button>
                </td>
              </tr>
            );
          })}
          {!subscriptions.length && (
            <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500">No admins found.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
