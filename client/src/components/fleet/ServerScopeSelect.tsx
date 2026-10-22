import { useServices } from '../../context/ServiceContext';
import type { FleetServiceType } from '../../types';

/**
 * Server-scope selector for a service Config page — mirrors Robin's config
 * editor: "Default (base)" is the shared config layered under every server of
 * this tag (service_type); each server can carry its own override. Picking a
 * scope decides which config the page reads and saves.
 */
export function ServerScopeSelect({
  serviceType,
  value,
  onChange,
}: {
  serviceType: FleetServiceType;
  value: string;
  onChange: (scopeId: string) => void;
}) {
  const services = useServices();
  const list = serviceType === 'rspamd' ? services.rspamdServices
    : serviceType === 'clamav' ? services.clamavServices
      : serviceType === 'cyrus' ? services.cyrusServices : serviceType === 'dovecot' ? services.dovecotServices
    : serviceType === 'postfix' ? services.postfixServices
    : serviceType === 'redis' ? services.redisServices
    : serviceType === 'postgres' ? services.postgresServices
    : serviceType === 'mariadb' ? services.mariadbServices
    : services.robinServices;

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-gray-500 dark:text-gray-400">Server</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="input py-1.5"
      >
        <option value="default">Default (base)</option>
        {(list ?? []).map((s) => (
          <option key={s.serviceId} value={s.serviceId}>
            {s.name} ({s.serviceId})
          </option>
        ))}
      </select>
    </label>
  );
}
