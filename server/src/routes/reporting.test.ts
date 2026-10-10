import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ReportingCapacityError } from '../services/reporting-capacity.js';

vi.mock('../services/reporting-aggregate.js', () => ({
  resolveTimeframe: vi.fn(), getTotals: vi.fn(), getDomainAggregates: vi.fn(),
  getDomainAggregate: vi.fn(), getReporterAggregates: vi.fn(), getRecords: vi.fn(), getTrend: vi.fn(),
}));
vi.mock('../services/reporting-sources.js', () => ({ getSourceAggregates: vi.fn(), setSourceReview: vi.fn() }));
vi.mock('../services/source-identity.js', () => ({ backfillIdentities: vi.fn() }));
vi.mock('../db/queries/audit.js', () => ({ createAuditEntry: vi.fn() }));

const { resolveTimeframe } = await import('../services/reporting-aggregate.js');
const { getSourceAggregates } = await import('../services/reporting-sources.js');
const { default: router } = await import('./reporting.js');
let server: Server;
let url: string;
let authenticated = true;

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    if (authenticated) req.session = { admin: { id: 1, name: 'Test', email: 'test@example.test', role: 'admin' } } as typeof req.session;
    next();
  });
  app.use('/api/reporting', router);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/reporting/sources`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => {
  vi.resetAllMocks();
  authenticated = true;
  vi.mocked(resolveTimeframe).mockResolvedValue({
    from: new Date(0), to: new Date(1), dataFrom: null, dataTo: null,
    dataAgeDays: null, empty: false, stale: false, defaulted: true,
  });
});

describe('source capacity responses', () => {
  it('reports overload as retryable 503 rather than a database error', async () => {
    vi.mocked(getSourceAggregates).mockRejectedValue(new ReportingCapacityError());
    const response = await fetch(url);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(await response.json()).toEqual({ success: false, error: 'Reporting is busy; retry later' });
  });

  it('keeps ordinary failures as errors rather than pretending the read succeeded', async () => {
    vi.mocked(getSourceAggregates).mockRejectedValue(new Error('database unavailable'));
    const response = await fetch(url);
    expect(response.status).toBe(500);
    expect(response.headers.get('retry-after')).toBeNull();
  });

  it('still rejects unauthenticated reads before attempting an aggregate', async () => {
    authenticated = false;
    expect((await fetch(url)).status).toBe(401);
    expect(getSourceAggregates).not.toHaveBeenCalled();
  });
});
