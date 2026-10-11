import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './rspamd.js';
import * as rspamdService from '../services/rspamd.js';
import { logAudit } from '../middleware/audit.js';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../middleware/rbac.js', () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../middleware/audit.js', () => ({
  AuditActions: {
    RSPAMD_SETTINGS_UPDATE: 'rspamd-settings-update',
    RSPAMD_CONFIG_UPDATE: 'rspamd-config-update',
    RSPAMD_RULES_UPDATE: 'rspamd-rules-update',
    RSPAMD_DKIM_KEY_CREATE: 'rspamd-dkim-key-create',
    RSPAMD_SCAN_RUN: 'rspamd-scan-run',
    RSPAMD_SCAN_REPLAY: 'rspamd-scan-replay',
    RSPAMD_SCAN_LEARN: 'rspamd-scan-learn',
    RSPAMD_SCAN_FUZZY: 'rspamd-scan-fuzzy',
    RSPAMD_CLASSIFIERS_UPDATE: 'rspamd-classifiers-update',
  },
  logAudit: vi.fn(async () => undefined),
}));

vi.mock('../db/queries/rspamd.js', async (importOriginal) => ({
  toPublicRspamdSettings: (await importOriginal<typeof import('../db/queries/rspamd.js')>()).toPublicRspamdSettings,
  createDkimDomain: vi.fn(),
  getTrainingImport: vi.fn(),
  getTrainingSample: vi.fn(),
  listDkimDomains: vi.fn(async () => []),
  listDkimSelectors: vi.fn(async () => []),
  updateDkimDomain: vi.fn(),
}));

vi.mock('../services/rspamd.js', () => ({
  RspamdNotConfiguredError: class RspamdNotConfiguredError extends Error {},
  createOrRotateDkimKey: vi.fn(),
  deleteTrainingSampleAndFile: vi.fn(),
  fuzzyRspamdScan: vi.fn(),
  getRspamdClassifierSummary: vi.fn(async () => ({
    serviceId: 'rspamd',
    defaultTransport: 'checkv2',
    defaultClassifier: '',
    controllerReachable: true,
    controllerAuthenticated: true,
    normalWorkerReachable: true,
    fuzzyPresets: [],
    statfiles: [],
    learnedMessages: 0,
    symbolsByType: [],
  })),
  getRspamdConfigState: vi.fn(async () => ({
    settings: {},
    managedConfig: {},
    status: {},
    files: {},
  })),
  getRspamdStatus: vi.fn(async () => ({})),
  getRspamdScanHistoryDetail: vi.fn(),
  getTrainingCorpus: vi.fn(),
  importDkimKey: vi.fn(),
  importTrainingBinary: vi.fn(),
  listRspamdScanHistory: vi.fn(async () => ({ runs: [], total: 0, page: 1, limit: 20 })),
  learnRspamdScan: vi.fn(),
  replayRspamdScan: vi.fn(),
  relabelAndRelearnTrainingSample: vi.fn(),
  relearnTrainingSample: vi.fn(),
  revokeDkimSelector: vi.fn(),
  runRspamdScan: vi.fn(),
  runRspamdScanFile: vi.fn(),
  saveRspamdClassifierSettings: vi.fn(),
  saveRspamdManagedConfig: vi.fn(),
  saveRspamdSettings: vi.fn(),
}));

vi.mock('../services/rspamd-rules.js', () => ({
  getRspamdRulesState: vi.fn(async () => ({
    settings: {},
    status: {},
    fileManagement: {},
    document: {},
    files: {},
    validation: { errors: [], warnings: [] },
  })),
  previewRspamdRules: vi.fn(async () => ({
    settings: {},
    status: {},
    fileManagement: {},
    document: {},
    files: {},
    validation: { errors: [], warnings: [] },
  })),
  saveRspamdRules: vi.fn(async () => ({
    settings: {},
    status: {},
    fileManagement: {},
    document: {},
    files: {},
    validation: { errors: [], warnings: [] },
  })),
}));

const mockSaveRspamdSettings = vi.mocked(rspamdService.saveRspamdSettings);
const mockImportDkimKey = vi.mocked(rspamdService.importDkimKey);
const mockImportTrainingBinary = vi.mocked(rspamdService.importTrainingBinary);

let server: Server;
let baseUrl: string;

async function requestJson(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });

  return {
    response,
    body: await response.json(),
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: object }).session = {};
    next();
  });
  app.use('/rspamd', router);
  server = app.listen(0);

  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('rspamd routes', () => {
  it('imports training data into the selected service and names a missing directory', async () => {
    mockImportTrainingBinary.mockRejectedValueOnce(
      new rspamdService.RspamdNotConfiguredError('Rspamd training directory is not configured for the selected Rspamd service'),
    );

    const { response, body } = await requestJson('/rspamd/training/import-file?label=spam&fileName=a.eml&serviceId=rspamd-2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: 'Subject: hi',
    });

    expect(mockImportTrainingBinary).toHaveBeenCalledWith(expect.objectContaining({ name: 'a.eml' }), 'spam', null, 'rspamd-2');
    expect(response.status).toBe(400);
    expect(body.error).toBe('Rspamd training directory is not configured for the selected Rspamd service');
  });

  it('returns structured rules state', async () => {
    const { response, body } = await requestJson('/rspamd/rules');

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.validation).toEqual({ errors: [], warnings: [] });
  });

  it('never returns or audits the controller passwords', async () => {
    mockSaveRspamdSettings.mockResolvedValueOnce({
      serviceId: 'rspamd',
      serviceName: 'Rspamd',
      rspamdControllerUrl: 'http://spam-backend:11334',
      rspamdNormalUrl: 'http://spam-backend:11333',
      rspamdControllerPassword: 'controller-secret',
      rspamdEnablePassword: '',
      rspamdConfigDir: '',
      rspamdStoreDir: '',
      rspamdDkimDir: '',
      rspamdTrainingDir: '',
    });

    const { response, body } = await requestJson('/rspamd/settings', {
      method: 'PUT',
      body: JSON.stringify({ rspamdControllerPassword: 'controller-secret' }),
    });

    expect(response.status).toBe(200);
    expect(body.data.settings).toMatchObject({ hasControllerPassword: true, hasEnablePassword: false });
    expect(JSON.stringify(body)).not.toContain('controller-secret');
    expect(JSON.stringify(vi.mocked(logAudit).mock.calls.map((call) => call[2]))).not.toContain('controller-secret');
  });

  it('returns a normal api error when saving settings without a managed service', async () => {
    mockSaveRspamdSettings.mockRejectedValueOnce(
      new Error('No managed Rspamd service is configured in fleet_services'),
    );

    const { response, body } = await requestJson('/rspamd/settings', {
      method: 'PUT',
      body: JSON.stringify({ rspamdControllerUrl: 'http://spam-backend:11334' }),
    });

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: 'No managed Rspamd service is configured in fleet_services',
    });
  });

  it('imports a DKIM private key and returns the activated selector', async () => {
    mockImportDkimKey.mockResolvedValueOnce({
      id: 42,
      domainId: 7,
      selector: '20260505',
      publicKeyTxt: 'v=DKIM1; k=rsa; p=abc',
      publicKeyP: 'abc',
      algorithm: 'rsa',
      keyBits: 2048,
      state: 'active',
      hasPrivateKey: true,
      activatedAt: new Date('2026-05-05T00:00:00Z'),
      retiredAt: null,
      purgeAfter: null,
      privateKeyDeletedAt: null,
      createdAt: new Date('2026-05-05T00:00:00Z'),
    } as never);

    const { response, body } = await requestJson('/rspamd/dkim/domains/7/import', {
      method: 'POST',
      body: JSON.stringify({
        selector: '20260505',
        privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      }),
    });

    expect(response.status).toBe(200);
    expect(mockImportDkimKey).toHaveBeenCalledWith(
      7,
      '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      '20260505',
    );
    expect(body.data).toMatchObject({
      id: 42,
      selector: '20260505',
      state: 'active',
    });
  });
});
