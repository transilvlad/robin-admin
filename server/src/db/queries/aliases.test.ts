/**
 * Unit tests for alias database queries (standard and auto-aliases).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as aliases from './aliases.js';
import * as connection from '../connection.js';

// Mock the connection module
vi.mock('../connection.js');

const mockQuery = vi.fn();

beforeEach(() => {
  mockQuery.mockClear();
  (connection.query as any) = mockQuery;
});

describe('Alias Queries - Standard Aliases', () => {
  describe('getAllAliases', () => {
    it('should return all aliases with default pagination', async () => {
      const mockAliases = [
        {
          id: 1,
          source: 'info@example.com',
          destination: 'admin@example.com',
        },
        {
          id: 2,
          source: 'support@example.com',
          destination: 'team@example.com',
        },
      ];

      // Mock count result
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 });
      // Mock aliases result
      mockQuery.mockResolvedValueOnce({ rows: mockAliases, rowCount: 2 });

      const result = await aliases.getAllAliases();

      expect(result.aliases).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.aliases[0].source).toBe('info@example.com');
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('should return paginated results', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '100' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await aliases.getAllAliases(2, 25);

      expect(result.total).toBe(100);
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('LIMIT $1 OFFSET $2'),
        [25, 25] // page 2 offset (1 * 25)
      );
    });

    it('should search aliases by source or destination', async () => {
      const mockSearchAliases = [
        {
          id: 1,
          source: 'info@example.com',
          destination: 'admin@example.com',
        },
      ];

      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: mockSearchAliases, rowCount: 1 });

      const result = await aliases.getAllAliases(1, 50, 'info');

      expect(result.aliases).toHaveLength(1);
      expect(result.total).toBe(1);
      // Check that search parameter is wrapped with %
      expect(mockQuery).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        ['%info%']
      );
    });

    it('should return empty array when no aliases found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await aliases.getAllAliases();

      expect(result.aliases).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should apply correct limit and offset', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '200' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await aliases.getAllAliases(3, 30);

      const secondCall = mockQuery.mock.calls[1];
      expect(secondCall[1]).toEqual([30, 60]); // page 3, limit 30: offset = (3-1) * 30
    });

    it('should order results by source and destination', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await aliases.getAllAliases();

      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('ORDER BY source, destination'),
        expect.any(Array)
      );
    });
  });

  describe('getAliasById', () => {
    it('should return alias by ID', async () => {
      const mockAlias = {
        id: 1,
        source: 'info@example.com',
        destination: 'admin@example.com',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockAlias], rowCount: 1 });

      const result = await aliases.getAliasById(1);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(1);
      expect(result?.source).toBe('info@example.com');
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT id, source, destination FROM aliases WHERE id = $1',
        [1]
      );
    });

    it('should return null when alias not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await aliases.getAliasById(999);

      expect(result).toBeNull();
    });
  });

  describe('createAlias', () => {
    it('should create a new alias', async () => {
      const mockAlias = {
        id: 1,
        source: 'newalias@example.com',
        destination: 'admin@example.com',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockAlias], rowCount: 1 });

      const result = await aliases.createAlias('NEWALIAS@EXAMPLE.COM', 'ADMIN@EXAMPLE.COM');

      expect(result.id).toBe(1);
      expect(result.source).toBe('newalias@example.com');
      expect(result.destination).toBe('admin@example.com');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO aliases'),
        ['newalias@example.com', 'admin@example.com']
      );
    });

    it('should lowercase source and destination', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 1,
          source: 'test@example.com',
          destination: 'user@example.com',
        }],
        rowCount: 1,
      });

      await aliases.createAlias('TEST@EXAMPLE.COM', 'USER@EXAMPLE.COM');

      const callArgs = mockQuery.mock.calls[0];
      expect(callArgs[1]).toEqual(['test@example.com', 'user@example.com']);
    });
  });

  describe('updateAlias', () => {
    it('should update alias source', async () => {
      const mockAlias = {
        id: 1,
        source: 'newsource@example.com',
        destination: 'admin@example.com',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockAlias], rowCount: 1 });

      const result = await aliases.updateAlias(1, { source: 'NEWSOURCE@EXAMPLE.COM' });

      expect(result?.source).toBe('newsource@example.com');
    });

    it('should update alias destination', async () => {
      const mockAlias = {
        id: 1,
        source: 'info@example.com',
        destination: 'newdest@example.com',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockAlias], rowCount: 1 });

      const result = await aliases.updateAlias(1, { destination: 'NEWDEST@EXAMPLE.COM' });

      expect(result?.destination).toBe('newdest@example.com');
    });

    it('should return null when alias not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await aliases.updateAlias(999, { source: 'test@example.com' });

      expect(result).toBeNull();
    });

    it('should return existing alias when no updates provided', async () => {
      const mockAlias = {
        id: 1,
        source: 'info@example.com',
        destination: 'admin@example.com',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockAlias], rowCount: 1 });

      const result = await aliases.updateAlias(1, {});

      expect(result?.id).toBe(1);
    });

    it('should update both source and destination', async () => {
      const mockAlias = {
        id: 1,
        source: 'newsource@example.com',
        destination: 'newdest@example.com',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockAlias], rowCount: 1 });

      const result = await aliases.updateAlias(1, {
        source: 'newsource@example.com',
        destination: 'newdest@example.com',
      });

      expect(result?.source).toBe('newsource@example.com');
      expect(result?.destination).toBe('newdest@example.com');
    });
  });

  describe('deleteAlias', () => {
    it('should delete alias successfully', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await aliases.deleteAlias(1);

      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(
        'DELETE FROM aliases WHERE id = $1',
        [1]
      );
    });

    it('should return false when alias not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await aliases.deleteAlias(999);

      expect(result).toBe(false);
    });

    it('should handle rowCount as undefined', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await aliases.deleteAlias(1);

      expect(result).toBe(false);
    });
  });
});

describe('Alias Queries - Auto-Aliases', () => {
  describe('getAllAutoAliases', () => {
    it('should return all auto-aliases with default pagination', async () => {
      const mockAutoAliases = [
        {
          id: 1,
          source: 'user@example.com',
          destination: 'group@example.com',
        },
        {
          id: 2,
          source: 'contact@example.com',
          destination: 'team@example.com',
        },
      ];

      mockQuery.mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: mockAutoAliases, rowCount: 2 });

      const result = await aliases.getAllAutoAliases();

      expect(result.aliases).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('should search auto-aliases by source or destination', async () => {
      const mockSearchAutoAliases = [
        {
          id: 1,
          source: 'user@example.com',
          destination: 'group@example.com',
        },
      ];

      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: mockSearchAutoAliases, rowCount: 1 });

      const result = await aliases.getAllAutoAliases(1, 50, 'group');

      expect(result.aliases).toHaveLength(1);
      expect(mockQuery).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        ['%group%']
      );
    });

    it('should apply pagination correctly to auto_aliases table', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '100' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await aliases.getAllAutoAliases(2, 25);

      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('FROM auto_aliases'),
        [25, 25]
      );
    });
  });

  describe('getAutoAliasById', () => {
    it('should return auto-alias by ID', async () => {
      const mockAutoAlias = {
        id: 1,
        source: 'user@example.com',
        destination: 'group@example.com',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockAutoAlias], rowCount: 1 });

      const result = await aliases.getAutoAliasById(1);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(1);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT id, source, destination FROM auto_aliases WHERE id = $1',
        [1]
      );
    });

    it('should return null when auto-alias not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await aliases.getAutoAliasById(999);

      expect(result).toBeNull();
    });
  });

  describe('createAutoAlias', () => {
    it('should create a new auto-alias', async () => {
      const mockAutoAlias = {
        id: 1,
        source: 'newauto@example.com',
        destination: 'group@example.com',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockAutoAlias], rowCount: 1 });

      const result = await aliases.createAutoAlias('NEWAUTO@EXAMPLE.COM', 'GROUP@EXAMPLE.COM');

      expect(result.id).toBe(1);
      expect(result.source).toBe('newauto@example.com');
      expect(result.destination).toBe('group@example.com');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO auto_aliases'),
        ['newauto@example.com', 'group@example.com']
      );
    });

    it('should lowercase source and destination when creating auto-alias', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 1,
          source: 'test@example.com',
          destination: 'group@example.com',
        }],
        rowCount: 1,
      });

      await aliases.createAutoAlias('TEST@EXAMPLE.COM', 'GROUP@EXAMPLE.COM');

      const callArgs = mockQuery.mock.calls[0];
      expect(callArgs[1]).toEqual(['test@example.com', 'group@example.com']);
    });
  });

  describe('updateAutoAlias', () => {
    it('should update auto-alias source', async () => {
      const mockAutoAlias = {
        id: 1,
        source: 'newsource@example.com',
        destination: 'group@example.com',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockAutoAlias], rowCount: 1 });

      const result = await aliases.updateAutoAlias(1, { source: 'NEWSOURCE@EXAMPLE.COM' });

      expect(result?.source).toBe('newsource@example.com');
    });

    it('should update auto-alias destination', async () => {
      const mockAutoAlias = {
        id: 1,
        source: 'user@example.com',
        destination: 'newgroup@example.com',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockAutoAlias], rowCount: 1 });

      const result = await aliases.updateAutoAlias(1, { destination: 'NEWGROUP@EXAMPLE.COM' });

      expect(result?.destination).toBe('newgroup@example.com');
    });

    it('should return null when auto-alias not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await aliases.updateAutoAlias(999, { source: 'test@example.com' });

      expect(result).toBeNull();
    });

    it('should return existing auto-alias when no updates provided', async () => {
      const mockAutoAlias = {
        id: 1,
        source: 'user@example.com',
        destination: 'group@example.com',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockAutoAlias], rowCount: 1 });

      const result = await aliases.updateAutoAlias(1, {});

      expect(result?.id).toBe(1);
    });
  });

  describe('deleteAutoAlias', () => {
    it('should delete auto-alias successfully', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await aliases.deleteAutoAlias(1);

      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(
        'DELETE FROM auto_aliases WHERE id = $1',
        [1]
      );
    });

    it('should return false when auto-alias not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await aliases.deleteAutoAlias(999);

      expect(result).toBe(false);
    });

    it('should handle rowCount as undefined', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await aliases.deleteAutoAlias(1);

      expect(result).toBe(false);
    });
  });
});

describe('Alias Queries - Counts and Status', () => {
  describe('countAliases', () => {
    it('should count total aliases', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ count: '15' }],
        rowCount: 1,
      });

      const result = await aliases.countAliases();

      expect(result).toBe(15);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT COUNT(*) as count FROM aliases'
      );
    });

    it('should return 0 when no aliases', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ count: '0' }],
        rowCount: 1,
      });

      const result = await aliases.countAliases();

      expect(result).toBe(0);
    });

    it('should handle missing count', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await aliases.countAliases();

      expect(result).toBe(0);
    });
  });

  describe('countAutoAliases', () => {
    it('should count total auto-aliases', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ count: '8' }],
        rowCount: 1,
      });

      const result = await aliases.countAutoAliases();

      expect(result).toBe(8);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT COUNT(*) as count FROM auto_aliases'
      );
    });

    it('should return 0 when no auto-aliases', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ count: '0' }],
        rowCount: 1,
      });

      const result = await aliases.countAutoAliases();

      expect(result).toBe(0);
    });

    it('should handle missing count', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await aliases.countAutoAliases();

      expect(result).toBe(0);
    });
  });

  describe('aliasesTableExists', () => {
    it('should return true when aliases table exists', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ exists: true }],
        rowCount: 1,
      });

      const result = await aliases.aliasesTableExists();

      expect(result).toBe(true);
    });

    it('should return false when aliases table does not exist', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ exists: false }],
        rowCount: 1,
      });

      const result = await aliases.aliasesTableExists();

      expect(result).toBe(false);
    });

    it('should return false on query error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Query failed'));

      const result = await aliases.aliasesTableExists();

      expect(result).toBe(false);
    });

    it('should return false when exists is undefined', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await aliases.aliasesTableExists();

      expect(result).toBe(false);
    });
  });

  describe('autoAliasesTableExists', () => {
    it('should return true when auto_aliases table exists', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ exists: true }],
        rowCount: 1,
      });

      const result = await aliases.autoAliasesTableExists();

      expect(result).toBe(true);
    });

    it('should return false when auto_aliases table does not exist', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ exists: false }],
        rowCount: 1,
      });

      const result = await aliases.autoAliasesTableExists();

      expect(result).toBe(false);
    });

    it('should return false on query error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Query failed'));

      const result = await aliases.autoAliasesTableExists();

      expect(result).toBe(false);
    });

    it('should return false when exists is undefined', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await aliases.autoAliasesTableExists();

      expect(result).toBe(false);
    });
  });
});

describe('Alias Queries - Error Handling', () => {
  it('should propagate database errors from getAllAliases', async () => {
    const error = new Error('Database connection failed');
    mockQuery.mockRejectedValueOnce(error);

    await expect(aliases.getAllAliases()).rejects.toThrow('Database connection failed');
  });

  it('should propagate database errors from getAliasById', async () => {
    const error = new Error('Query error');
    mockQuery.mockRejectedValueOnce(error);

    await expect(aliases.getAliasById(1)).rejects.toThrow('Query error');
  });

  it('should propagate database errors from createAlias', async () => {
    const error = new Error('Unique constraint violation');
    mockQuery.mockRejectedValueOnce(error);

    await expect(
      aliases.createAlias('test@example.com', 'dest@example.com')
    ).rejects.toThrow('Unique constraint violation');
  });

  it('should propagate database errors from deleteAlias', async () => {
    const error = new Error('Deletion failed');
    mockQuery.mockRejectedValueOnce(error);

    await expect(aliases.deleteAlias(1)).rejects.toThrow('Deletion failed');
  });

  it('should propagate database errors from getAllAutoAliases', async () => {
    const error = new Error('Database connection failed');
    mockQuery.mockRejectedValueOnce(error);

    await expect(aliases.getAllAutoAliases()).rejects.toThrow('Database connection failed');
  });

  it('should propagate database errors from createAutoAlias', async () => {
    const error = new Error('Unique constraint violation');
    mockQuery.mockRejectedValueOnce(error);

    await expect(
      aliases.createAutoAlias('test@example.com', 'dest@example.com')
    ).rejects.toThrow('Unique constraint violation');
  });

  it('should propagate database errors from countAliases', async () => {
    const error = new Error('Query error');
    mockQuery.mockRejectedValueOnce(error);

    await expect(aliases.countAliases()).rejects.toThrow('Query error');
  });
});

describe('Alias Queries - Edge Cases', () => {
  it('should handle email with special characters in source', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await aliases.getAliasById(1);

    expect(mockQuery).toHaveBeenCalled();
  });

  it('should handle very long email addresses', async () => {
    const longEmail = 'a'.repeat(100) + '@example.com';
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 1,
        source: longEmail,
        destination: 'dest@example.com',
      }],
      rowCount: 1,
    });

    const result = await aliases.createAlias(longEmail, 'dest@example.com');

    expect(result.source).toBe(longEmail.toLowerCase());
  });

  it('should handle search with special characters', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await aliases.getAllAliases(1, 50, 'test+tag@');

    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      ['%test+tag@%']
    );
  });

  it('should handle large pagination numbers for aliases', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '10000' }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await aliases.getAllAliases(100, 100);

    const secondCall = mockQuery.mock.calls[1];
    expect(secondCall[1]).toEqual([100, 9900]); // page 100, limit 100
  });

  it('should handle large pagination numbers for auto-aliases', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '10000' }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await aliases.getAllAutoAliases(100, 100);

    const secondCall = mockQuery.mock.calls[1];
    expect(secondCall[1]).toEqual([100, 9900]); // page 100, limit 100
  });

  it('should handle subdomain emails in aliases', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 1,
        source: 'user@mail.example.com',
        destination: 'admin@mail.example.com',
      }],
      rowCount: 1,
    });

    const result = await aliases.createAlias('user@mail.example.com', 'admin@mail.example.com');

    expect(result.source).toContain('mail.example.com');
    expect(result.destination).toContain('mail.example.com');
  });

  it('should handle mixed case in search', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await aliases.getAllAliases(1, 50, 'InFo@ExAmPlE');

    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      ['%InFo@ExAmPlE%']
    );
  });
});
