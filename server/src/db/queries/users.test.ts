/**
 * Unit tests for mail user database queries.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as users from './users.js';
import * as connection from '../connection.js';

// Mock the connection module
vi.mock('../connection.js');

const mockQuery = vi.fn();
const fullSchemaRows = ['id', 'email', 'password', 'uid', 'gid', 'home', 'maildir'].map(
  (column_name) => ({ column_name })
);

beforeEach(async () => {
  users.resetUsersSchemaCacheForTests();
  mockQuery.mockReset();
  (connection.query as any) = mockQuery;
  mockQuery.mockResolvedValueOnce({ rows: fullSchemaRows, rowCount: fullSchemaRows.length });
  await users.getUsersSchema();
  mockQuery.mockReset();
});

describe('Mail User Queries', () => {
  describe('schema validation', () => {
    it('supports minimal schemas but rejects unsupported writes instead of dropping fields', async () => {
      users.resetUsersSchemaCacheForTests();
      mockQuery.mockResolvedValueOnce({ rows: ['id', 'email', 'password'].map(column_name => ({ column_name })) });
      expect(await users.getUsersSchema()).toMatchObject({ knownOptional: [], extraColumns: [] });
      mockQuery.mockClear();
      await expect(users.createUser('person@example.test', 'hash', 5000)).rejects.toThrow('uid is not supported');
      await expect(users.updateUser(1, { gid: 5000 })).rejects.toThrow('gid is not supported');
      await expect(users.updateUser(1, { extra: { email: 'ignored@example.test' } })).rejects.toThrow('Unsupported mailbox extra fields');
      expect(mockQuery).not.toHaveBeenCalled();
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, email: 'person@example.test' }] });
      expect((await users.createUser('person@example.test', 'hash')).email).toBe('person@example.test');
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO users ("email", "password")'), ['person@example.test', 'hash']);
    });

    it.each([-1, 1.5, 2147483648, '5000', null])('rejects invalid numeric mailbox fields: %s', async uid => {
      await expect(users.updateUser(1, { uid: uid as never })).rejects.toThrow('non-negative database integer');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rechecks missing schemas so configuration does not require a restart', async () => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(10000);
      try {
        users.resetUsersSchemaCacheForTests();
        mockQuery.mockResolvedValueOnce({ rows: [] });
        expect(await users.tableExists()).toBe(false);
        expect(await users.tableExists()).toBe(false);
        clock.mockReturnValue(15001);
        mockQuery.mockResolvedValueOnce({ rows: fullSchemaRows });
        expect(await users.tableExists()).toBe(true);
        expect(mockQuery).toHaveBeenCalledTimes(2);
      } finally { clock.mockRestore(); }
    });
  });
  describe('getAllUsers', () => {
    it('should return all users with default pagination', async () => {
      const mockUsers = [
        {
          id: 1,
          email: 'user1@example.com',
          uid: 5000,
          gid: 5000,
          home: '/var/mail/vhosts/example.com/user1',
          maildir: 'maildir:/var/mail/vhosts/example.com/user1',
        },
        {
          id: 2,
          email: 'user2@example.com',
          uid: 5000,
          gid: 5000,
          home: '/var/mail/vhosts/example.com/user2',
          maildir: 'maildir:/var/mail/vhosts/example.com/user2',
        },
      ];

      // Mock count result
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 });
      // Mock users result
      mockQuery.mockResolvedValueOnce({ rows: mockUsers, rowCount: 2 });

      const result = await users.getAllUsers();

      expect(result.users).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.users[0].email).toBe('user1@example.com');
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('should return paginated results', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '100' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await users.getAllUsers(2, 25);

      expect(result.total).toBe(100);
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('LIMIT $1 OFFSET $2'),
        [25, 25] // page 2 offset (1 * 25)
      );
    });

    it('should search users by email', async () => {
      const mockSearchUsers = [
        {
          id: 1,
          email: 'john@example.com',
          uid: 5000,
          gid: 5000,
          home: '/var/mail/vhosts/example.com/john',
          maildir: 'maildir:/var/mail/vhosts/example.com/john',
        },
      ];

      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: mockSearchUsers, rowCount: 1 });

      const result = await users.getAllUsers(1, 50, 'john');

      expect(result.users).toHaveLength(1);
      expect(result.total).toBe(1);
      // Check that search parameter is wrapped with %
      expect(mockQuery).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        ['%john%']
      );
    });

    it('should return empty array when no users found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await users.getAllUsers();

      expect(result.users).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should handle invalid count value', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await users.getAllUsers();

      expect(result.total).toBe(0);
    });

    it('should apply correct limit and offset', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '200' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await users.getAllUsers(3, 30);

      const secondCall = mockQuery.mock.calls[1];
      expect(secondCall[1]).toEqual([30, 60]); // page 3, limit 30: offset = (3-1) * 30
    });
  });

  describe('getUserById', () => {
    it('should return user by ID', async () => {
      const mockUser = {
        id: 1,
        email: 'user@example.com',
        uid: 5000,
        gid: 5000,
        home: '/var/mail/vhosts/example.com/user',
        maildir: 'maildir:/var/mail/vhosts/example.com/user',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      const result = await users.getUserById(1);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(1);
      expect(result?.email).toBe('user@example.com');
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT id, email, "uid", "gid", "home", "maildir" FROM users WHERE id = $1',
        [1]
      );
    });

    it('should return null when user not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await users.getUserById(999);

      expect(result).toBeNull();
    });

    it('should handle null home and maildir', async () => {
      const mockUser = {
        id: 1,
        email: 'user@example.com',
        uid: 5000,
        gid: 5000,
        home: null,
        maildir: null,
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      const result = await users.getUserById(1);

      expect(result?.home).toBeNull();
      expect(result?.maildir).toBeNull();
    });
  });

  describe('getUserByEmail', () => {
    it('should return user by email', async () => {
      const mockUser = {
        id: 1,
        email: 'user@example.com',
        uid: 5000,
        gid: 5000,
        home: '/var/mail/vhosts/example.com/user',
        maildir: 'maildir:/var/mail/vhosts/example.com/user',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      const result = await users.getUserByEmail('USER@EXAMPLE.COM');

      expect(result).not.toBeNull();
      expect(result?.email).toBe('user@example.com');
      // Email should be lowercased
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT id, email, "uid", "gid", "home", "maildir" FROM users WHERE email = $1',
        ['user@example.com']
      );
    });

    it('should return null when user email not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await users.getUserByEmail('nonexistent@example.com');

      expect(result).toBeNull();
    });

    it('should lowercase email before querying', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await users.getUserByEmail('TEST@EXAMPLE.COM');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['test@example.com']
      );
    });
  });

  describe('createUser', () => {
    it('should create a new user with default uid/gid', async () => {
      const mockUser = {
        id: 1,
        email: 'newuser@example.com',
        uid: 5000,
        gid: 5000,
        home: '/var/mail/vhosts/example.com/newuser',
        maildir: 'maildir:/var/mail/vhosts/example.com/newuser',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      const result = await users.createUser('NEWUSER@EXAMPLE.COM', '{SHA512-CRYPT}hash');

      expect(result.id).toBe(1);
      expect(result.email).toBe('newuser@example.com');
      expect(result.uid).toBe(5000);
      expect(result.gid).toBe(5000);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users'),
        ['newuser@example.com', '{SHA512-CRYPT}hash', 5000, 5000, expect.any(String), expect.any(String)]
      );
    });

    it('should create a user with custom uid/gid', async () => {
      const mockUser = {
        id: 1,
        email: 'newuser@example.com',
        uid: 2000,
        gid: 2000,
        home: '/var/mail/vhosts/example.com/newuser',
        maildir: 'maildir:/var/mail/vhosts/example.com/newuser',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      const result = await users.createUser('newuser@example.com', '{SHA512-CRYPT}hash', 2000, 2000);

      expect(result.uid).toBe(2000);
      expect(result.gid).toBe(2000);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['newuser@example.com', '{SHA512-CRYPT}hash', 2000, 2000, expect.any(String), expect.any(String)]
      );
    });

    it('should generate correct paths from email', async () => {
      const mockUser = {
        id: 1,
        email: 'testuser@mydomain.org',
        uid: 5000,
        gid: 5000,
        home: '/var/mail/vhosts/mydomain.org/testuser',
        maildir: 'maildir:/var/mail/vhosts/mydomain.org/testuser',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      const result = await users.createUser('testuser@mydomain.org', '{SHA512-CRYPT}hash');

      expect(result.home).toBe('/var/mail/vhosts/mydomain.org/testuser');
      expect(result.maildir).toBe('maildir:/var/mail/vhosts/mydomain.org/testuser');
    });

    it('should lowercase email when creating user', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 1,
          email: 'test@example.com',
          uid: 5000,
          gid: 5000,
          home: '/var/mail/vhosts/example.com/test',
          maildir: 'maildir:/var/mail/vhosts/example.com/test',
        }],
        rowCount: 1,
      });

      await users.createUser('TEST@EXAMPLE.COM', '{SHA512-CRYPT}hash');

      const callArgs = mockQuery.mock.calls[0];
      expect(callArgs[1][0]).toBe('test@example.com');
    });
  });

  describe('updateUser', () => {
    it('should update user email', async () => {
      const mockUser = {
        id: 1,
        email: 'newemail@example.com',
        uid: 5000,
        gid: 5000,
        home: '/var/mail/vhosts/example.com/newemail',
        maildir: 'maildir:/var/mail/vhosts/example.com/newemail',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      const result = await users.updateUser(1, { email: 'NEWEMAIL@EXAMPLE.COM' });

      expect(result?.email).toBe('newemail@example.com');
      expect(result?.home).toBe('/var/mail/vhosts/example.com/newemail');
      expect(result?.maildir).toBe('maildir:/var/mail/vhosts/example.com/newemail');
    });

    it('should update user password', async () => {
      const mockUser = {
        id: 1,
        email: 'user@example.com',
        uid: 5000,
        gid: 5000,
        home: '/var/mail/vhosts/example.com/user',
        maildir: 'maildir:/var/mail/vhosts/example.com/user',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      const result = await users.updateUser(1, { passwordHash: '{SHA512-CRYPT}newhash' });

      expect(result).not.toBeNull();
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE users SET'),
        expect.arrayContaining(['{SHA512-CRYPT}newhash', 1])
      );
    });

    it('should update user uid', async () => {
      const mockUser = {
        id: 1,
        email: 'user@example.com',
        uid: 3000,
        gid: 5000,
        home: '/var/mail/vhosts/example.com/user',
        maildir: 'maildir:/var/mail/vhosts/example.com/user',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      const result = await users.updateUser(1, { uid: 3000 });

      expect(result?.uid).toBe(3000);
    });

    it('should update user gid', async () => {
      const mockUser = {
        id: 1,
        email: 'user@example.com',
        uid: 5000,
        gid: 3000,
        home: '/var/mail/vhosts/example.com/user',
        maildir: 'maildir:/var/mail/vhosts/example.com/user',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      const result = await users.updateUser(1, { gid: 3000 });

      expect(result?.gid).toBe(3000);
    });

    it('should return null when user not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await users.updateUser(999, { email: 'test@example.com' });

      expect(result).toBeNull();
    });

    it('should return existing user when no updates provided', async () => {
      const mockUser = {
        id: 1,
        email: 'user@example.com',
        uid: 5000,
        gid: 5000,
        home: '/var/mail/vhosts/example.com/user',
        maildir: 'maildir:/var/mail/vhosts/example.com/user',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      const result = await users.updateUser(1, {});

      expect(result?.id).toBe(1);
      expect(result?.email).toBe('user@example.com');
    });

    it('should update multiple fields', async () => {
      const mockUser = {
        id: 1,
        email: 'newemail@example.com',
        uid: 3000,
        gid: 3000,
        home: '/var/mail/vhosts/example.com/newemail',
        maildir: 'maildir:/var/mail/vhosts/example.com/newemail',
      };

      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      const result = await users.updateUser(1, {
        email: 'newemail@example.com',
        uid: 3000,
        gid: 3000,
      });

      expect(result?.email).toBe('newemail@example.com');
      expect(result?.uid).toBe(3000);
      expect(result?.gid).toBe(3000);
    });
  });

  describe('deleteUser', () => {
    it('should delete user successfully', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await users.deleteUser(1);

      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(
        'DELETE FROM users WHERE id = $1',
        [1]
      );
    });

    it('should return false when user not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await users.deleteUser(999);

      expect(result).toBe(false);
    });

    it('should handle rowCount as undefined', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await users.deleteUser(1);

      expect(result).toBe(false);
    });
  });

  describe('countUsers', () => {
    it('should count total users', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ count: '42' }],
        rowCount: 1,
      });

      const result = await users.countUsers();

      expect(result).toBe(42);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT COUNT(*) as count FROM users'
      );
    });

    it('should return 0 when no users', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ count: '0' }],
        rowCount: 1,
      });

      const result = await users.countUsers();

      expect(result).toBe(0);
    });

    it('should handle missing count', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await users.countUsers();

      expect(result).toBe(0);
    });
  });

  describe('tableExists', () => {
    beforeEach(() => {
      users.resetUsersSchemaCacheForTests();
      mockQuery.mockReset();
    });

    it('should return true when users table exists', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: fullSchemaRows,
        rowCount: fullSchemaRows.length,
      });

      const result = await users.tableExists();

      expect(result).toBe(true);
    });

    it('should return false when users table does not exist', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      const result = await users.tableExists();

      expect(result).toBe(false);
    });

    it('should return false on query error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Query failed'));

      const result = await users.tableExists();

      expect(result).toBe(false);
    });

    it('should return false when required columns are missing', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ column_name: 'email' }],
        rowCount: 1,
      });

      const result = await users.tableExists();

      expect(result).toBe(false);
    });
  });

  describe('Error handling', () => {
    it('should propagate database errors from getAllUsers', async () => {
      const error = new Error('Database connection failed');
      mockQuery.mockRejectedValueOnce(error);

      await expect(users.getAllUsers()).rejects.toThrow('Database connection failed');
    });

    it('should propagate database errors from getUserById', async () => {
      const error = new Error('Query error');
      mockQuery.mockRejectedValueOnce(error);

      await expect(users.getUserById(1)).rejects.toThrow('Query error');
    });

    it('should propagate database errors from createUser', async () => {
      const error = new Error('Unique constraint violation');
      mockQuery.mockRejectedValueOnce(error);

      await expect(users.createUser('test@example.com', 'hash')).rejects.toThrow('Unique constraint violation');
    });

    it('should propagate database errors from updateUser', async () => {
      const error = new Error('Foreign key violation');
      mockQuery.mockRejectedValueOnce(error);

      await expect(users.updateUser(1, { uid: 3000 })).rejects.toThrow('Foreign key violation');
    });

    it('should propagate database errors from deleteUser', async () => {
      const error = new Error('Deletion failed');
      mockQuery.mockRejectedValueOnce(error);

      await expect(users.deleteUser(1)).rejects.toThrow('Deletion failed');
    });
  });

  describe('Edge cases', () => {
    it('should handle email with special characters', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await users.getUserByEmail('test+tag@example.co.uk');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['test+tag@example.co.uk']
      );
    });

    it('should handle very long email addresses', async () => {
      const longEmail = 'a'.repeat(100) + '@example.com';
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await users.getUserByEmail(longEmail);

      expect(mockQuery).toHaveBeenCalled();
    });

    it('should handle subdomain emails', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 1,
          email: 'user@mail.example.com',
          uid: 5000,
          gid: 5000,
          home: '/var/mail/vhosts/mail.example.com/user',
          maildir: 'maildir:/var/mail/vhosts/mail.example.com/user',
        }],
        rowCount: 1,
      });

      const result = await users.createUser('user@mail.example.com', 'hash');

      expect(result.home).toContain('mail.example.com');
    });

    it('should handle large pagination numbers', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '10000' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await users.getAllUsers(100, 100);

      const secondCall = mockQuery.mock.calls[1];
      expect(secondCall[1]).toEqual([100, 9900]); // page 100, limit 100
    });

    it('should handle case-insensitive search', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await users.getAllUsers(1, 50, 'UsEr@ExAmPlE.CoM');

      expect(mockQuery).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        ['%UsEr@ExAmPlE.CoM%']
      );
    });
  });
});
