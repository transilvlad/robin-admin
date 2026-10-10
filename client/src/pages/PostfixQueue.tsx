import { useState } from 'react';
import { Send } from 'lucide-react';
import { ApiError, postfixApi } from '../api/client';
import { PageServiceSelector } from '../components/fleet/PageServiceSelector';
import { PostfixQueuePanel } from '../components/fleet/PostfixQueuePanel';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/PageHeader';
import { appIcons } from '../constants/appIcons';
import { useServices } from '../context/ServiceContext';
import { useServiceCapabilities } from '../context/FeaturesContext';

/**
 * Postfix queue workspace (the Postfix counterpart of Robin Queue). Every
 * action runs on the host through the selected service's robin-agent.
 */
export function PostfixQueuePage() {
  const { selectedPostfixService } = useServices();
  const serviceId = selectedPostfixService?.serviceId;
  const { can } = useServiceCapabilities(serviceId);
  const [isFlushing, setIsFlushing] = useState(false);
  const [flushed, setFlushed] = useState(0);
  const [error, setError] = useState('');

  const flush = async () => {
    if (!serviceId) return;
    setIsFlushing(true);
    setError('');
    try {
      await postfixApi.flushQueue(serviceId);
      setFlushed((n) => n + 1); // remount the panel so it re-lists the queue
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Failed to flush the queue');
    } finally {
      setIsFlushing(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.postfixQueue}
        title="Postfix queue"
        description={serviceId
          ? <>Inspect, hold, release, requeue, deliver, and delete messages queued on <strong>{selectedPostfixService?.name ?? serviceId}</strong>.</>
          : 'Select an enabled Postfix service from Fleet before opening the queue.'}
        actions={(
          <>
            <PageServiceSelector serviceType="postfix" capability="postfixQueue" />
            {can('flush') && (
              <Button variant="secondary" onClick={() => void flush()} disabled={isFlushing}>
                <Send className={`h-4 w-4 ${isFlushing ? 'animate-pulse' : ''}`} />
                Flush queue
              </Button>
            )}
          </>
        )}
      />

      {error && <div className="rounded-sm border border-red-200 bg-red-50 p-3 text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">{error}</div>}

      {serviceId && can('postfixQueue') ? (
        <PostfixQueuePanel key={`${serviceId}:${flushed}`} serviceId={serviceId} />
      ) : (
        <div className="rounded-lg border border-dashed border-gray-300 px-6 py-10 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
          No enabled Postfix service is currently selected.
        </div>
      )}
    </div>
  );
}
