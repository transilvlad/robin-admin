import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as configQueries from './config.js';
import * as configStore from './config-store.js';
import {
  checkTableHasSchema,
  getRobinConfigTableName,
  getRobinConfigTableSqlIdentifier,
  robinConfigTableHasSchema,
} from './robin-config-meta.js';

vi.mock('./config.js', () => ({ getConfig: vi.fn() }));
vi.mock('./config-store.js', () => ({ configStoreTableHasSchema: vi.fn() }));

const mockGetConfig = vi.mocked(configQueries.getConfig);
const mockHasSchema = vi.mocked(configStore.configStoreTableHasSchema);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockResolvedValue({
    robinConfigTableName: 'existing_robin_configs',
  } as Awaited<ReturnType<typeof configQueries.getConfig>>);
});

describe('Robin config-store metadata', () => {
  it('resolves and quotes the persisted custom table name', async () => {
    await expect(getRobinConfigTableName()).resolves.toBe('existing_robin_configs');
    await expect(getRobinConfigTableSqlIdentifier()).resolves.toBe('"existing_robin_configs"');
  });

  it('uses the configured table for schema readiness checks', async () => {
    mockHasSchema.mockResolvedValue(true);

    await expect(robinConfigTableHasSchema()).resolves.toBe(true);
    expect(mockHasSchema).toHaveBeenCalledWith('existing_robin_configs', 'server_id');
  });

  it('rejects invalid table names before schema queries', async () => {
    await expect(checkTableHasSchema('robin_config_store; DROP TABLE admins')).resolves.toBe(false);
    expect(mockHasSchema).not.toHaveBeenCalled();
  });
});
