import { query } from '../connection.js';

export class MailPolicyInputError extends Error {}

export interface MailDomain {
  domain: string;
  enabled: boolean;
  plus_addressing: boolean;
  catch_all: string | null;
}

export interface SenderGrant {
  account: string;
  address: string;
  grant_type: 'primary' | 'alias' | 'delegated';
}

export function normalizeMailDomain(value: unknown): string {
  if (typeof value !== 'string') throw new MailPolicyInputError('A domain is required');
  const domain = value.trim().toLowerCase();
  if (domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) {
    throw new MailPolicyInputError('Use a fully qualified ASCII domain');
  }
  return domain;
}

export function normalizeMailAddress(value: unknown): string {
  if (typeof value !== 'string') throw new MailPolicyInputError('A full email address is required');
  const address = value.trim().toLowerCase();
  const parts = address.split('@');
  if (parts.length !== 2 || parts[0].length > 64 || address.length > 320
      || !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(parts[0])) {
    throw new MailPolicyInputError('Use a full ASCII email address, not a pattern or address list');
  }
  normalizeMailDomain(parts[1]);
  return address;
}

export async function mailPolicyAvailable(): Promise<boolean> {
  const result = await query<{ ready: boolean }>(`
    SELECT COUNT(*) = 11 AS ready FROM information_schema.columns
    WHERE table_schema = 'public'
      AND ((table_name = 'mail_domains' AND column_name IN ('domain','enabled','plus_addressing','catch_all'))
        OR (table_name = 'mail_sender_grants' AND column_name IN ('account','address','grant_type'))
        OR (table_name = 'users' AND column_name = 'email')
        OR (table_name = 'aliases' AND column_name IN ('id','source','destination')))
  `);
  return result.rows[0]?.ready === true;
}

export async function listMailDomains(page: number, limit: number): Promise<{ rows: MailDomain[]; total: number }> {
  const count = await query<{ total: string }>('SELECT COUNT(*) AS total FROM mail_domains');
  const result = await query<MailDomain>('SELECT domain, enabled, plus_addressing, catch_all FROM mail_domains ORDER BY domain LIMIT $1 OFFSET $2', [limit, (page - 1) * limit]);
  return { rows: result.rows, total: Number(count.rows[0].total) };
}

export async function saveMailDomain(input: unknown): Promise<MailDomain> {
  if (!input || typeof input !== 'object') throw new MailPolicyInputError('Domain policy is required');
  const data = input as Record<string, unknown>;
  const domain = normalizeMailDomain(data.domain);
  if (typeof data.enabled !== 'boolean' || typeof data.plus_addressing !== 'boolean'
      || (data.catch_all !== null && typeof data.catch_all !== 'string')) {
    throw new MailPolicyInputError('enabled and plus_addressing must be booleans; catch_all must be an address or null');
  }
  const catchAll = data.catch_all === null ? null : normalizeMailAddress(data.catch_all);
  const result = await query<MailDomain>(`
    INSERT INTO mail_domains (domain, enabled, plus_addressing, catch_all)
    SELECT $1::text, $2::boolean, $3::boolean, $4::text WHERE $4::text IS NULL
      OR EXISTS (SELECT 1 FROM users WHERE lower(email) = $4)
    ON CONFLICT (domain) DO UPDATE SET enabled = EXCLUDED.enabled,
      plus_addressing = EXCLUDED.plus_addressing, catch_all = EXCLUDED.catch_all
    RETURNING domain, enabled, plus_addressing, catch_all
  `, [domain, data.enabled, data.plus_addressing, catchAll]);
  if (!result.rows[0]) throw new MailPolicyInputError('Catch-all must point directly to an existing local mailbox');
  return result.rows[0];
}

export async function listSenderGrants(page: number, limit: number): Promise<{ rows: SenderGrant[]; total: number }> {
  const count = await query<{ total: string }>('SELECT COUNT(*) AS total FROM mail_sender_grants');
  const result = await query<SenderGrant>('SELECT account, address, grant_type FROM mail_sender_grants ORDER BY account, address LIMIT $1 OFFSET $2', [limit, (page - 1) * limit]);
  return { rows: result.rows, total: Number(count.rows[0].total) };
}

export async function saveSenderGrant(input: unknown): Promise<SenderGrant> {
  if (!input || typeof input !== 'object') throw new MailPolicyInputError('A sender grant is required');
  const data = input as Record<string, unknown>;
  const account = normalizeMailAddress(data.account);
  const address = normalizeMailAddress(data.address);
  const kind = data.grant_type;
  if (kind !== 'primary' && kind !== 'alias' && kind !== 'delegated') throw new MailPolicyInputError('Unknown grant type');
  if (kind === 'primary' && account !== address) throw new MailPolicyInputError('A primary grant must match the account address');
  if (kind !== 'primary' && account === address) throw new MailPolicyInputError('Use a primary grant for the account address');
  const result = await query<SenderGrant>(`
    INSERT INTO mail_sender_grants (account, address, grant_type)
    SELECT $1::text, $2::text, $3::text
    WHERE EXISTS (SELECT 1 FROM users WHERE email = $1)
      AND EXISTS (SELECT 1 FROM mail_domains WHERE domain = split_part($2, '@', 2) AND enabled)
      AND (($3 IN ('primary', 'delegated') AND EXISTS (SELECT 1 FROM users WHERE email = $2))
        OR ($3 = 'alias' AND EXISTS (SELECT 1 FROM aliases WHERE source = $2)))
    ON CONFLICT (account, address) DO UPDATE SET grant_type = EXCLUDED.grant_type
    RETURNING account, address, grant_type
  `, [account, address, kind]);
  if (!result.rows[0]) throw new MailPolicyInputError('Grant requires an existing account, enabled sender domain and matching mailbox or alias');
  return result.rows[0];
}

export async function revokeSenderGrant(account: unknown, address: unknown): Promise<boolean> {
  const result = await query('DELETE FROM mail_sender_grants WHERE account = $1 AND address = $2', [normalizeMailAddress(account), normalizeMailAddress(address)]);
  return (result.rowCount ?? 0) > 0;
}
