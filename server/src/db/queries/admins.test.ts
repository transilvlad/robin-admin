import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as admins from './admins.js';
import * as connection from '../connection.js';

vi.mock('../connection.js');

const mockQuery = vi.fn();

beforeEach(() => {
  mockQuery.mockReset();
  (connection.query as unknown as typeof mockQuery) = mockQuery;
});

describe('admins queries', () => {
  it('rolls back a failed password recovery without consuming the token', async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 8, admin_id: 2, email: 'admin@example.test' }] })
      .mockRejectedValueOnce(new Error('database unavailable'));
    const release = vi.fn();
    vi.mocked(connection.getClient).mockResolvedValue({ query: clientQuery, release } as never);
    await expect(admins.resetAdminPasswordWithRecoveryToken('token-hash', 'password-hash')).rejects.toThrow('database unavailable');
    expect(clientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('SET used_at'))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it('maps name, allowed cidrs, and disabled fields when listing admins', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 1,
        uid: 'aee695ef-d8d7-4e15-a27e-e47e9b2b0ce4',
        name: 'Robin Admin',
        email: 'admin@example.com',
        role: 'admin',
        allowed_cidrs: '203.0.113.0/24\n2001:db8::/32',
        created_at: new Date('2024-01-01T00:00:00Z'),
        updated_at: new Date('2024-01-02T00:00:00Z'),
        last_login: new Date('2024-01-03T00:00:00Z'),
        disabled: false,
      }],
    });

    const result = await admins.getAllAdmins();

    expect(result).toEqual([{
      id: 1,
      uid: 'aee695ef-d8d7-4e15-a27e-e47e9b2b0ce4',
      name: 'Robin Admin',
      email: 'admin@example.com',
      role: 'admin',
      allowedCidrs: ['203.0.113.0/24', '2001:db8::/32'],
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-02T00:00:00Z'),
      lastLogin: new Date('2024-01-03T00:00:00Z'),
      disabled: false,
    }]);
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT id, uid, name, email, role, allowed_cidrs, created_at, updated_at, last_login, disabled FROM admins ORDER BY id'
    );
  });

  it('lowercases email and persists allowed cidrs and disabled when creating admins', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 2,
        name: 'Ops',
        email: 'ops@example.com',
        role: 'editor',
        allowed_cidrs: '198.51.100.0/24',
        created_at: new Date(),
        updated_at: new Date(),
        last_login: null,
        disabled: true,
      }],
    });

    const result = await admins.createAdmin('Ops', 'OPS@EXAMPLE.COM', 'hash', 'editor', ['198.51.100.0/24'], true);

    expect(result.name).toBe('Ops');
    expect(result.email).toBe('ops@example.com');
    expect(result.allowedCidrs).toEqual(['198.51.100.0/24']);
    expect(result.disabled).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admins (name, email, password_hash, role, allowed_cidrs, disabled)'),
      ['Ops', 'ops@example.com', 'hash', 'editor', '198.51.100.0/24', true]
    );
  });

  it('updates name, allowed cidrs, and disabled state', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 3,
        name: 'Updated Name',
        email: 'admin@example.com',
        role: 'admin',
        allowed_cidrs: '203.0.113.10/32',
        created_at: new Date(),
        updated_at: new Date(),
        last_login: null,
        disabled: true,
      }],
    });

    const result = await admins.updateAdmin(3, { name: 'Updated Name', allowedCidrs: ['203.0.113.10/32'], disabled: true });

    expect(result?.name).toBe('Updated Name');
    expect(result?.allowedCidrs).toEqual(['203.0.113.10/32']);
    expect(result?.disabled).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE admins SET'),
      ['Updated Name', '203.0.113.10/32', true, 3]
    );
  });

  it('includes password hash when fetching by email', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 4,
        name: 'Viewer',
        email: 'viewer@example.com',
        password_hash: 'hashed',
        role: 'viewer',
        allowed_cidrs: null,
        created_at: new Date(),
        updated_at: new Date(),
        last_login: null,
        disabled: false,
      }],
    });

    const result = await admins.getAdminByEmail('VIEWER@EXAMPLE.COM');

    expect(result?.passwordHash).toBe('hashed');
    expect(result?.name).toBe('Viewer');
    expect(result?.allowedCidrs).toEqual([]);
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT id, uid, name, email, password_hash, role, allowed_cidrs, created_at, updated_at, last_login, disabled FROM admins WHERE email = $1',
      ['viewer@example.com']
    );
  });

  it('counts only enabled admins', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '2' }] });

    const result = await admins.countActiveAdmins();

    expect(result).toBe(2);
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT COUNT(*) as count FROM admins WHERE disabled = false'
    );
  });
});
