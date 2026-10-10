import { query } from '../connection.js';

// Generic per-admin preference store (admin_preferences table). Values are
// arbitrary JSON keyed by (admin_id, key). Used for dashboard card layout and
// reusable for other per-admin UI state.

export async function getAdminPreference<T = unknown>(adminId: number, key: string): Promise<T | null> {
  const result = await query<{ value: T }>(
    'SELECT value FROM admin_preferences WHERE admin_id = $1 AND key = $2',
    [adminId, key],
  );
  return result.rows[0]?.value ?? null;
}

export async function setAdminPreference(adminId: number, key: string, value: unknown): Promise<void> {
  await query(
    `INSERT INTO admin_preferences (admin_id, key, value, updated_at)
     VALUES ($1, $2, $3::jsonb, CURRENT_TIMESTAMP)
     ON CONFLICT (admin_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
    [adminId, key, JSON.stringify(value ?? {})],
  );
}
