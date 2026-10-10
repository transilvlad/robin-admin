import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initializeSchema } from '../schema.js';
import { closePool, query } from '../connection.js';
import { createAdmin, getAdminById, updateAdmin } from './admins.js';

describe.skipIf(process.env.ADMIN_IDENTITY_IT !== '1')('administrator UUID migration (integration)', () => {
  let original: { id: number; uid: string };

  beforeAll(async () => {
    if (!/^robin_test_admin_uid_[a-z0-9_]+$/.test(process.env.DB_NAME ?? '')
      || !['127.0.0.1', 'localhost'].includes(process.env.DB_HOST ?? '')) {
      throw new Error('A fresh disposable loopback administrator identity database is required');
    }
    const tables = await query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    if (tables.rows.length) throw new Error('Administrator identity migration requires an empty database');
    await query(`CREATE TABLE admins (
      id SERIAL PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL, role VARCHAR(20) NOT NULL DEFAULT 'viewer',
      allowed_cidrs TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, last_login TIMESTAMP,
      disabled BOOLEAN NOT NULL DEFAULT false
    )`);
    await query("INSERT INTO admins(name,email,password_hash,role) VALUES ('Original','original@example.test','fixture-hash','admin')");
    await initializeSchema();
    original = (await query<{ id: number; uid: string }>('SELECT id,uid FROM admins')).rows[0];
  }, 120000);

  afterAll(async () => { await closePool(); });

  it('backfills a UUID once and preserves it across repeated schema initialization', async () => {
    expect(original.uid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await initializeSchema();
    expect(await getAdminById(original.id)).toMatchObject(original);
  });

  it('creates independent identities and ignores UUID input during account edits', async () => {
    const admin = await createAdmin('Second', 'second@example.test', 'fixture-hash', 'viewer');
    expect(admin.uid).not.toBe(original.uid);
    expect(await updateAdmin(admin.id, { name: 'Renamed', email: 'changed@example.test', uid: original.uid } as Parameters<typeof updateAdmin>[1]))
      .toMatchObject({ id: admin.id, uid: admin.uid, name: 'Renamed', email: 'changed@example.test' });
  });

  it('enforces non-null and unique database identities', async () => {
    await expect(query("INSERT INTO admins(name,email,password_hash,uid) VALUES ('Bad','null@example.test','hash',NULL)"))
      .rejects.toMatchObject({ code: '23502' });
    await expect(query("INSERT INTO admins(name,email,password_hash,uid) VALUES ('Bad','duplicate@example.test','hash',$1)", [original.uid]))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('does not transfer an identity when an integer ID and email are reused', async () => {
    const admin = await createAdmin('Disposable', 'reuse@example.test', 'fixture-hash', 'viewer');
    await query('DELETE FROM admins WHERE id=$1', [admin.id]);
    await query("INSERT INTO admins(id,name,email,password_hash) VALUES ($1,'Replacement','reuse@example.test','fixture-hash')", [admin.id]);
    const replacement = await getAdminById(admin.id);
    expect(replacement?.id).toBe(admin.id);
    expect(replacement?.uid).not.toBe(admin.uid);
    expect(replacement?.uid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('records transactional account changes without credentials or login noise', async () => {
    const admin = await createAdmin('Events', 'events@example.test', 'fixture-hash', 'viewer');
    await updateAdmin(admin.id, { disabled: true });
    await updateAdmin(admin.id, { disabled: false, name: 'Renamed events' });
    await query('UPDATE admins SET last_login=NOW() WHERE id=$1', [admin.id]);
    await query('DELETE FROM admins WHERE id=$1', [admin.id]);
    const events = await query<{ kind: string; disabled: boolean }>('SELECT kind,disabled FROM admin_directory_events WHERE uid=$1 ORDER BY revision', [admin.uid]);
    expect(events.rows).toEqual([
      { kind: 'created', disabled: false }, { kind: 'updated', disabled: true },
      { kind: 'updated', disabled: false }, { kind: 'deleted', disabled: true },
    ]);
  });

  it('rolls back both lifecycle events and their commit-ordered cursor', async () => {
    const before = await query<{ revision: string }>('SELECT revision::text FROM admin_directory_revision');
    const { getClient } = await import('../connection.js');
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO admins(name,email,password_hash) VALUES ('Rollback','rollback@example.test','hash')");
      await client.query('ROLLBACK');
    } finally { client.release(); }
    expect((await query('SELECT revision::text FROM admin_directory_revision')).rows).toEqual(before.rows);
    expect((await query("SELECT uid FROM admins WHERE email='rollback@example.test'")).rows).toEqual([]);
  });

  it('persists an encrypted signing authority and signs request-bound UUID claims', async () => {
    process.env.ROBIN_ADMIN_ENCRYPTION_KEY = 'module-security-integration-fixture-only';
    const { getModuleIdentity, signModuleIdentity } = await import('../../services/module-identity.js');
    const { createIdentityVerifier } = await import('../../services/module-identity-protocol.js');
    const authority = await getModuleIdentity();
    const stored = await query<{ value: string }>("SELECT value FROM admin_config WHERE key='moduleIdentitySigningKey'");
    expect(stored.rows[0].value).not.toContain('PRIVATE KEY');
    expect(JSON.parse(stored.rows[0].value)).toHaveProperty('ciphertext');
    expect((await getModuleIdentity()).trust).toEqual(authority.trust);
    const body = Buffer.from('zone bytes');
    const assertion = await signModuleIdentity('example', { adminId: original.id, uid: original.uid, role: 'admin', name: 'Original', email: 'original@example.test' }, undefined, 'POST', '/upload', body, new Headers());
    const identity = await createIdentityVerifier(JSON.stringify(authority.trust), 'example', 0)(assertion, 'POST', '/upload', body);
    expect(identity.uid).toBe(original.uid);
  });
});
