import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLocalAdminPassword } from './admin-password-reset.js';
import { getAdminByEmail, updateAdmin } from '../db/queries/admins.js';
import { createAuditEntry } from '../db/queries/audit.js';
import { query } from '../db/connection.js';
import { hashAdminPassword } from './password.js';

vi.mock('../db/queries/admins.js', () => ({
  getAdminByEmail: vi.fn(),
  updateAdmin: vi.fn(),
}));
vi.mock('../db/queries/audit.js', () => ({ createAuditEntry: vi.fn() }));
vi.mock('../db/connection.js', () => ({ query: vi.fn() }));
vi.mock('./password.js', () => ({
  hashAdminPassword: vi.fn().mockResolvedValue('hashed'),
  validatePasswordStrength: vi.fn((password: string) => ({
    valid: password === 'StrongPass1',
    errors: password === 'StrongPass1' ? [] : ['weak password'],
  })),
}));

describe('resetLocalAdminPassword', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates the password, invalidates recovery tokens, and audits locally', async () => {
    vi.mocked(getAdminByEmail).mockResolvedValue({ id: 7, email: 'admin@example.com' } as never);
    vi.mocked(updateAdmin).mockResolvedValue({ id: 7 } as never);

    await resetLocalAdminPassword(' Admin@Example.com ', 'StrongPass1');

    expect(hashAdminPassword).toHaveBeenCalledWith('StrongPass1');
    expect(updateAdmin).toHaveBeenCalledWith(7, { passwordHash: 'hashed' });
    expect(query).toHaveBeenCalledWith(
      'DELETE FROM admin_password_recovery_tokens WHERE admin_id = $1',
      [7],
    );
    expect(query).toHaveBeenCalledWith(
      `DELETE FROM session WHERE sess -> 'admin' ->> 'id' = $1`,
      ['7'],
    );
    expect(createAuditEntry).toHaveBeenCalledWith(
      7,
      'admin.password_reset_local',
      'admin',
      '7',
      null,
      { email: 'admin@example.com', method: 'local-cli' },
      null,
    );
  });

  it('rejects weak passwords before querying for an admin', async () => {
    await expect(resetLocalAdminPassword('admin@example.com', 'weak')).rejects.toThrow('weak password');
    expect(getAdminByEmail).not.toHaveBeenCalled();
  });
});
