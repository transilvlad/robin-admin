import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initializeSchema } from '../schema.js';
import { closePool, query } from '../connection.js';
import { resetAdminPasswordWithRecoveryToken } from './admins.js';

describe.skipIf(process.env.ROLLUP_IT_DB !== '1')('password recovery transaction (integration)', () => {
  beforeAll(async () => { await initializeSchema(); });
  afterAll(async () => { await closePool(); });

  it('consumes a token once under contention and revokes sessions atomically', async () => {
    const admin = (await query<{ id: number }>(
      `INSERT INTO admins (name, email, password_hash, role)
       VALUES ('Recovery test', 'recovery-transaction@example.test', 'old-hash', 'admin') RETURNING id`,
    )).rows[0];
    try {
      await query(`INSERT INTO admin_password_recovery_tokens (admin_id, token_hash, expires_at)
        VALUES ($1, 'recovery-transaction-test', CURRENT_TIMESTAMP + INTERVAL '1 minute')`, [admin.id]);
      await query(`INSERT INTO session (sid, sess, expire) VALUES ('recovery-transaction-test', $1::json, CURRENT_TIMESTAMP + INTERVAL '1 minute')`,
        [JSON.stringify({ admin: { id: admin.id } })]);
      const results = await Promise.all(Array.from({ length: 8 }, (_, index) => resetAdminPasswordWithRecoveryToken('recovery-transaction-test', `new-hash-${index}`)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await query('SELECT used_at FROM admin_password_recovery_tokens WHERE admin_id=$1', [admin.id])).rows[0].used_at).not.toBeNull();
      expect((await query("SELECT sid FROM session WHERE sid='recovery-transaction-test'")).rows).toHaveLength(0);
      const hash = (await query('SELECT password_hash FROM admins WHERE id=$1', [admin.id])).rows[0].password_hash;
      await expect(resetAdminPasswordWithRecoveryToken('recovery-transaction-test', 'reused-hash')).resolves.toBeNull();
      expect((await query('SELECT password_hash FROM admins WHERE id=$1', [admin.id])).rows[0].password_hash).toBe(hash);
    } finally {
      await query("DELETE FROM session WHERE sid='recovery-transaction-test'");
      await query('DELETE FROM admins WHERE id=$1', [admin.id]);
    }
  });
});
