import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fleetServicesApi } from '../api/client';
import { useAuth } from './AuthContext';
import type { FleetService, FleetServiceType, RobinInstance } from '../types';

type ServiceSelectionState = Record<FleetServiceType, string | null>;

interface ServiceContextType {
  services: FleetService[];
  robinServices: RobinInstance[];
  rspamdServices: FleetService[];
  clamavServices: FleetService[];
  dovecotServices: FleetService[];
  postfixServices: FleetService[];
  redisServices: FleetService[];
  postgresServices: FleetService[];
  mariadbServices: FleetService[];
  selectedRobinService: RobinInstance | null;
  selectedRspamdService: FleetService | null;
  selectedClamavService: FleetService | null;
  selectedDovecotService: FleetService | null;
  selectedPostfixService: FleetService | null;
  selectedRedisService: FleetService | null;
  selectedPostgresService: FleetService | null;
  selectedMariadbService: FleetService | null;
  isLoading: boolean;
  refreshServices: () => Promise<void>;
  setSelectedService: (serviceType: FleetServiceType, service: FleetService) => void;
  setSelectedRobinService: (service: RobinInstance) => void;
  setSelectedRspamdService: (service: FleetService) => void;
  setSelectedClamavService: (service: FleetService) => void;
  setSelectedDovecotService: (service: FleetService) => void;
  setSelectedPostfixService: (service: FleetService) => void;
  setSelectedRedisService: (service: FleetService) => void;
  setSelectedPostgresService: (service: FleetService) => void;
  setSelectedMariadbService: (service: FleetService) => void;
}

const ServiceContext = createContext<ServiceContextType | undefined>(undefined);

const STORAGE_KEYS: Record<FleetServiceType, string> = {
  robin: 'robin-admin-service-robin',
  rspamd: 'robin-admin-service-rspamd',
  clamav: 'robin-admin-service-clamav',
  dovecot: 'robin-admin-service-dovecot',
  postfix: 'robin-admin-service-postfix',
  redis: 'robin-admin-service-redis',
  postgres: 'robin-admin-service-postgres',
  mariadb: 'robin-admin-service-mariadb',
};

function toRobinInstance(service: FleetService): RobinInstance {
  return {
    ...service,
    serviceType: 'robin',
    apiUrl: service.apiUrl ?? '',
    metricsUrl: service.metricsUrl ?? null,
  };
}

function byCreatedAtAscending<T extends FleetService>(left: T, right: T): number {
  const leftTime = Date.parse(left.createdAt || '');
  const rightTime = Date.parse(right.createdAt || '');
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.serviceId.localeCompare(right.serviceId);
}

function pickSavedService<T extends FleetService>(services: T[], serviceType: FleetServiceType): T | null {
  if (services.length === 0) {
    localStorage.removeItem(STORAGE_KEYS[serviceType]);
    return null;
  }

  const savedId = localStorage.getItem(STORAGE_KEYS[serviceType]);
  const saved = services.find((service) => service.serviceId === savedId);
  const selected = saved ?? services[0];
  localStorage.setItem(STORAGE_KEYS[serviceType], selected.serviceId);
  return selected;
}

export function ServiceProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const [services, setServices] = useState<FleetService[]>([]);
  const [selectedIds, setSelectedIds] = useState<ServiceSelectionState>({
    robin: null,
    rspamd: null,
    clamav: null,
    dovecot: null,
    postfix: null,
    redis: null,
    postgres: null,
    mariadb: null,
  });
  const [isLoading, setIsLoading] = useState(true);
  const refreshGeneration = useRef(0);

  const robinServices = useMemo(
    () => services
      .filter((service): service is FleetService & { serviceType: 'robin' } => service.serviceType === 'robin')
      .sort(byCreatedAtAscending)
      .map(toRobinInstance),
    [services],
  );
  const rspamdServices = useMemo(
    () => services.filter((service) => service.serviceType === 'rspamd').sort(byCreatedAtAscending),
    [services],
  );
  const clamavServices = useMemo(
    () => services.filter((service) => service.serviceType === 'clamav').sort(byCreatedAtAscending),
    [services],
  );
  const dovecotServices = useMemo(
    () => services.filter((service) => service.serviceType === 'dovecot').sort(byCreatedAtAscending),
    [services],
  );
  const postfixServices = useMemo(
    () => services.filter((service) => service.serviceType === 'postfix').sort(byCreatedAtAscending),
    [services],
  );
  const redisServices = useMemo(
    () => services.filter((service) => service.serviceType === 'redis').sort(byCreatedAtAscending),
    [services],
  );
  const postgresServices = useMemo(
    () => services.filter((service) => service.serviceType === 'postgres').sort(byCreatedAtAscending),
    [services],
  );
  const mariadbServices = useMemo(
    () => services.filter((service) => service.serviceType === 'mariadb').sort(byCreatedAtAscending),
    [services],
  );

  const setSelectedService = useCallback((serviceType: FleetServiceType, service: FleetService) => {
    setSelectedIds((current) => ({
      ...current,
      [serviceType]: service.serviceId,
    }));
    localStorage.setItem(STORAGE_KEYS[serviceType], service.serviceId);
  }, []);

  const setSelectedRobinService = useCallback((service: RobinInstance) => {
    setSelectedService('robin', service);
  }, [setSelectedService]);

  const setSelectedRspamdService = useCallback((service: FleetService) => {
    setSelectedService('rspamd', service);
  }, [setSelectedService]);

  const setSelectedClamavService = useCallback((service: FleetService) => {
    setSelectedService('clamav', service);
  }, [setSelectedService]);

  const setSelectedDovecotService = useCallback((service: FleetService) => {
    setSelectedService('dovecot', service);
  }, [setSelectedService]);

  const setSelectedPostfixService = useCallback((service: FleetService) => {
    setSelectedService('postfix', service);
  }, [setSelectedService]);

  const setSelectedRedisService = useCallback((service: FleetService) => {
    setSelectedService('redis', service);
  }, [setSelectedService]);

  const setSelectedPostgresService = useCallback((service: FleetService) => {
    setSelectedService('postgres', service);
  }, [setSelectedService]);

  const setSelectedMariadbService = useCallback((service: FleetService) => {
    setSelectedService('mariadb', service);
  }, [setSelectedService]);

  const refreshServices = useCallback(async () => {
    const generation = ++refreshGeneration.current;

    if (!isAuthenticated) {
      setServices([]);
      setSelectedIds({ robin: null, rspamd: null, clamav: null, dovecot: null, postfix: null, redis: null, postgres: null, mariadb: null });
      setIsLoading(isAuthLoading);
      return;
    }

    setIsLoading(true);
    try {
      const response = await fleetServicesApi.listEnabled();
      if (generation !== refreshGeneration.current) return;

      const nextServices = [...(response.data ?? [])].sort(byCreatedAtAscending);
      setServices(nextServices);

      const nextRobin = pickSavedService(
        nextServices.filter((service): service is FleetService & { serviceType: 'robin' } => service.serviceType === 'robin'),
        'robin',
      );
      const nextRspamd = pickSavedService(
        nextServices.filter((service) => service.serviceType === 'rspamd'),
        'rspamd',
      );
      const nextClamav = pickSavedService(
        nextServices.filter((service) => service.serviceType === 'clamav'),
        'clamav',
      );
      const nextDovecot = pickSavedService(
        nextServices.filter((service) => service.serviceType === 'dovecot'),
        'dovecot',
      );
      const nextPostfix = pickSavedService(
        nextServices.filter((service) => service.serviceType === 'postfix'),
        'postfix',
      );
      const nextRedis = pickSavedService(
        nextServices.filter((service) => service.serviceType === 'redis'),
        'redis',
      );
      const nextPostgres = pickSavedService(
        nextServices.filter((service) => service.serviceType === 'postgres'),
        'postgres',
      );
      const nextMariadb = pickSavedService(
        nextServices.filter((service) => service.serviceType === 'mariadb'),
        'mariadb',
      );

      setSelectedIds({
        robin: nextRobin?.serviceId ?? null,
        rspamd: nextRspamd?.serviceId ?? null,
        clamav: nextClamav?.serviceId ?? null,
        dovecot: nextDovecot?.serviceId ?? null,
        postfix: nextPostfix?.serviceId ?? null,
        redis: nextRedis?.serviceId ?? null,
        postgres: nextPostgres?.serviceId ?? null,
        mariadb: nextMariadb?.serviceId ?? null,
      });
    } catch (error) {
      if (generation !== refreshGeneration.current) return;
      console.error('Failed to fetch fleet services:', error);
    } finally {
      if (generation === refreshGeneration.current) {
        setIsLoading(false);
      }
    }
  }, [isAuthLoading, isAuthenticated]);

  useEffect(() => {
    void refreshServices();
  }, [refreshServices]);

  useEffect(() => {
    const nextRobin = robinServices.find((service) => service.serviceId === selectedIds.robin) ?? robinServices[0] ?? null;
    const nextRspamd = rspamdServices.find((service) => service.serviceId === selectedIds.rspamd) ?? rspamdServices[0] ?? null;
    const nextClamav = clamavServices.find((service) => service.serviceId === selectedIds.clamav) ?? clamavServices[0] ?? null;
    const nextDovecot = dovecotServices.find((service) => service.serviceId === selectedIds.dovecot) ?? dovecotServices[0] ?? null;
    const nextPostfix = postfixServices.find((service) => service.serviceId === selectedIds.postfix) ?? postfixServices[0] ?? null;
    const nextRedis = redisServices.find((service) => service.serviceId === selectedIds.redis) ?? redisServices[0] ?? null;
    const nextPostgres = postgresServices.find((service) => service.serviceId === selectedIds.postgres) ?? postgresServices[0] ?? null;
    const nextMariadb = mariadbServices.find((service) => service.serviceId === selectedIds.mariadb) ?? mariadbServices[0] ?? null;

    const desired = {
      robin: nextRobin?.serviceId ?? null,
      rspamd: nextRspamd?.serviceId ?? null,
      clamav: nextClamav?.serviceId ?? null,
      dovecot: nextDovecot?.serviceId ?? null,
      postfix: nextPostfix?.serviceId ?? null,
      redis: nextRedis?.serviceId ?? null,
      postgres: nextPostgres?.serviceId ?? null,
      mariadb: nextMariadb?.serviceId ?? null,
    };

    if (
      desired.robin !== selectedIds.robin
      || desired.rspamd !== selectedIds.rspamd
      || desired.clamav !== selectedIds.clamav
      || desired.dovecot !== selectedIds.dovecot
      || desired.postfix !== selectedIds.postfix
      || desired.redis !== selectedIds.redis
      || desired.postgres !== selectedIds.postgres
      || desired.mariadb !== selectedIds.mariadb
    ) {
      setSelectedIds(desired);
    }

    for (const [serviceType, serviceId] of Object.entries(desired) as Array<[FleetServiceType, string | null]>) {
      if (serviceId) {
        localStorage.setItem(STORAGE_KEYS[serviceType], serviceId);
      } else {
        localStorage.removeItem(STORAGE_KEYS[serviceType]);
      }
    }
  }, [clamavServices, dovecotServices, mariadbServices, postfixServices, postgresServices, redisServices, robinServices, rspamdServices, selectedIds.clamav, selectedIds.dovecot, selectedIds.mariadb, selectedIds.postfix, selectedIds.postgres, selectedIds.redis, selectedIds.robin, selectedIds.rspamd]);

  const selectedRobinService = useMemo(
    () => robinServices.find((service) => service.serviceId === selectedIds.robin) ?? robinServices[0] ?? null,
    [robinServices, selectedIds.robin],
  );
  const selectedRspamdService = useMemo(
    () => rspamdServices.find((service) => service.serviceId === selectedIds.rspamd) ?? rspamdServices[0] ?? null,
    [rspamdServices, selectedIds.rspamd],
  );
  const selectedClamavService = useMemo(
    () => clamavServices.find((service) => service.serviceId === selectedIds.clamav) ?? clamavServices[0] ?? null,
    [clamavServices, selectedIds.clamav],
  );
  const selectedDovecotService = useMemo(
    () => dovecotServices.find((service) => service.serviceId === selectedIds.dovecot) ?? dovecotServices[0] ?? null,
    [dovecotServices, selectedIds.dovecot],
  );
  const selectedPostfixService = useMemo(
    () => postfixServices.find((service) => service.serviceId === selectedIds.postfix) ?? postfixServices[0] ?? null,
    [postfixServices, selectedIds.postfix],
  );
  const selectedRedisService = useMemo(
    () => redisServices.find((service) => service.serviceId === selectedIds.redis) ?? redisServices[0] ?? null,
    [redisServices, selectedIds.redis],
  );
  const selectedPostgresService = useMemo(
    () => postgresServices.find((service) => service.serviceId === selectedIds.postgres) ?? postgresServices[0] ?? null,
    [postgresServices, selectedIds.postgres],
  );
  const selectedMariadbService = useMemo(
    () => mariadbServices.find((service) => service.serviceId === selectedIds.mariadb) ?? mariadbServices[0] ?? null,
    [mariadbServices, selectedIds.mariadb],
  );

  const value = useMemo<ServiceContextType>(() => ({
    services,
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
    isLoading,
    refreshServices,
    setSelectedService,
    setSelectedRobinService,
    setSelectedRspamdService,
    setSelectedClamavService,
    setSelectedDovecotService,
    setSelectedPostfixService,
    setSelectedRedisService,
    setSelectedPostgresService,
    setSelectedMariadbService,
  }), [
    services,
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
    isLoading,
    refreshServices,
    setSelectedService,
    setSelectedRobinService,
    setSelectedRspamdService,
    setSelectedClamavService,
    setSelectedDovecotService,
    setSelectedPostfixService,
    setSelectedRedisService,
    setSelectedPostgresService,
    setSelectedMariadbService,
  ]);

  return (
    <ServiceContext.Provider value={value}>
      {children}
    </ServiceContext.Provider>
  );
}

export function useServices() {
  const context = useContext(ServiceContext);
  if (!context) {
    throw new Error('useServices must be used within a ServiceProvider');
  }
  return context;
}
