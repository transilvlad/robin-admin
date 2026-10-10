/**
 * Detects a mid-session 401 (expired/invalidated session) from ANY same-origin
 * fetch — including calls made by federated module bundles, which run in this
 * same window and share the same global `fetch`. Without this, only the
 * initial `/api/auth/me` mount check ever reacts to an unauthenticated
 * response, so an expiry discovered later (a stale page, a module action)
 * never redirects to /login on its own.
 */

let handler: (() => void) | null = null;

export function setSessionExpiredHandler(nextHandler: (() => void) | null): void {
  handler = nextHandler;
}

// Endpoints where a 401 is an expected, routine outcome (checking auth state,
// a bad-password attempt, first-run setup) rather than a signal that a
// signed-in session just expired.
const EXEMPT_PATHS = new Set(['/api/auth/me', '/api/auth/login', '/api/auth/csrf', '/api/setup']);

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function shouldNotify(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url, window.location.origin).pathname;
  } catch {
    return false;
  }
  return !EXEMPT_PATHS.has(pathname);
}

export function installSessionExpiryWatcher(): void {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await nativeFetch(...args);
    if (response.status === 401 && shouldNotify(requestUrl(args[0]))) {
      handler?.();
    }
    return response;
  };
}
