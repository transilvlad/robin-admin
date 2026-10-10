import { describe, expect, it } from 'vitest';
import type { ErrorEvent } from '@sentry/node';
import { clientErrorReportingConfig, scrubEvent, sentryOptions } from './error-reporting.js';

describe('error reporting', () => {
  it('stays off without a DSN', () => {
    expect(sentryOptions({})).toBeNull();
    expect(sentryOptions({ SENTRY_DSN: '  ' })).toBeNull();
    expect(clientErrorReportingConfig({})).toBeNull();
  });

  it('builds options from the environment with a bounded trace sample rate', () => {
    const options = sentryOptions({ SENTRY_DSN: 'https://key@o1.ingest.sentry.io/2', SENTRY_ENVIRONMENT: 'staging', ROBIN_ADMIN_RELEASE: 'abc123', SENTRY_TRACES_SAMPLE_RATE: '7' });
    expect(options).toMatchObject({ dsn: 'https://key@o1.ingest.sentry.io/2', environment: 'staging', release: 'abc123', tracesSampleRate: 1 });
    expect(options?.dataCollection).toMatchObject({ userInfo: false, cookies: false, httpBodies: [], urlQueryParams: false });
    expect(sentryOptions({ SENTRY_DSN: 'https://key@o1.ingest.sentry.io/2', NODE_ENV: 'production' })).toMatchObject({ environment: 'production', tracesSampleRate: 0.05 });
  });

  it('falls back to the server DSN when the browser DSN is empty', () => {
    expect(clientErrorReportingConfig({ SENTRY_DSN: 'https://server@o1.ingest.sentry.io/2', SENTRY_BROWSER_DSN: '', SENTRY_ENVIRONMENT: 'staging' }))
      .toEqual({ dsn: 'https://server@o1.ingest.sentry.io/2', environment: 'staging', release: null });
  });

  it('gives the UI its own DSN when one is set', () => {
    expect(clientErrorReportingConfig({ SENTRY_DSN: 'https://server@o1.ingest.sentry.io/2', SENTRY_BROWSER_DSN: 'https://ui@o1.ingest.sentry.io/3' }))
      .toEqual({ dsn: 'https://ui@o1.ingest.sentry.io/3', environment: 'production', release: null });
  });

  it('removes bodies, cookies, secret headers and user details', () => {
    const event = scrubEvent({
      type: undefined,
      request: { data: { password: 'x' }, cookies: { sid: 'y' }, query_string: 'token=z', headers: { Authorization: 'Bearer t', 'User-Agent': 'ua', 'X-API-Key': 'k' } },
      user: { id: '7', email: 'admin@example.test', ip_address: '192.0.2.1' },
    } as ErrorEvent);
    expect(event.request).toEqual({ headers: { 'User-Agent': 'ua' } });
    expect(event.user).toEqual({ id: '7' });
  });
});
