import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as connection from '../connection.js';
import * as fleetAgentSync from './fleet-agent-sync.js';

vi.mock('../connection.js');
vi.mock('./robin-config-meta.js', () => ({
  getRobinConfigTableName: vi.fn(async () => 'existing_robin_configs'),
}));

const mockQuery = vi.fn();

beforeEach(() => {
  mockQuery.mockReset();
  (connection.query as unknown as typeof mockQuery) = mockQuery;
});

describe('fleet agent sync queries', () => {
  it('lists robin config rows for default and service overrides', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          server_id: 'default',
          file_name: 'config.json5',
          payload_json: { foo: 'bar' },
          updated_epoch: 100,
          sha256: 'a'.repeat(64),
        },
        {
          server_id: 'robin-east',
          file_name: 'config.json5',
          payload_json: { nested: { enabled: true } },
          updated_epoch: 101,
          sha256: 'b'.repeat(64),
        },
      ],
      rowCount: 2,
    });

    const result = await fleetAgentSync.listRobinConfigStoreEntriesForService('robin-east');

    expect(result).toEqual([
      {
        ownerId: 'default',
        fileName: 'config.json5',
        payloadJson: { foo: 'bar' },
        updatedEpoch: 100,
        sha256: 'a'.repeat(64),
      },
      {
        ownerId: 'robin-east',
        fileName: 'config.json5',
        payloadJson: { nested: { enabled: true } },
        updatedEpoch: 101,
        sha256: 'b'.repeat(64),
      },
    ]);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('FROM "existing_robin_configs"'),
      ['robin-east']
    );
  });

  it('maps persisted sync status rows', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        service_id: 'rspamd-core',
        manifest_sha256: 'c'.repeat(64),
        manifest_etag: `"${'c'.repeat(64)}"`,
        manifest_file_count: 3,
        last_seen_at: new Date('2024-01-01T00:00:00Z'),
        last_manifest_pulled_at: new Date('2024-01-01T00:00:01Z'),
        last_file_pulled_at: new Date('2024-01-01T00:00:02Z'),
        last_apply_started_at: new Date('2024-01-01T00:00:03Z'),
        last_apply_finished_at: new Date('2024-01-01T00:00:04Z'),
        last_apply_status: 'succeeded',
        last_apply_error: null,
        last_applied_sha256: 'd'.repeat(64),
        last_applied_file_count: 3,
        agent_version: '1.2.3',
        metadata_json: { hostname: 'mx1' },
        created_at: new Date('2024-01-01T00:00:00Z'),
        updated_at: new Date('2024-01-01T00:00:05Z'),
      }],
      rowCount: 1,
    });

    const result = await fleetAgentSync.getFleetServiceSyncStatus('rspamd-core');

    expect(result).toEqual({
      serviceId: 'rspamd-core',
      manifestSha256: 'c'.repeat(64),
      manifestEtag: `"${'c'.repeat(64)}"`,
      manifestFileCount: 3,
      lastSeenAt: new Date('2024-01-01T00:00:00Z'),
      lastManifestPulledAt: new Date('2024-01-01T00:00:01Z'),
      lastFilePulledAt: new Date('2024-01-01T00:00:02Z'),
      lastApplyStartedAt: new Date('2024-01-01T00:00:03Z'),
      lastApplyFinishedAt: new Date('2024-01-01T00:00:04Z'),
      lastApplyStatus: 'succeeded',
      lastApplyError: null,
      lastAppliedSha256: 'd'.repeat(64),
      lastAppliedFileCount: 3,
      agentVersion: '1.2.3',
      metadataJson: { hostname: 'mx1' },
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:05Z'),
    });
  });

  it('upserts sync status patches', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        service_id: 'robin-east',
        manifest_sha256: 'e'.repeat(64),
        manifest_etag: `"${'e'.repeat(64)}"`,
        manifest_file_count: 4,
        last_seen_at: new Date('2024-01-01T00:00:00Z'),
        last_manifest_pulled_at: new Date('2024-01-01T00:00:00Z'),
        last_file_pulled_at: null,
        last_apply_started_at: null,
        last_apply_finished_at: null,
        last_apply_status: 'pending',
        last_apply_error: null,
        last_applied_sha256: null,
        last_applied_file_count: null,
        agent_version: 'agent-1',
        metadata_json: { hostname: 'mx-east' },
        created_at: new Date('2024-01-01T00:00:00Z'),
        updated_at: new Date('2024-01-01T00:00:01Z'),
      }],
      rowCount: 1,
    });

    const now = new Date('2024-01-01T00:00:00Z');
    const result = await fleetAgentSync.upsertFleetServiceSyncStatus('robin-east', {
      manifestSha256: 'e'.repeat(64),
      manifestEtag: `"${'e'.repeat(64)}"`,
      manifestFileCount: 4,
      lastSeenAt: now,
      lastManifestPulledAt: now,
      lastApplyStatus: 'pending',
      agentVersion: 'agent-1',
      metadataJson: { hostname: 'mx-east' },
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO fleet_service_sync_status'),
      [
        'robin-east',
        'e'.repeat(64),
        `"${'e'.repeat(64)}"`,
        4,
        now,
        now,
        'pending',
        'agent-1',
        JSON.stringify({ hostname: 'mx-east' }),
      ]
    );
    expect(result?.manifestSha256).toBe('e'.repeat(64));
  });
});
