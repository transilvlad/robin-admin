import { query } from '../db/connection.js';

export interface ModuleHostPolicy {
  slug: string;
  directoryRead: boolean;
  lifecycleRead: boolean;
  maxBodyMiB: number;
  timeoutSeconds: number;
}
export function defaultModuleHostPolicy(slug: string): ModuleHostPolicy {
  return { slug, directoryRead: false, lifecycleRead: false, maxBodyMiB: 5, timeoutSeconds: 30 };
}
export async function getModuleHostPolicy(slug: string): Promise<ModuleHostPolicy> {
  const result = await query<{ directory_read: boolean; lifecycle_read: boolean; max_body_mib: number; timeout_seconds: number }>(
    'SELECT directory_read, lifecycle_read, max_body_mib, timeout_seconds FROM module_host_policies WHERE slug = $1', [slug],
  );
  const row = result.rows[0];
  return row ? { slug, directoryRead: row.directory_read, lifecycleRead: row.lifecycle_read, maxBodyMiB: row.max_body_mib, timeoutSeconds: row.timeout_seconds } : defaultModuleHostPolicy(slug);
}
export function validateModuleHostPolicy(value: unknown): value is Omit<ModuleHostPolicy, 'slug'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 4 && typeof v.directoryRead === 'boolean' && typeof v.lifecycleRead === 'boolean'
    && Number.isInteger(v.maxBodyMiB) && Number(v.maxBodyMiB) >= 1 && Number(v.maxBodyMiB) <= 64
    && Number.isInteger(v.timeoutSeconds) && Number(v.timeoutSeconds) >= 5 && Number(v.timeoutSeconds) <= 120;
}
export async function saveModuleHostPolicy(slug: string, policy: Omit<ModuleHostPolicy, 'slug'>): Promise<ModuleHostPolicy> {
  if (!validateModuleHostPolicy(policy)) throw new Error('Invalid module host policy');
  await query(`INSERT INTO module_host_policies (slug, directory_read, lifecycle_read, max_body_mib, timeout_seconds)
    VALUES ($1, $2, $3, $4, $5) ON CONFLICT (slug) DO UPDATE SET directory_read = EXCLUDED.directory_read,
      lifecycle_read = EXCLUDED.lifecycle_read, max_body_mib = EXCLUDED.max_body_mib, timeout_seconds = EXCLUDED.timeout_seconds`,
  [slug, policy.directoryRead, policy.lifecycleRead, policy.maxBodyMiB, policy.timeoutSeconds]);
  return { slug, ...policy };
}
