import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { modulesApi, ApiError } from '../api/client';
import type { AdminModule, ModuleDefinition } from '../types';
import { useAuth } from './AuthContext';
import { useFeatures } from './FeaturesContext';
import { loadRemoteModuleDefinition } from '../utils/moduleFederation';
import { prefixAppPath } from '../utils/basePath';

interface ModulesContextType {
  modules: AdminModule[];
  hostedModules: AdminModule[];
  moduleDefinitions: Record<string, ModuleDefinition>;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updateModule: (module: AdminModule) => void;
}

const ModulesContext = createContext<ModulesContextType | undefined>(undefined);
const MODULES_CACHE_KEY = 'robin-admin-modules';
const MODULE_DEFINITIONS_CACHE_KEY = 'robin-admin-module-definitions';

function loadCachedModules(): AdminModule[] {
  try {
    const cached = localStorage.getItem(MODULES_CACHE_KEY);
    return cached ? JSON.parse(cached) as AdminModule[] : [];
  } catch {
    return [];
  }
}

function loadCachedModuleDefinitions(): Record<string, ModuleDefinition> {
  try {
    const cached = localStorage.getItem(MODULE_DEFINITIONS_CACHE_KEY);
    return cached ? JSON.parse(cached) as Record<string, ModuleDefinition> : {};
  } catch {
    return {};
  }
}

function storeCachedModules(modules: AdminModule[]): void {
  try {
    localStorage.setItem(MODULES_CACHE_KEY, JSON.stringify(modules));
  } catch {
    // Ignore storage failures; the network response still updates state.
  }
}

function storeCachedModuleDefinitions(moduleDefinitions: Record<string, ModuleDefinition>): void {
  try {
    localStorage.setItem(MODULE_DEFINITIONS_CACHE_KEY, JSON.stringify(moduleDefinitions));
  } catch {
    // Ignore storage failures; loaded definitions still update state.
  }
}

function applyModuleDefinitionFallback(moduleEntry: AdminModule, moduleDefinition?: ModuleDefinition): AdminModule {
  const title = moduleDefinition?.title?.trim();
  const description = moduleDefinition?.description?.trim();
  const displayName = title && moduleEntry.displayName === moduleEntry.slug
    ? title
    : moduleEntry.displayName;

  if (displayName === moduleEntry.displayName && (!description || moduleEntry.description)) {
    return moduleEntry;
  }

  return {
    ...moduleEntry,
    displayName,
    description: moduleEntry.description ?? description ?? null,
  };
}

export function ModulesProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { features } = useFeatures();
  const [modules, setModules] = useState<AdminModule[]>(loadCachedModules);
  const [moduleDefinitions, setModuleDefinitions] = useState<Record<string, ModuleDefinition>>(loadCachedModuleDefinitions);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (authLoading) {
      return;
    }

    if (!isAuthenticated || !features.modulesEnabled) {
      setModules([]);
      setModuleDefinitions({});
      setError(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const response = await modulesApi.list();
      const nextModules = response.data ?? [];
      setModules(nextModules);
      storeCachedModules(nextModules);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load modules');
    } finally {
      setIsLoading(false);
    }
  }, [authLoading, features.modulesEnabled, isAuthenticated]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (authLoading) {
      return;
    }

    if (!isAuthenticated || !features.modulesEnabled) {
      setModuleDefinitions({});
      return;
    }

    const manifestCandidates = modules.filter((moduleEntry) => (
      moduleEntry.installed
      && moduleEntry.active
      && moduleEntry.runtimeAvailable
      && Boolean(moduleEntry.remoteEntryUrl)
      && Boolean(moduleEntry.remoteScope)
      && Boolean(moduleEntry.exposedModule)
    ));

    if (manifestCandidates.length === 0) {
      setModuleDefinitions({});
      return;
    }

    const snapshotDefinitions = Object.fromEntries(
      manifestCandidates
        .filter((moduleEntry) => moduleEntry.moduleDefinition)
        .map((moduleEntry) => [moduleEntry.slug, moduleEntry.moduleDefinition!] as const),
    );
    if (Object.keys(snapshotDefinitions).length > 0) {
      setModuleDefinitions((current) => {
        const nextDefinitions = {
          ...current,
          ...snapshotDefinitions,
        };
        storeCachedModuleDefinitions(nextDefinitions);
        return nextDefinitions;
      });
    }

    const remoteDefinitionCandidates = manifestCandidates.filter((moduleEntry) => !moduleEntry.moduleDefinition);
    if (remoteDefinitionCandidates.length === 0) {
      return;
    }

    let cancelled = false;

    const loadDefinitions = async () => {
      const results = await Promise.all(
        remoteDefinitionCandidates.map(async (moduleEntry) => {
          try {
            const definition = await loadRemoteModuleDefinition(
              prefixAppPath(moduleEntry.remoteEntryUrl!, import.meta.env.BASE_URL),
              moduleEntry.remoteScope!,
              moduleEntry.exposedModule!,
            );
            return definition ? [moduleEntry.slug, definition] as const : null;
          } catch {
            return null;
          }
        }),
      );

      if (cancelled) {
        return;
      }

      const loadedDefinitions = Object.fromEntries(results.filter((entry): entry is readonly [string, ModuleDefinition] => entry !== null));
      setModuleDefinitions((current) => {
        const nextDefinitions = {
          ...current,
          ...loadedDefinitions,
        };
        storeCachedModuleDefinitions(nextDefinitions);
        return nextDefinitions;
      });
    };

    void loadDefinitions();

    return () => {
      cancelled = true;
    };
  }, [authLoading, features.modulesEnabled, isAuthenticated, modules]);

  const updateModule = useCallback((nextModule: AdminModule) => {
    setModules((current) => {
      const index = current.findIndex((moduleEntry) => moduleEntry.slug === nextModule.slug);
      if (index === -1) {
        const next = [...current, nextModule].sort((left, right) => left.sortOrder - right.sortOrder || left.displayName.localeCompare(right.displayName));
        storeCachedModules(next);
        return next;
      }

      const next = [...current];
      next[index] = nextModule;
      storeCachedModules(next);
      return next;
    });
  }, []);

  const displayedModules = useMemo(
    () => modules.map((moduleEntry) => applyModuleDefinitionFallback(moduleEntry, moduleDefinitions[moduleEntry.slug])),
    [moduleDefinitions, modules],
  );

  const value = useMemo<ModulesContextType>(() => ({
    modules: displayedModules,
    hostedModules: displayedModules.filter((moduleEntry) => (
      moduleEntry.installed
      && moduleEntry.active
      && moduleEntry.runtimeAvailable
      && Boolean(moduleEntry.remoteEntryUrl)
      && Boolean(moduleEntry.remoteScope)
      && Boolean(moduleEntry.exposedModule)
    )),
    moduleDefinitions,
    isLoading,
    error,
    refresh,
    updateModule,
  }), [displayedModules, error, isLoading, moduleDefinitions, refresh, updateModule]);

  return (
    <ModulesContext.Provider value={value}>
      {children}
    </ModulesContext.Provider>
  );
}

export function useModules() {
  const context = useContext(ModulesContext);
  if (!context) {
    throw new Error('useModules must be used within a ModulesProvider');
  }

  return context;
}
