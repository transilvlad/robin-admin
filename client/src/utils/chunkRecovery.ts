const STORAGE_KEY = 'robin-admin.chunk-recovery';
const COOLDOWN_MS = 5 * 60_000;

interface RecoveryEnvironment {
  sessionStorage: Pick<Storage, 'getItem' | 'setItem'>;
  location: Pick<Location, 'pathname' | 'search' | 'hash' | 'reload'>;
}

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'ChunkLoadError' || /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk .* failed/i.test(error.message);
}

/** Keep the route and allow only one automatic reload, including after remount. */
export function recoverChunkLoad(error: unknown, environment: RecoveryEnvironment = window, now = Date.now()): boolean {
  if (!isChunkLoadError(error)) return false;
  const route = environment.location.pathname + environment.location.search + environment.location.hash;
  try {
    const raw = environment.sessionStorage.getItem(STORAGE_KEY);
    const previous: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(previous)) return false;
    const recent = previous.filter((item: unknown): item is { route: string; at: number } =>
      !!item && typeof item === 'object' && 'route' in item && typeof item.route === 'string'
      && 'at' in item && typeof item.at === 'number' && Number.isFinite(item.at)
      && now - item.at < COOLDOWN_MS);
    if (recent.some(item => item.route === route) || recent.length >= 32) return false;
    environment.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...recent, { route, at: now }]));
  } catch {
    // Without a persistent guard, automatic recovery could loop indefinitely.
    return false;
  }
  environment.location.reload();
  return true;
}

export function installChunkRecovery(recoverError = recoverChunkLoad): () => void {
  const recover = (event: Event) => {
    if (recoverError((event as Event & { payload?: unknown }).payload)) event.preventDefault();
  };
  window.addEventListener('vite:preloadError', recover);
  return () => window.removeEventListener('vite:preloadError', recover);
}
