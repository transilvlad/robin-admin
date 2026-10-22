/**
 * Features context - tracks available database tables/features.
 */

import { createContext, useCallback, useContext, useState, useEffect, type ReactNode } from 'react';
import { dashboardApi, fleetCapabilitiesApi } from '../api/client';
import type { Features, FleetServiceType } from '../types';

interface FeaturesContextType {
  features: Features;
  isLoading: boolean;
  /** The first capabilities request has answered, successfully or not. */
  capabilitiesSettled: boolean;
  refresh: () => Promise<void>;
}

const defaultFeatures: Features = {
  mailboxes: false,
  users: false,
  aliases: false,
  autoAliases: false,
  queue: false,
  dmarc: false,
  reporting: false,
  robin: false,
  fleet: false,
  monitoring: false,
  telemetry: false,
  modules: false,
  robinConfig: false,
  rspamd: false,
  clamav: false,
  dovecot: false,
  cyrus: false,
  postfix: false,
  redis: false,
  postgres: false,
  mariadb: false,
  fleetEnabled: false,
  monitoringEnabled: false,
  telemetryEnabled: false,
  telemetryStoreConfigured: false,
  modulesEnabled: false,
  fleetServices: {
    total: 0,
    robin: 0,
    rspamd: 0,
    clamav: 0,
    dovecot: 0,
    cyrus: 0,
    postfix: 0,
    redis: 0,
    postgres: 0,
    mariadb: 0,
  },
};

const FeaturesContext = createContext<FeaturesContextType | undefined>(undefined);
const FEATURES_CACHE_KEY = 'robin-admin-features';

function mergeFeatures(nextFeatures: Partial<Features>): Features {
  return {
    ...defaultFeatures,
    ...nextFeatures,
    fleetServices: {
      ...defaultFeatures.fleetServices,
      ...nextFeatures.fleetServices,
    },
  };
}

function loadCachedFeatures(): Features {
  try {
    const cached = localStorage.getItem(FEATURES_CACHE_KEY);
    if (!cached) {
      return defaultFeatures;
    }

    return mergeFeatures(JSON.parse(cached) as Partial<Features>);
  } catch {
    return defaultFeatures;
  }
}

function storeCachedFeatures(features: Features): void {
  try {
    localStorage.setItem(FEATURES_CACHE_KEY, JSON.stringify(features));
  } catch {
    // Ignore storage failures; the network response still updates state.
  }
}

export function FeaturesProvider({ children }: { children: ReactNode }) {
  const [features, setFeatures] = useState<Features>(loadCachedFeatures);
  const [isLoading, setIsLoading] = useState(true);
  const [capabilitiesSettled, setCapabilitiesSettled] = useState(false);

  // Periodic refreshes mostly return what we already have; keeping the same
  // object then spares every consumer a re-render.
  const updateFeatures = useCallback((update: (current: Features) => Features) => {
    setFeatures((current) => {
      const merged = update(current);
      if (JSON.stringify(merged) === JSON.stringify(current)) return current;
      storeCachedFeatures(merged);
      return merged;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await dashboardApi.getFeatures();
      if (response.data) {
        const nextFeatures = mergeFeatures(response.data);
        // Keep the last capabilities until they load again, so the menu
        // doesn't flicker on each refresh.
        updateFeatures((current) => ({ ...nextFeatures, capabilities: current.capabilities }));

        // Capabilities need a session and probe log sources, so they load in
        // the background; before sign-in the call fails and nothing shows.
        void fleetCapabilitiesApi.get()
          .then((res) => {
            if (res.data) updateFeatures((current) => ({ ...current, capabilities: res.data }));
          })
          .catch(() => { /* keep what we had */ })
          .finally(() => setCapabilitiesSettled(true));
      }
    } catch {
      // Keep the last known feature state on transient API failures.
    } finally {
      setIsLoading(false);
    }
  }, [updateFeatures]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <FeaturesContext.Provider value={{ features, isLoading, capabilitiesSettled, refresh }}>
      {children}
    </FeaturesContext.Provider>
  );
}

export function useFeatures() {
  const context = useContext(FeaturesContext);
  if (context === undefined) {
    throw new Error('useFeatures must be used within a FeaturesProvider');
  }
  return context;
}

/** Whether at least one enabled service of the type has the feature in its setup. */
export function capabilityAvailable(features: Features, serviceType: FleetServiceType, id: string): boolean {
  return Boolean(features.capabilities?.byType[serviceType]?.[id]);
}

/** One service's capabilities: `can(id)` hides a feature its setup can't support. */
export function useServiceCapabilities(serviceId: string | null | undefined) {
  const { features } = useFeatures();
  const map = serviceId ? features.capabilities?.services.find((entry) => entry.serviceId === serviceId)?.features : undefined;
  const can = useCallback((id: string) => Boolean(map?.[id]?.available), [map]);
  const reason = useCallback((id: string) => map?.[id]?.reason, [map]);
  return { loaded: Boolean(map), features: map, can, reason };
}
