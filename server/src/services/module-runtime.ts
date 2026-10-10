export type ModuleRuntimeStatus = 'reachable' | 'unreachable' | 'unknown';

interface ModuleRuntimeTarget {
  slug: string;
  installed: boolean;
  probeUrl: string | null;
}

interface ModuleRuntimeResult {
  runtimeAvailable: boolean;
  runtimeStatus: ModuleRuntimeStatus;
  runtimeMessage: string | null;
}

const PROBE_TIMEOUT_MS = 3000;
const RETRY_DELAY_MS = 250;
const SUCCESS_CACHE_MS = 10_000;
const FAILURE_CACHE_MS = 2000;
const TRANSIENT_STATUSES = new Set([408, 425, 429, 502, 503, 504]);
const cache = new Map<string, { expiresAt: number; result: ModuleRuntimeResult }>();
const inFlight = new Map<string, Promise<ModuleRuntimeResult>>();

async function checkReadiness(probeUrl: string): Promise<ModuleRuntimeResult> {
  let message = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let retry = true;
    try {
      const response = await fetch(probeUrl, {
        method: 'HEAD', signal: controller.signal, redirect: 'manual',
      });
      if (response.ok) {
        return { runtimeAvailable: true, runtimeStatus: 'reachable', runtimeMessage: 'Module runtime is reachable.' };
      }
      message = `Module runtime probe returned HTTP ${response.status}.`;
      retry = TRANSIENT_STATUSES.has(response.status);
    } catch (error) {
      message = controller.signal.aborted
        ? `Module runtime readiness probe timed out after ${PROBE_TIMEOUT_MS} ms.`
        : `Module runtime is unavailable: ${error instanceof Error ? error.message : String(error)}.`;
    } finally {
      clearTimeout(timeout);
    }
    if (!retry || attempt === 1) break;
    await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
  return { runtimeAvailable: false, runtimeStatus: 'unreachable', runtimeMessage: message };
}

export async function probeModuleRuntime(target: ModuleRuntimeTarget): Promise<ModuleRuntimeResult> {
  const key = `${target.slug}:${target.installed ? 'installed' : 'missing'}:${target.probeUrl ?? ''}`;
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.result;
  const pending = inFlight.get(key);
  if (pending) return pending;

  // Share the bounded readiness window across navigation, detail and list requests.
  const probe = (async (): Promise<ModuleRuntimeResult> => {
    let result: ModuleRuntimeResult;
    if (!target.installed || !target.probeUrl) {
      result = {
        runtimeAvailable: false,
        runtimeStatus: 'unknown',
        runtimeMessage: target.installed
          ? 'No runtime probe URL is configured for this module.'
          : 'This module is not installed on the current deployment.',
      };
    } else {
      result = await checkReadiness(target.probeUrl);
    }
    cache.set(key, {
      expiresAt: Date.now() + (result.runtimeStatus === 'unreachable' ? FAILURE_CACHE_MS : SUCCESS_CACHE_MS),
      result,
    });
    return result;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, probe);
  return probe;
}
