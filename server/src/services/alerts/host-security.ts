import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { query } from '../../db/connection.js';
import { createAlertDelivery, listAlertWebhooks } from '../../db/queries/alerts.js';
import { getConfig } from '../../db/queries/config.js';
import { logger } from '../../logger.js';
import type { AlertType, AlertWebhook, JsonRecord } from '../../types/alerts.js';
import type { HostSecurityDiff, HostSecuritySections } from '../../types/host-security.js';
import { getHostSecurityState, hostSecurityTransaction } from '../host-security.js';
import { buildSentryAlertPayload } from './sentry.js';

const securityTypes = [
  'host_ssh_keys',
  'host_sshd',
  'host_network',
  'host_privilege',
  'host_integrity',
  'host_unknown_login',
  'host_password_login',
  'host_failed_auth_rate',
  'host_patching',
  'host_security_stale',
] as const satisfies readonly AlertType[];

type SecurityType = typeof securityTypes[number];
type Signal = { key: string; type: SecurityType; summary: string };

export function hostSecurityDriftSignals(diff: HostSecurityDiff): Signal[] {
  if (diff.baselinePending) return [];
  const signals: Signal[] = [];
  for (const item of diff.items) {
    let type: SecurityType | undefined;
    let summary: string | undefined;
    switch (item.section) {
      case 'sshKeys': {
        type = 'host_ssh_keys';
        const key = item.after ?? item.before;
        if (key) summary = `Authorized key ${key.fingerprint} for ${key.user} ${item.change} (${key.comment || 'no comment'})`;
        break;
      }
      case 'sshd':
        type = 'host_sshd';
        summary = `SSH setting ${item.itemId} changed to ${item.after?.value ?? 'unset'}`;
        break;
      case 'listeners':
        if (item.change === 'added') {
          type = 'host_network';
          summary = `New ${item.after?.protocol} listener on ${item.after?.address}:${item.after?.port}`;
        }
        break;
      case 'firewall':
        if (item.after?.inbound === 'accept' && item.before?.inbound !== 'accept') {
          type = 'host_network';
          summary = 'Default inbound firewall policy now allows traffic';
        }
        break;
      case 'accounts':
        if (item.change === 'added') {
          type = 'host_privilege';
          summary = `New login account ${item.after?.user}`;
        }
        break;
      case 'privilegedGroups':
        type = 'host_privilege';
        summary = `Membership for group ${item.itemId} ${item.change}`;
        break;
      case 'sudoers':
        if (item.after?.nopasswd && !item.before?.nopasswd) {
          type = 'host_privilege';
          summary = `Passwordless sudo rule added in ${item.after.file}`;
        }
        break;
      case 'integrity':
        type = 'host_integrity';
        summary = `Monitored path ${item.itemId} ${item.change}`;
        break;
    }
    if (type && summary) signals.push({ type, key: item.id, summary });
  }
  return signals;
}

export function unusualHostAuthRate(recent: number, historical: number, historicalMinutes: number): boolean {
  if (historicalMinutes < 15) return false;
  return recent / 5 >= 5 * ((historical + 1) / historicalMinutes);
}

function preserveWhileUnavailable(type: SecurityType, sections: HostSecuritySections): boolean {
  switch (type) {
    case 'host_ssh_keys': return sections.sshKeys.status !== 'ok' || !sections.sshKeys.complete;
    case 'host_sshd': return sections.sshd.status !== 'ok' || !sections.sshd.complete;
    case 'host_network': return !sections.listeners.complete || !sections.firewall.complete;
    case 'host_privilege': return !sections.accounts.complete || !sections.privilegedGroups.complete || !sections.sudoers.complete;
    case 'host_integrity': return !sections.integrity.complete;
    case 'host_patching': return !sections.patching.complete;
    default: return false;
  }
}

function applicableWebhooks(webhooks: AlertWebhook[], type: SecurityType, recovery: boolean, now: Date) {
  return webhooks.filter(webhook => webhook.enabled && webhook.hasSecret && (!recovery || webhook.notifyRecovery)
    && (!webhook.pausedAt || Boolean(webhook.pausedUntil && webhook.pausedUntil <= now))
    && webhook.subscriptions.some(sub => sub.enabled && sub.alertType === type));
}

function policyDays(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 && value <= 3650 ? value : fallback;
}

export async function evaluateHostSecurity(hostId: string, webhooks: AlertWebhook[], alertsEnabled: boolean) {
  await hostSecurityTransaction(async client => {
    const { row, snapshot, diff } = await getHostSecurityState(hostId, client);
    const now = new Date();
    const signals = hostSecurityDriftSignals(diff);
    const patchAge = policyDays('HOST_SECURITY_PATCH_ALERT_DAYS', 7) * 86_400_000;
    const patching = snapshot.sections.patching.items[0]?.value;

    const state = await client.query<{ securitySince: Date | null; stale: boolean }>(`
      SELECT security_upgrades_since AS "securitySince",
        last_received_at < CURRENT_TIMESTAMP - make_interval(secs => interval_seconds * 3) AS stale
      FROM host_security_hosts WHERE agent_id = $1`, [hostId]);
    if (state.rows[0].stale) {
      signals.push({ type: 'host_security_stale', key: 'heartbeat', summary: 'Host security telemetry is stale' });
    }
    if (patching?.rebootSince && now.getTime() - Date.parse(patching.rebootSince) >= patchAge) {
      signals.push({ type: 'host_patching', key: 'reboot', summary: 'A system reboot has been pending past the configured deadline' });
    }
    const securitySince = state.rows[0].securitySince;
    if (securitySince && now.getTime() - securitySince.getTime() >= patchAge) {
      signals.push({ type: 'host_patching', key: 'upgrades', summary: 'Security upgrades have been pending past the configured deadline' });
    }

    const logins = await client.query<{ event: { user?: string; sourceIp?: string; authMethod?: string }; id: string; known: boolean }>(`
      SELECT event, event_id AS id, known_address_id IS NOT NULL AS known
      FROM host_security_events
      WHERE agent_id = $1 AND observed_at >= CURRENT_TIMESTAMP - interval '24 hours' AND event->>'type' = 'login'
        AND (known_address_id IS NULL OR event->>'authMethod' = 'password')
      ORDER BY observed_at DESC, event_id DESC LIMIT 1000`, [hostId]);
    // These alerts stay active for the 24-hour observation window.
    for (const { event, id, known } of logins.rows) {
      const summary = `Successful login for ${event.user ?? 'unknown user'} from ${event.sourceIp ?? 'unknown address'}`;
      if (!known) signals.push({ type: 'host_unknown_login', key: id, summary });
      if (event.authMethod === 'password') signals.push({ type: 'host_password_login', key: id, summary: `Password login. ${summary}` });
    }
    const auth = await client.query<{ recent: number; historical: number; minutes: number }>(`
      SELECT COALESCE(sum(invalid_user + failed_key + failed_password) FILTER
          (WHERE minute >= date_trunc('minute', CURRENT_TIMESTAMP) - interval '5 minutes'), 0)::float8 AS recent,
        COALESCE(sum(invalid_user + failed_key + failed_password) FILTER
          (WHERE minute < date_trunc('minute', CURRENT_TIMESTAMP) - interval '5 minutes'), 0)::float8 AS historical,
        count(*) FILTER (WHERE minute < date_trunc('minute', CURRENT_TIMESTAMP) - interval '5 minutes')::int AS minutes
      FROM host_security_counters WHERE agent_id = $1 AND minute >= CURRENT_TIMESTAMP - interval '7 days'`, [hostId]);
    const { recent, historical, minutes } = auth.rows[0];
    if (unusualHostAuthRate(recent, historical, minutes)) {
      signals.push({ type: 'host_failed_auth_rate', key: 'failures', summary: `${recent} failed authentications over five minutes exceeds the host's rolling rate` });
    }

    const existing = await client.query<{ alert_type: SecurityType; issue_id: string; summary: string; active: boolean; generation: string }>(
      'SELECT alert_type, issue_id, summary, active, generation::text FROM host_security_alert_states WHERE agent_id = $1',
      [hostId],
    );
    const byIdentity = new Map(existing.rows.map(entry => [`${entry.alert_type}:${entry.issue_id}`, entry]));
    const current = new Map<string, Signal & { id: string }>(signals.map(signal => {
      const id = createHash('sha256').update(signal.key).digest('hex');
      return [`${signal.type}:${id}`, { ...signal, id }] as const;
    }));
    const transitions = [
      ...[...current].filter(([id]) => !byIdentity.get(id)?.active)
        .map(([id, value]) => ({ ...value, old: byIdentity.get(id), kind: 'failure' as const })),
      ...[...byIdentity].filter(([id, old]) => old.active && !current.has(id) && !preserveWhileUnavailable(old.alert_type, snapshot.sections))
        .map(([, old]) => ({ id: old.issue_id, type: old.alert_type, summary: old.summary, old, kind: 'recovery' as const })),
    ];
    for (const signal of transitions) {
      const generation = (BigInt(signal.old?.generation ?? now.getTime()) + 1n).toString();
      await client.query(`
        INSERT INTO host_security_alert_states (agent_id, alert_type, issue_id, summary, generation, active)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (agent_id, alert_type, issue_id) DO UPDATE
        SET summary = EXCLUDED.summary, generation = EXCLUDED.generation, active = EXCLUDED.active,
            changed_at = CURRENT_TIMESTAMP`,
      [hostId, signal.type, signal.id, signal.summary, generation, signal.kind === 'failure']);
      if (!alertsEnabled) continue;
      const summary = signal.kind === 'failure' ? signal.summary : `Recovered: ${signal.summary}`;
      const linkPath = `/fleet/security/${encodeURIComponent(hostId)}`;
      const detail: JsonRecord = {
        version: 1, alertType: signal.type, eventKind: signal.kind, hostId, hostName: row.name,
        summary, snapshotId: snapshot.id, baselineRevision: diff.baselineRevision, observedAt: now.toISOString(), linkPath,
      };
      for (const webhook of applicableWebhooks(webhooks, signal.type, signal.kind === 'recovery', now)) {
        const payload = webhook.adapter === 'sentry' ? buildSentryAlertPayload({
          alertKey: `host-security:${hostId}:${signal.type}:${signal.id}`,
          alertType: signal.type, eventKind: signal.kind, title: 'Host security', message: summary, severity: 'warning',
          tags: { hostId }, context: detail, linkPath, occurredAt: now,
        }) : webhook.adapter === 'slack' ? { text: `${row.name}: ${summary}`.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!), robin_alert: detail } : detail;
        if (!payload) continue;
        await createAlertDelivery({
          dedupeKey: `host-security:${hostId}:${signal.type}:${signal.id}:${generation}:${webhook.id}`,
          webhookId: webhook.id, webhookName: webhook.name, fleetServiceId: null, serviceId: hostId,
          serviceName: row.name, serviceType: 'monitoring', alertType: signal.type, eventKind: signal.kind,
          adapter: webhook.adapter, payload, client,
        });
      }
    }
  });
}

let timer: ReturnType<typeof setInterval> | undefined;
let active = false;
let lastPrune = 0;

async function runHostSecurityScheduler() {
  if (active) return;
  active = true;
  try {
    const { rows } = await query<{ agent_id: string }>('SELECT agent_id FROM host_security_hosts ORDER BY agent_id');
    if (rows.length === 0) return;
    const [webhooks, runtime] = await Promise.all([listAlertWebhooks(), getConfig()]);
    for (const host of rows) {
      try { await evaluateHostSecurity(host.agent_id, webhooks, runtime.alertsEnabled); }
      catch (error) { logger.warn('Host security evaluation failed', { hostId: host.agent_id, error: (error as Error).message }); }
    }
    if (Date.now() - lastPrune >= 3_600_000) {
      await hostSecurityTransaction(async client => {
        const historyDays = Math.max(90, policyDays('HOST_SECURITY_RETENTION_DAYS', 90));
        await client.query(`DELETE FROM host_security_snapshots WHERE received_at < CURRENT_TIMESTAMP - make_interval(days => $1)
          AND id NOT IN (SELECT snapshot_id FROM host_security_hosts)`, [historyDays]);
        await client.query(`DELETE FROM host_security_approvals WHERE approved_at < CURRENT_TIMESTAMP - make_interval(days => $1)
          AND (agent_id, revision) NOT IN (SELECT agent_id, baseline_revision FROM host_security_hosts)`, [historyDays]);
        await client.query('DELETE FROM host_security_events WHERE observed_at < CURRENT_TIMESTAMP - make_interval(days => $1)', [config.logs.retentionDays]);
        await client.query('DELETE FROM host_security_counters WHERE minute < CURRENT_TIMESTAMP - make_interval(days => $1)', [config.logs.retentionDays]);
        await client.query('DELETE FROM host_security_event_batches WHERE received_at < CURRENT_TIMESTAMP - make_interval(days => $1)', [config.logs.retentionDays]);
        await client.query(`DELETE FROM host_security_alert_states
          WHERE NOT active AND changed_at < CURRENT_TIMESTAMP - make_interval(days => $1)`, [config.logs.retentionDays]);
      });
      lastPrune = Date.now();
    }
  } catch (error) {
    logger.error('Host security evaluation cycle failed', { error: (error as Error).message });
  } finally {
    active = false;
  }
}

export function startHostSecurityScheduler() {
  if (!timer) timer = setInterval(() => { void runHostSecurityScheduler(); }, 60_000);
}

export function stopHostSecurityScheduler() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
