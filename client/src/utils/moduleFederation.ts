import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { createInstance, getInstance, type ModuleFederation } from '@module-federation/runtime';
import type { ComponentType } from 'react';
import type { ModuleDefinition } from '../types';

interface RemoteModuleShape {
  default?: ComponentType;
  ModulePage?: ComponentType;
  moduleDefinition?: ModuleDefinition;
}

const remoteModuleCache = new Map<string, Promise<RemoteModuleShape>>();
const registeredRemoteEntries = new Map<string, string>();

function getOrCreateFederationRuntime(): ModuleFederation {
  const runtime = getInstance();
  if (runtime) {
    return runtime;
  }

  return createInstance({
    name: 'robin_admin_host_runtime',
    remotes: [],
    shared: {
      react: {
        version: React.version,
        lib: () => React,
      },
      'react-dom': {
        version: ReactDOM.version,
        lib: () => ReactDOM,
      },
    },
  });
}

export async function loadRemoteModuleComponent(
  remoteEntryUrl: string,
  remoteScope: string,
  exposedModule: string,
): Promise<ComponentType> {
  const remoteModule = await loadRemoteModule(remoteEntryUrl, remoteScope, exposedModule);

  const RemoteComponent = remoteModule?.default ?? remoteModule?.ModulePage;
  if (!RemoteComponent) {
    throw new Error(`Remote module ${remoteScope}:${exposedModule} did not export a renderable component`);
  }

  return RemoteComponent;
}

export async function loadRemoteModuleDefinition(
  remoteEntryUrl: string,
  remoteScope: string,
  exposedModule: string,
): Promise<ModuleDefinition | null> {
  const remoteModule = await loadRemoteModule(remoteEntryUrl, remoteScope, exposedModule);
  return remoteModule.moduleDefinition ?? null;
}

async function loadRemoteModule(
  remoteEntryUrl: string,
  remoteScope: string,
  exposedModule: string,
): Promise<RemoteModuleShape> {
  const runtime = getOrCreateFederationRuntime();

  const cacheKey = `${remoteScope}::${exposedModule}::${remoteEntryUrl}`;
  const cached = remoteModuleCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  ensureRemoteRegistered(runtime, remoteScope, remoteEntryUrl);

  const remoteModulePromise: Promise<RemoteModuleShape> = runtime
    .loadRemote<RemoteModuleShape | null>(
      `${remoteScope}/${exposedModule.replace(/^\.\//, '')}`,
      { from: 'runtime' },
    )
    .then((remoteModule) => {
      if (!remoteModule) {
        throw new Error(`Remote module ${remoteScope}:${exposedModule} returned no exports`);
      }

      return remoteModule;
    });
  remoteModuleCache.set(cacheKey, remoteModulePromise);

  try {
    return await remoteModulePromise;
  } catch (error) {
    remoteModuleCache.delete(cacheKey);
    throw error;
  }
}

function ensureRemoteRegistered(
  runtime: ModuleFederation,
  remoteScope: string,
  remoteEntryUrl: string,
): void {
  const registeredEntry = registeredRemoteEntries.get(remoteScope);
  if (registeredEntry === remoteEntryUrl) {
    return;
  }

  const remote = {
    name: remoteScope,
    entry: remoteEntryUrl,
    type: 'module' as const,
  };

  if (registeredEntry) {
    for (const cacheKey of remoteModuleCache.keys()) {
      if (cacheKey.startsWith(`${remoteScope}::`)) {
        remoteModuleCache.delete(cacheKey);
      }
    }
    runtime.registerRemotes([remote], { force: true });
  } else {
    runtime.registerRemotes([remote]);
  }

  registeredRemoteEntries.set(remoteScope, remoteEntryUrl);
}
