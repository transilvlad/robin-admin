/**
 * Unit tests for fleet service database queries.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as instances from './fleet-services.js';
import * as connection from '../connection.js';
import { decryptStoredSecret, encryptStoredSecret } from './secret-crypto.js';

vi.mock('../connection.js');

const mockQuery = vi.fn();

beforeEach(() => {
  mockQuery.mockReset();
  (connection.query as unknown as typeof mockQuery) = mockQuery;
});

describe('Fleet service queries', () => {
  it.each(['redis', 'postgres', 'mariadb'] as const)('seals %s DSNs on create and update and decrypts only internally', async (serviceType) => {
    vi.stubEnv('ROBIN_ADMIN_ENCRYPTION_KEY', 'isolated-fleet-test-key-at-least-32-characters');
    try {
      const dsn = `${serviceType === 'redis' ? 'redis' : serviceType === 'postgres' ? 'postgresql' : 'mysql'}://admin:private-secret@db.test/`;
      const encrypted = encryptStoredSecret(dsn);
      mockQuery.mockResolvedValue({ rows: [{ service_id: 'db', service_type: serviceType, metrics_url: encrypted }] });
      const created = await instances.createFleetService({ serviceId: 'db', serviceType, name: 'Database', metricsUrl: dsn });
      const storedCreate = mockQuery.mock.calls[0][1][6];
      expect(storedCreate).not.toContain('private-secret');
      expect(decryptStoredSecret(storedCreate)).toBe(dsn);
      expect(created.metricsUrl).toBe(dsn);
      mockQuery.mockClear();
      expect((await instances.updateFleetService('db', { metricsUrl: dsn }))?.metricsUrl).toBe(dsn);
      expect(decryptStoredSecret(mockQuery.mock.calls[0][1][0])).toBe(dsn);
    } finally { vi.unstubAllEnvs(); }
  });
  it('lists fleet services with filters', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 1,
        service_id: 'robin-east',
        service_type: 'robin',
        name: 'Robin East',
        description: 'Primary Robin',
        api_url: 'https://robin-east.example.test',
        health_url: 'https://robin-east.example.test/health',
        metrics_url: 'https://robin-east.example.test/metrics',
        controller_url: null,
        normal_url: null,
        enabled: true,
        created_at: new Date('2024-01-01T00:00:00Z'),
        updated_at: new Date('2024-01-02T00:00:00Z'),
      }],
      rowCount: 1,
    });

    const result = await instances.getFleetServices({ serviceType: 'robin', enabled: true });

    expect(result).toEqual([{
      id: 1,
      serviceId: 'robin-east',
      serviceType: 'robin',
      name: 'Robin East',
      description: 'Primary Robin',
      apiUrl: 'https://robin-east.example.test',
      healthUrl: 'https://robin-east.example.test/health',
      metricsUrl: 'https://robin-east.example.test/metrics',
      controllerUrl: null,
      normalUrl: null,
      enabled: true,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-02T00:00:00Z'),
    }]);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('FROM fleet_services WHERE service_type = $1 AND enabled = $2'),
      ['robin', true]
    );
  });

  it('creates fleet services against fleet_services', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 7,
        service_id: 'rspamd-core',
        service_type: 'rspamd',
        name: 'Rspamd Core',
        description: null,
        api_url: 'https://rspamd.example.test',
        health_url: null,
        metrics_url: 'https://rspamd.example.test',
        controller_url: null,
        normal_url: null,
        enabled: true,
        created_at: new Date('2024-01-01T00:00:00Z'),
        updated_at: new Date('2024-01-01T00:00:00Z'),
      }],
      rowCount: 1,
    });

    const result = await instances.createFleetService({
      serviceId: 'rspamd-core',
      serviceType: 'rspamd',
      name: 'Rspamd Core',
      apiUrl: 'https://rspamd.example.test',
    });

    expect(result.serviceId).toBe('rspamd-core');
    expect(result.serviceType).toBe('rspamd');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO fleet_services'),
      [
        'rspamd-core',
        'rspamd',
        'Rspamd Core',
        null,
        'https://rspamd.example.test',
        null,
        'https://rspamd.example.test',
        null,
        null,
        null,
        true,
      ]
    );
  });

  it('returns nested fleet counts', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        total: '5',
        enabled: '4',
        robin_total: '3',
        robin_enabled: '2',
        rspamd_total: '2',
        rspamd_enabled: '2',
        clamav_total: '1',
        clamav_enabled: '0',
      }],
      rowCount: 1,
    });

    const result = await instances.getFleetServiceCount();

    expect(result).toEqual({
      total: 5,
      enabled: 4,
      byType: {
        robin: { total: 3, enabled: 2 },
        rspamd: { total: 2, enabled: 2 },
        clamav: { total: 1, enabled: 0 },
        // Registry-driven: every type is counted; absent columns default to 0.
        dovecot: { total: 0, enabled: 0 },
        cyrus: { total: 0, enabled: 0 },
        postfix: { total: 0, enabled: 0 },
        redis: { total: 0, enabled: 0 },
        postgres: { total: 0, enabled: 0 },
        mariadb: { total: 0, enabled: 0 },
      },
    });
  });

  it('maps a Robin service into the RobinInstance shape', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 11,
        service_id: 'robin-west',
        service_type: 'robin',
        name: 'Robin West',
        description: null,
        api_url: 'https://robin-west.example.test',
        health_url: null,
        metrics_url: null,
        controller_url: null,
        normal_url: null,
        enabled: true,
        created_at: new Date('2024-01-01T00:00:00Z'),
        updated_at: new Date('2024-01-02T00:00:00Z'),
      }],
      rowCount: 1,
    });

    const result = await instances.getInstanceById('robin-west');

    expect(result).toEqual({
      id: 11,
      serviceId: 'robin-west',
      serviceType: 'robin',
      name: 'Robin West',
      description: null,
      apiUrl: 'https://robin-west.example.test',
      apiAuth: null,
      healthUrl: null,
      metricsUrl: 'https://robin-west.example.test',
      controllerUrl: null,
      normalUrl: null,
      enabled: true,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-02T00:00:00Z'),
    });
  });
});

describe('agentAxesFor', () => {
  it('never assigns the config axis to a Cyrus agent', () => {
    expect(instances.agentAxesFor({ serviceType: 'cyrus', collectionMode: 'agent', agentId: 'a1', configAgentId: null, logAgentId: null }, 'a1')).toEqual({ collectMetrics: true, collectConfig: false, collectLogs: true });
    expect(instances.agentAxesFor({ serviceType: 'cyrus', collectionMode: 'agent', agentId: 'a1', configAgentId: 'a2', logAgentId: null }, 'a2').collectConfig).toBe(false);
  });
  const full = { collectionMode: 'agent' as const, agentId: 'a1', configAgentId: null, logAgentId: null };

  it('gives a full metrics agent every axis nobody else was named for', () => {
    expect(instances.agentAxesFor(full, 'a1')).toEqual({ collectMetrics: true, collectConfig: true, collectLogs: true });
  });

  it('leaves config and logs to the agents named for them', () => {
    const split = { ...full, configAgentId: 'a2', logAgentId: 'a3' };
    expect(instances.agentAxesFor(split, 'a1')).toEqual({ collectMetrics: true, collectConfig: false, collectLogs: false });
    expect(instances.agentAxesFor(split, 'a2')).toEqual({ collectMetrics: false, collectConfig: true, collectLogs: false });
    expect(instances.agentAxesFor(split, 'a3')).toEqual({ collectMetrics: false, collectConfig: false, collectLogs: true });
  });

  it('gives a direct service no axes from its metrics agent id', () => {
    expect(instances.agentAxesFor({ ...full, collectionMode: 'direct' as const }, 'a1')).toEqual({ collectMetrics: false, collectConfig: false, collectLogs: false });
  });
});
