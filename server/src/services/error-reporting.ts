/**
 * Robin Admin's own error reporting to Sentry (separate from Sentry as an
 * alert destination, which uses its own client per destination). Off unless
 * SENTRY_DSN is set. Events carry no request bodies, cookies, credentials or
 * user details.
 */
import * as Sentry from '@sentry/node';
import type { ErrorEvent, NodeOptions } from '@sentry/node';

type Env = Record<string, string | undefined>;

const SECRET_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-csrf-token', 'x-robin-agent-id', 'proxy-authorization'];

function environmentOf(env: Env): string {
  return env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV?.trim() || 'production';
}

export function sentryOptions(env: Env): NodeOptions | null {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;
  const rate = Number(env.SENTRY_TRACES_SAMPLE_RATE ?? '0.05');
  return {
    dsn,
    environment: environmentOf(env),
    release: env.ROBIN_ADMIN_RELEASE?.trim() || undefined,
    tracesSampleRate: Number.isFinite(rate) ? Math.min(Math.max(rate, 0), 1) : 0.05,
    // Collect nothing that can carry mail data or credentials: no user
    // details, cookies, bodies or query strings, and request headers only
    // minus the secret ones. beforeSend scrubs again in case a default changes.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { deny: SECRET_HEADERS }, response: false },
      httpBodies: [],
      urlQueryParams: false,
    },
    beforeSend: scrubEvent,
  };
}

/** Strip anything that could carry mail data or credentials from an event. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    const headers = event.request.headers;
    if (headers) {
      for (const name of Object.keys(headers)) {
        if (SECRET_HEADERS.includes(name.toLowerCase())) delete headers[name];
      }
    }
  }
  if (event.user) event.user = event.user.id === undefined ? {} : { id: event.user.id };
  return event;
}

/** Report a background job failure that is otherwise only logged. */
export function reportError(error: unknown, job: string): void {
  if (!Sentry.isInitialized()) return;
  Sentry.captureException(error, { tags: { job } });
}

/**
 * What the UI needs to report its own errors. A DSN is a public key by
 * design, so it can be handed out before sign-in. SENTRY_BROWSER_DSN can
 * point the UI at another project.
 */
export function clientErrorReportingConfig(env: Env): { dsn: string; environment: string; release: string | null } | null {
  // Compose passes an unset SENTRY_BROWSER_DSN as an empty string.
  const dsn = env.SENTRY_BROWSER_DSN?.trim() || env.SENTRY_DSN?.trim();
  if (!dsn) return null;
  return { dsn, environment: environmentOf(env), release: env.ROBIN_ADMIN_RELEASE?.trim() || null };
}
