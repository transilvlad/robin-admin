import { PageServiceSelector } from '../components/fleet/PageServiceSelector';
import { ServiceLogsPanel } from '../components/fleet/ServiceLogsPanel';
import { PageHeader } from '../components/ui/PageHeader';
import { appIcons } from '../constants/appIcons';
import { getServiceTypeMeta, type FleetServiceType } from '../constants/serviceTypes';
import { useServices } from '../context/ServiceContext';

/**
 * Generic recent-logs page for a co-located (or endpoint-backed) fleet service.
 * Reachable only when logs are actually readable — the sidebar item is gated on
 * `features.logsAvailable[serviceType]`.
 */
export function ServiceLogsPage({ serviceType }: { serviceType: FleetServiceType }) {
  const services = useServices();
  const selected = serviceType === 'robin' ? services.selectedRobinService
    : serviceType === 'rspamd' ? services.selectedRspamdService
    : serviceType === 'clamav' ? services.selectedClamavService
    : serviceType === 'dovecot' ? services.selectedDovecotService
    : serviceType === 'postfix' ? services.selectedPostfixService
    : serviceType === 'redis' ? services.selectedRedisService
    : serviceType === 'postgres' ? services.selectedPostgresService
    : serviceType === 'mariadb' ? services.selectedMariadbService
    : null;
  const meta = getServiceTypeMeta(serviceType);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.logs}
        title={`${meta.label} Logs`}
        description={<>Recent log output for <strong>{selected?.name ?? 'the selected service'}</strong>.</>}
        actions={<PageServiceSelector serviceType={serviceType} capability="logs" />}
      />
      {selected ? (
        <ServiceLogsPanel serviceType={serviceType} serviceId={selected.serviceId} />
      ) : (
        <div className="rounded-lg border border-dashed border-gray-300 px-6 py-10 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
          No enabled {meta.label} service is currently selected.
        </div>
      )}
    </div>
  );
}
