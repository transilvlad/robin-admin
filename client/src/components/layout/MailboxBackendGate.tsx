import { useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { useFeatures } from '../../context/FeaturesContext';
import { MailboxTabs } from './MailboxTabs';
import { PageHeader } from '../ui/PageHeader';
import { appIcons } from '../../constants/appIcons';

const requirements = {
  users: 'A public.users table with id, email and password columns is required.',
  aliases: 'A public.aliases table with id, source and destination columns is required.',
  autoAliases: 'A public.auto_aliases table with id, source and destination columns is required.',
};

export function MailboxBackendGate({ section, children }: { section: keyof typeof requirements; children: ReactNode }) {
  const { features, refresh, isLoading } = useFeatures();
  const [checking, setChecking] = useState(false);
  const checkAgain = async () => {
    setChecking(true);
    try { await refresh(); } finally { setChecking(false); }
  };
  if (features[section]) return <>{children}</>;
  return <div className="space-y-6">
    <PageHeader title="Mailboxes" icon={appIcons.users} />
    <MailboxTabs />
    <section aria-label="Mailbox backend" className="space-y-3 border-t border-gray-200 pt-5 dark:border-robin-gray-700">
      <h2 className="text-lg font-semibold">Backend not configured</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400">{requirements[section]}</p>
      <button type="button" className="btn btn-secondary" onClick={() => void checkAgain()} disabled={isLoading || checking}>
        <RefreshCw className="h-4 w-4" aria-hidden="true" /> Check again
      </button>
    </section>
  </div>;
}
