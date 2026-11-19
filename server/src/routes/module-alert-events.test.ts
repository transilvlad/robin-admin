import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AlertWebhook } from '../types/alerts.js';
import router from './module-alert-events.js';
import { assertModuleRuntimeAccess, ModuleAccessError } from '../services/modules.js';
import { moduleAlertCatalog } from '../services/alerts/module-alerts.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), release: vi.fn(), deliveries: vi.fn(), webhooks: vi.fn(), modules: vi.fn(),
}));

vi.mock('../db/connection.js', () => ({
  getClient: async () => ({ query: mocks.query, release: mocks.release }),
}));
vi.mock('../db/queries/alerts.js', () => ({
  createAlertDelivery: mocks.deliveries, listAlertWebhooks: mocks.webhooks,
}));
vi.mock('../db/queries/config.js', () => ({ getConfig: async () => ({ modulesEnabled: true }) }));
vi.mock('../services/operations-settings.js', () => ({ operationsPolicy: () => ({ alertsEnabled: true }) }));
vi.mock('../services/alerts/sentry.js', () => ({ buildSentryAlertPayload: vi.fn() }));
vi.mock('../services/modules.js', () => ({
  assertModuleRuntimeAccess: mocks.modules,
  ModuleAccessError: class ModuleAccessError extends Error {},
}));
vi.mock('../config.js', () => ({
  config: {
    publicBaseUrl: 'https://admin.example.test/admin',
    moduleAlertPublishers: {
      inspector: { apiKeyId: 4, requirePaid: true, link: { path: 'incidents', parameter: 'case' },
        categories: { detection: { label: 'Inspector finding', maxSeverity: 'warning' } } },
      'another-module': { apiKeyId: 8, requirePaid: true, link: { path: 'reviews', parameter: 'id' },
        categories: { detection: { label: 'Other finding', maxSeverity: 'critical' } } },
    },
  },
}));

let server: Server;
let url: string;
const event = () => ({
  id: 'case-1', category: 'detection', resource: 'test-resource', severity: 'warning',
  summary: 'A reviewed finding', reference: 'detail-1', observedAt: new Date().toISOString(),
});

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    const scopes = req.header('x-test-scope');
    if (scopes) req.apiKey = { id: Number(req.header('x-test-id')), scopes: [scopes], role: 'viewer' } as typeof req.apiKey;
    next();
  });
  app.use('/api/modules', router);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/modules`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

const post = (body: object, id?: number, scope = 'module-alerts:publish', slug = 'inspector') =>
  fetch(`${url}/${slug}/alert-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(id === undefined ? {} : { 'x-test-id': String(id), 'x-test-scope': scope }) },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.modules.mockImplementation(async (slug: string) => ({ tier: 'paid', routeSlug: `${slug}-ui` }));
  const receipts = new Set<string>();
  mocks.query.mockImplementation(async (sql: string, values: unknown[]) => {
    const key = JSON.stringify(values);
    if (!sql.startsWith('INSERT') || receipts.has(key)) return { rowCount: 0 };
    receipts.add(key);
    return { rowCount: 1 };
  });
});

it('checks exact publisher credentials, declared category, and paid module access', async () => {
  expect((await post(event())).status).toBe(401);
  expect((await post(event(), 4, 'audit:read')).status).toBe(403);
  expect((await post(event(), 4, '*')).status).toBe(403);
  expect((await post(event(), 8)).status).toBe(403);
  expect((await post(event(), 4, 'module-alerts:publish', 'another-module')).status).toBe(403);
  expect((await post({ ...event(), category: 'undeclared' }, 4)).status).toBe(403);
  expect((await post({ ...event(), severity: 'critical' }, 4)).status).toBe(403);
  expect((await post({ ...event(), reference: 'https://example.test' }, 4)).status).toBe(400);
  expect((await post({ ...event(), summary: 'Unexpected <@mention>' }, 4)).status).toBe(400);
  expect((await post({ ...event(), destinationId: 7 }, 4)).status).toBe(400);
  expect((await post({ ...event(), observedAt: '2020-01-01T00:00:00Z' }, 4)).status).toBe(400);
  mocks.modules.mockResolvedValueOnce({ tier: 'free', routeSlug: 'inspector' });
  expect((await post(event(), 4)).status).toBe(403);
  mocks.modules.mockRejectedValueOnce(new ModuleAccessError('Expired'));
  expect((await post(event(), 4)).status).toBe(403);
  expect(assertModuleRuntimeAccess).toHaveBeenCalledTimes(2);
  expect(mocks.query).not.toHaveBeenCalled();
});

it('isolates subscriptions and deduplication by module and constructs links in Admin', async () => {
  const subscription = (moduleSlug: string, moduleCategory = 'detection') => ({
    alertType: 'module_alert' as const, enabled: true, threshold: null, moduleSlug, moduleCategory,
  });
  const webhook = { id: 1, name: 'Operations', enabled: true, adapter: 'slack',
    pausedAt: null, subscriptions: [subscription('inspector')] } as AlertWebhook;
  mocks.webhooks.mockResolvedValue([
    webhook, { ...webhook, id: 2, enabled: false }, { ...webhook, id: 3, pausedAt: new Date() },
    { ...webhook, id: 4, subscriptions: [subscription('another-module')] },
    { ...webhook, id: 5, subscriptions: [subscription('inspector', 'other-category')] },
  ]);
  const finding = event();
  expect((await post(finding, 4)).status).toBe(202);
  expect((await post(finding, 4)).status).toBe(202);
  expect((await post(finding, 8, 'module-alerts:publish', 'another-module')).status).toBe(202);
  expect(mocks.deliveries).toHaveBeenCalledTimes(2);
  const [first, second] = mocks.deliveries.mock.calls.map(([delivery]) => delivery);
  expect(first).toMatchObject({ webhookId: 1, alertType: 'module_alert', moduleAlertSource: { slug: 'inspector', category: 'detection' } });
  expect(second).toMatchObject({ webhookId: 4, alertType: 'module_alert', moduleAlertSource: { slug: 'another-module' } });
  expect(second.dedupeKey).not.toBe(first.dedupeKey);
  expect(JSON.stringify(first.payload)).toContain('https://admin.example.test/admin/modules/inspector-ui/incidents?case=detail-1');
  expect(JSON.stringify(first.payload)).toContain('A reviewed finding');
  expect(JSON.stringify(moduleAlertCatalog())).not.toContain('apiKeyId');
  expect(mocks.query).toHaveBeenCalledWith('COMMIT');
});
