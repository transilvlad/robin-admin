import { createHmac, randomUUID } from 'node:crypto';
import { config } from '../config.js';

export type ModuleInstallerAction = 'install' | 'upgrade' | 'start' | 'stop' | 'uninstall';
export type ModuleUpgradeStrategy = 'stage-first' | 'maintenance';

export interface ModuleInstallerRegistryCredential {
  repository: string;
  registry: string;
  username: string;
  password: string;
  expiresAt: string;
}

export interface ModuleInstallerResult {
  jobId: string;
  action: ModuleInstallerAction;
  moduleSlug: string;
  version: string;
  status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'unknown';
  message: string | null;
  data?: Record<string, unknown>;
}

export interface ModuleInstallerRuntime {
  backendUrl: string | null;
  assetBaseUrl: string;
  probeUrl: string;
}

// Only an executed job may publish targets. Policy URLs describe Admin's
// network, not the installer's bind addresses or arbitrary container ports.
export function extractInstallerRuntime(data: Record<string, unknown> | undefined): ModuleInstallerRuntime {
  const value = data?.runtime;
  if (data?.mode !== 'docker' || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ModuleInstallerError('Installer result is missing executed runtime addresses.', 502);
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['backendUrl', 'assetBaseUrl', 'probeUrl'].includes(key))) {
    throw new ModuleInstallerError('Installer runtime contains unsupported fields.', 502);
  }
  const runtime: ModuleInstallerRuntime = { backendUrl: null, assetBaseUrl: '', probeUrl: '' };
  for (const key of ['backendUrl', 'assetBaseUrl', 'probeUrl'] as const) {
    if (key === 'backendUrl' && input[key] === null) continue;
    const raw = input[key];
    let url: URL;
    try { url = new URL(raw as string); } catch { throw new ModuleInstallerError(`Installer runtime ${key} is invalid.`, 502); }
    if (typeof raw !== 'string' || raw.length > 2048 || /[\s?#]/.test(raw)
      || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || ['0.0.0.0', '[::]'].includes(url.hostname)
      || (key === 'assetBaseUrl' && url.pathname !== '/')) {
      throw new ModuleInstallerError(`Installer runtime ${key} is invalid.`, 502);
    }
    runtime[key] = key === 'probeUrl' ? url.href : url.href.replace(/\/$/, '');
  }
  return runtime;
}

export class ModuleInstallerError extends Error {
  constructor(
    message: string,
    public readonly status = 503,
  ) {
    super(message);
  }
}

function signedHeaders(method: string, path: string, body: string) {
  const timestamp = Date.now().toString();
  const signature = createHmac('sha256', config.moduleInstaller.signingSecret)
    .update(`${timestamp}\n${method}\n${path}\n${body}`)
    .digest('hex');
  return {
    'x-robin-installer-timestamp': timestamp,
    'x-robin-installer-signature': signature,
  };
}

export async function installerRequest<T>(method: 'GET' | 'POST', path: string, bodyValue?: unknown, timeoutMs = 10_000): Promise<T> {
  if (!config.moduleInstaller.signingSecret) {
    throw new ModuleInstallerError('Module installer signing secret is not configured.');
  }
  const body = bodyValue === undefined ? '' : JSON.stringify(bodyValue);
  let response: Response;
  try {
    response = await fetch(`${config.moduleInstaller.url.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...signedHeaders(method, path, body),
      },
      body: body || undefined,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (error) {
    throw new ModuleInstallerError(`Module installer is unavailable: ${(error as Error).message}`);
  }

  const payload = await response.json().catch(() => null) as {
    success?: boolean;
    data?: T;
    error?: string;
  } | null;
  if (!response.ok || payload?.success === false || payload?.data === undefined) {
    throw new ModuleInstallerError(
      payload?.error || `Module installer returned HTTP ${response.status}.`,
      response.status >= 400 && response.status < 600 ? response.status : 502,
    );
  }
  return payload.data;
}

type InstallerCapabilities = { mode: string; modules: Record<string, string[]>; upgradeStrategies: Record<string, ModuleUpgradeStrategy> };
let capabilitiesCache: { checkedAt: number; value: InstallerCapabilities | null } | null = null;
let capabilitiesRequest: Promise<InstallerCapabilities | null> | null = null;

async function getInstallerCapabilities(): Promise<InstallerCapabilities | null> {
  if (!config.moduleInstaller?.signingSecret) return null;
  if (capabilitiesCache && Date.now() - capabilitiesCache.checkedAt < 5000) return capabilitiesCache.value;
  if (capabilitiesRequest) return capabilitiesRequest;
  capabilitiesRequest = installerRequest<InstallerCapabilities>('GET', '/api/capabilities', undefined, 1500)
    .then((value) => {
      if (value.mode !== 'docker' || !value.modules || typeof value.modules !== 'object'
        || Array.isArray(value.modules) || !Object.values(value.modules).every((versions) => Array.isArray(versions) && versions.every((version) => typeof version === 'string'))
        || !value.upgradeStrategies || typeof value.upgradeStrategies !== 'object' || Array.isArray(value.upgradeStrategies)
        || !Object.keys(value.modules).every(slug => ['stage-first', 'maintenance'].includes(value.upgradeStrategies[slug]))) return null;
      return value;
    }).catch(() => null).then((value) => {
      capabilitiesCache = { checkedAt: Date.now(), value };
      return value;
    }).finally(() => { capabilitiesRequest = null; });
  return capabilitiesRequest;
}

export async function getAvailableInstallerActions(module: {
  slug: string; installed: boolean; installedSource: string | null; latestVersion: string | null;
}): Promise<ModuleInstallerAction[]> {
  if (module.installed && module.installedSource !== 'installer') return [];
  const versions = (await getInstallerCapabilities())?.modules[module.slug];
  if (!versions?.length) return [];
  const releaseApproved = !!module.latestVersion && versions.includes(module.latestVersion);
  if (!module.installed) return releaseApproved ? ['install'] : [];
  return [...(releaseApproved ? ['upgrade' as const] : []), 'start', 'stop', 'uninstall'];
}

export async function getInstallerUpgradeStrategy(moduleSlug: string): Promise<ModuleUpgradeStrategy | null> {
  return (await getInstallerCapabilities())?.upgradeStrategies[moduleSlug] ?? null;
}

export async function dispatchModuleInstallerAction(
  action: ModuleInstallerAction,
  moduleSlug: string,
  version: string,
  registryCredentials: ModuleInstallerRegistryCredential[] = [],
  maintenanceAcknowledged = false,
): Promise<ModuleInstallerResult> {
  const job = {
    jobId: randomUUID(),
    action,
    moduleSlug,
    version,
    maintenanceAcknowledged,
    ...(registryCredentials.length > 0 ? { registryCredentials } : {}),
  };
  return installerRequest<ModuleInstallerResult>('POST', '/api/jobs', job);
}

export async function getModuleInstallerJob(jobId: string): Promise<ModuleInstallerResult> {
  return installerRequest<ModuleInstallerResult>('GET', `/api/jobs/${encodeURIComponent(jobId)}`);
}

export async function getModuleInstallerStatus(moduleSlug: string): Promise<Record<string, unknown>> {
  return installerRequest<Record<string, unknown>>(
    'GET',
    `/api/modules/${encodeURIComponent(moduleSlug)}/status`,
  );
}
