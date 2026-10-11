import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as connection from '../connection.js';
import { validatePostgresIdentifier } from '../postgres-identifier.js';
import {
  configStoreTableHasSchema,
  getConfigStorePayload,
  upsertConfigStorePayload,
} from './config-store.js';

vi.mock('../connection.js');

const mockQuery = vi.fn();

beforeEach(() => {
  mockQuery.mockReset();
  (connection.query as unknown as typeof mockQuery) = mockQuery;
});

describe('config store table identifiers', () => {
  it('uses a quoted custom table for reads and writes', async () => {
    const tableName = validatePostgresIdentifier('existing_robin_configs');
    mockQuery
      .mockResolvedValueOnce({ rows: [{ payload_json: { enabled: true } }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(
      getConfigStorePayload(tableName, 'server_id', 'default', 'server.json5')
    ).resolves.toEqual({ enabled: true });
    await upsertConfigStorePayload(
      tableName,
      'server_id',
      'default',
      'server.json5',
      { enabled: false }
    );

    expect(mockQuery.mock.calls[0][0]).toContain('FROM "existing_robin_configs"');
    expect(mockQuery.mock.calls[1][0]).toContain('INSERT INTO "existing_robin_configs"');
  });

  it('checks custom tables by raw catalog name', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { column_name: 'server_id' },
        { column_name: 'file_name' },
        { column_name: 'payload_json' },
        { column_name: 'updated_epoch' },
        { column_name: 'sha256' },
      ],
    }).mockResolvedValueOnce({
      rows: [{ columns: ['server_id', 'file_name'] }],
    });

    await expect(
      configStoreTableHasSchema(validatePostgresIdentifier('existing_robin_configs'), 'server_id')
    ).resolves.toBe(true);
    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('information_schema.columns'),
      ['existing_robin_configs']
    );
  });

  it('rejects a column-compatible table without the required unique key', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { column_name: 'server_id' },
          { column_name: 'file_name' },
          { column_name: 'payload_json' },
          { column_name: 'updated_epoch' },
          { column_name: 'sha256' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      configStoreTableHasSchema(validatePostgresIdentifier('existing_robin_configs'), 'server_id')
    ).resolves.toBe(false);
  });
});
