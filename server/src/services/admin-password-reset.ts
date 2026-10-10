import { getAdminByEmail, updateAdmin } from '../db/queries/admins.js';
import { createAuditEntry } from '../db/queries/audit.js';
import { query } from '../db/connection.js';
import { hashAdminPassword, validatePasswordStrength } from './password.js';

export async function resetLocalAdminPassword(email: string, password: string): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error('Admin email is required');
  }

  const validation = validatePasswordStrength(password);
  if (!validation.valid) {
    throw new Error(validation.errors.join('; '));
  }

  const admin = await getAdminByEmail(normalizedEmail);
  if (!admin) {
    throw new Error('Admin account not found');
  }

  await updateAdmin(admin.id, { passwordHash: await hashAdminPassword(password) });
  await query('DELETE FROM admin_password_recovery_tokens WHERE admin_id = $1', [admin.id]);
  await query(`DELETE FROM session WHERE sess -> 'admin' ->> 'id' = $1`, [String(admin.id)]);
  await createAuditEntry(
    admin.id,
    'admin.password_reset_local',
    'admin',
    String(admin.id),
    null,
    { email: admin.email, method: 'local-cli' },
    null,
  );
}
