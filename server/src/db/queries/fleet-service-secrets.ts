import { query } from '../connection.js';
import { logger } from '../../logger.js';
import {
  decryptStoredSecret,
  encryptStoredSecret,
  ENCRYPTION_KEY_VERSION,
} from './secret-crypto.js';

export const RSPAMD_CONTROLLER_PASSWORD_SECRET = 'controller_password';
export const RSPAMD_ENABLE_PASSWORD_SECRET = 'enable_password';

export async function getFleetServiceSecret(serviceId: string, secretType: string): Promise<string | null> {
  const result = await query<{ encrypted_secret: string }>(
    `SELECT encrypted_secret
     FROM fleet_service_secrets
     WHERE service_id = $1 AND secret_type = $2`,
    [serviceId, secretType]
  );
  const encryptedSecret = result.rows[0]?.encrypted_secret;
  if (!encryptedSecret) return null;
  try {
    return decryptStoredSecret(encryptedSecret);
  } catch (error) {
    // Unreadable (e.g. SESSION_SECRET changed): treat as unset so the secret
    // is re-entered or rotated rather than used as ciphertext.
    logger.error('Fleet service secret could not be decrypted', { serviceId, secretType, error: (error as Error).message });
    return null;
  }
}

export async function getFleetServiceSecrets(
  serviceId: string,
  secretTypes: string[]
): Promise<Record<string, string | null>> {
  const entries = await Promise.all(
    secretTypes.map(async (secretType) => [secretType, await getFleetServiceSecret(serviceId, secretType)] as const)
  );
  return Object.fromEntries(entries);
}

export async function upsertFleetServiceSecret(input: {
  serviceId: string;
  secretType: string;
  secret: string | null | undefined;
  metadataJson?: Record<string, unknown>;
  expiresAt?: Date | null;
}): Promise<void> {
  const secret = input.secret?.trim() ?? '';
  if (!secret) {
    await query(
      `DELETE FROM fleet_service_secrets
       WHERE service_id = $1 AND secret_type = $2`,
      [input.serviceId, input.secretType]
    );
    return;
  }

  await query(
    `INSERT INTO fleet_service_secrets
       (service_id, secret_type, encrypted_secret, metadata_json, key_version, last_rotated_at, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, CURRENT_TIMESTAMP, $6)
     ON CONFLICT (service_id, secret_type)
     DO UPDATE SET encrypted_secret = $3,
                   metadata_json = $4::jsonb,
                   key_version = $5,
                   updated_at = CURRENT_TIMESTAMP,
                   last_rotated_at = CURRENT_TIMESTAMP,
                   expires_at = $6`,
    [
      input.serviceId,
      input.secretType,
      encryptStoredSecret(secret),
      JSON.stringify(input.metadataJson ?? {}),
      ENCRYPTION_KEY_VERSION,
      input.expiresAt ?? null,
    ]
  );
}
