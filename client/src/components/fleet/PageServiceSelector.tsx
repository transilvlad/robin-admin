import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bug, Check, ChevronDown, Circle, Cylinder, DatabaseZap, Inbox, Mail, Server, ShieldAlert, Zap } from 'lucide-react';
import { fleetServicesApi } from '../../api/client';
import { useFeatures } from '../../context/FeaturesContext';
import { useServices } from '../../context/ServiceContext';
import type { FleetService, FleetServiceType, RobinInstance } from '../../types';

interface PageServiceSelectorProps {
  serviceType?: FleetServiceType;
  /** Offer only services whose setup supports this page's capability. */
  capability?: string;
}

export function PageServiceSelector({ serviceType = 'robin', capability }: PageServiceSelectorProps) {
  const { features } = useFeatures();
  const {
    isLoading,
    robinServices,
    rspamdServices,
    clamavServices,
    dovecotServices,
    postfixServices,
    redisServices,
    postgresServices,
    mariadbServices,
    selectedRobinService,
    selectedRspamdService,
    selectedClamavService,
    selectedDovecotService,
    selectedPostfixService,
    selectedRedisService,
    selectedPostgresService,
    selectedMariadbService,
    setSelectedRobinService,
    setSelectedRspamdService,
    setSelectedClamavService,
    setSelectedDovecotService,
    setSelectedPostfixService,
    setSelectedRedisService,
    setSelectedPostgresService,
    setSelectedMariadbService,
  } = useServices();
  const [isOpen, setIsOpen] = useState(false);
  const [healthStatus, setHealthStatus] = useState<Record<string, boolean>>({});
  const dropdownRef = useRef<HTMLDivElement>(null);

  const typeServices = useMemo(() => {
    if (serviceType === 'rspamd') {
      return rspamdServices;
    }
    if (serviceType === 'clamav') {
      return clamavServices;
    }
    if (serviceType === 'dovecot') {
      return dovecotServices;
    }
    if (serviceType === 'postfix') {
      return postfixServices;
    }
    if (serviceType === 'redis') {
      return redisServices;
    }
    if (serviceType === 'postgres') {
      return postgresServices;
    }
    if (serviceType === 'mariadb') {
      return mariadbServices;
    }
    return robinServices;
  }, [clamavServices, dovecotServices, mariadbServices, postfixServices, postgresServices, redisServices, robinServices, rspamdServices, serviceType]);
  const enabledServices = useMemo(() => {
    if (!capability || !features.capabilities) return typeServices;
    const capable = new Set((features.capabilities?.services ?? [])
      .filter((entry) => entry.features[capability]?.available)
      .map((entry) => entry.serviceId));
    return typeServices.filter((service) => capable.has(service.serviceId));
  }, [capability, features.capabilities, typeServices]);
  const selectedService = serviceType === 'rspamd'
    ? selectedRspamdService
    : serviceType === 'clamav'
      ? selectedClamavService
      : serviceType === 'dovecot'
        ? selectedDovecotService
        : serviceType === 'postfix'
          ? selectedPostfixService
          : serviceType === 'redis'
            ? selectedRedisService
            : serviceType === 'postgres'
              ? selectedPostgresService
              : serviceType === 'mariadb'
                ? selectedMariadbService
                : selectedRobinService;
  const title = serviceType === 'rspamd'
    ? 'Select Rspamd service'
    : serviceType === 'clamav'
      ? 'Select ClamAV service'
      : serviceType === 'dovecot'
        ? 'Select Dovecot service'
        : serviceType === 'postfix'
          ? 'Select Postfix service'
          : serviceType === 'redis'
            ? 'Select Redis service'
            : serviceType === 'postgres'
              ? 'Select Postgres service'
              : serviceType === 'mariadb'
                ? 'Select MariaDB service'
                : 'Select Robin service';
  const Icon = serviceType === 'rspamd'
    ? ShieldAlert
    : serviceType === 'clamav'
      ? Bug
      : serviceType === 'dovecot'
        ? Inbox
        : serviceType === 'postfix'
          ? Mail
          : serviceType === 'redis'
            ? Zap
            : serviceType === 'postgres'
              ? Cylinder
              : serviceType === 'mariadb'
                ? DatabaseZap
                : Server;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const checkHealth = async (serviceId: string) => {
    try {
      const response = await fleetServicesApi.health(serviceId);
      setHealthStatus((current) => ({
        ...current,
        [serviceId]: response.data?.healthy ?? false,
      }));
    } catch {
      setHealthStatus((current) => ({ ...current, [serviceId]: false }));
    }
  };

  const handleOpen = () => {
    setIsOpen((current) => !current);
    enabledServices.forEach((service) => {
      void checkHealth(service.serviceId);
    });
  };

  const handleSelect = useCallback((service: FleetService) => {
    if (serviceType === 'rspamd') {
      setSelectedRspamdService(service);
    } else if (serviceType === 'clamav') {
      setSelectedClamavService(service);
    } else if (serviceType === 'dovecot') {
      setSelectedDovecotService(service);
    } else if (serviceType === 'postfix') {
      setSelectedPostfixService(service);
    } else if (serviceType === 'redis') {
      setSelectedRedisService(service);
    } else if (serviceType === 'postgres') {
      setSelectedPostgresService(service);
    } else if (serviceType === 'mariadb') {
      setSelectedMariadbService(service);
    } else {
      setSelectedRobinService(service as RobinInstance);
    }
    setIsOpen(false);
  }, [serviceType, setSelectedClamavService, setSelectedDovecotService, setSelectedMariadbService, setSelectedPostfixService, setSelectedPostgresService, setSelectedRedisService, setSelectedRobinService, setSelectedRspamdService]);

  // The selection is shared across a type's pages; on a page the selected
  // service can't support, switch to one that can.
  useEffect(() => {
    if (!capability || enabledServices.length === 0) return;
    if (!enabledServices.some((service) => service.serviceId === selectedService?.serviceId)) {
      handleSelect(enabledServices[0]);
    }
  }, [capability, enabledServices, handleSelect, selectedService?.serviceId]);

  if (isLoading) {
    return <div className="h-8 w-32 animate-pulse rounded-sm bg-gray-100 dark:bg-gray-800" />;
  }

  if (enabledServices.length === 0) {
    return (
      <div className="flex items-center gap-1.5 rounded-sm bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
        <Icon className="h-3 w-3" />
        <span>{serviceType === 'rspamd' ? 'No Rspamd services' : serviceType === 'clamav' ? 'No ClamAV services' : serviceType === 'dovecot' ? 'No Dovecot services' : serviceType === 'postfix' ? 'No Postfix services' : serviceType === 'redis' ? 'No Redis services' : serviceType === 'postgres' ? 'No Postgres services' : serviceType === 'mariadb' ? 'No MariaDB services' : 'No Robin services'}</span>
      </div>
    );
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={handleOpen}
        className="flex items-center gap-1.5 rounded-sm bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
        aria-label={title}
      >
        <Icon className="h-3 w-3" />
        <span>{selectedService?.name ?? title}</span>
        <span className="rounded-sm bg-white/70 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500 dark:bg-robin-gray-700 dark:text-gray-300">
          {enabledServices.length}
        </span>
        <ChevronDown className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full z-50 mt-1 max-h-64 min-w-[220px] overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
          <div className="border-b border-gray-200 px-3 py-2 text-xs font-semibold text-gray-500 dark:border-gray-700 dark:text-gray-400">
            {title}
          </div>
          {enabledServices.map((service) => {
            const isSelected = service.serviceId === selectedService?.serviceId;
            const isHealthy = healthStatus[service.serviceId];

            return (
              <button
                key={service.serviceId}
                onClick={() => handleSelect(service)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-gray-100 dark:hover:bg-gray-700 ${
                  isSelected
                    ? 'bg-robin-orange/10 text-robin-orange'
                    : 'text-gray-700 dark:text-gray-300'
                }`}
              >
                <Circle
                  className={`h-2 w-2 shrink-0 ${
                    isHealthy === undefined
                      ? 'text-gray-400'
                      : isHealthy
                        ? 'fill-green-500 text-green-500'
                        : 'fill-red-500 text-red-500'
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{service.name}</div>
                  <div className="truncate text-xs text-gray-500 dark:text-gray-400">{service.serviceId}</div>
                </div>
                {isSelected && <Check className="h-4 w-4 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
