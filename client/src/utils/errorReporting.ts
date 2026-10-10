/**
 * The UI's own error reporting to Sentry. The server hands out a DSN when the
 * installation has one configured; otherwise nothing is loaded or sent.
 */
type SentryReact = typeof import('@sentry/react');

interface ErrorReportingConfig {
  dsn: string;
  environment: string;
  release: string | null;
}

let sentry: SentryReact | null = null;

export async function initErrorReporting(): Promise<void> {
  try {
    const base = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;
    const response = await fetch(`${base}/health/client-config`, { credentials: 'same-origin' });
    if (!response.ok) return;
    const body = await response.json() as { data?: { errorReporting?: ErrorReportingConfig | null } };
    const config = body.data?.errorReporting;
    if (!config?.dsn) return;
    // Loaded on demand, so installations without Sentry download none of it.
    const module = await import('@sentry/react');
    module.init({
      dsn: config.dsn,
      environment: config.environment,
      release: config.release ?? undefined,
      tracesSampleRate: 0,
      dataCollection: { userInfo: false, cookies: false, httpBodies: [], urlQueryParams: false },
    });
    sentry = module;
  } catch {
    // Error reporting is optional; the app works without it.
  }
}

export function reportClientError(error: unknown, componentStack?: string | null): void {
  sentry?.captureException(error, componentStack ? { contexts: { react: { componentStack } } } : undefined);
}
