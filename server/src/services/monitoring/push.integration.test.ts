import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initializeSchema } from '../../db/schema.js';
import { closePool, getClient, query } from '../../db/connection.js';
import { createAlertWebhook, deleteAlertWebhook } from '../../db/queries/alerts.js';
import {
  createMonitoringCheck,
  createMonitoringSilence,
  createMonitoringTarget,
  endMonitoringSilence,
  evaluateMonitoringCheckLocations,
  getMonitoringCheck,
  getMonitoringCheckPushToken,
  pauseMonitoringCheck,
  pruneMonitoringHistory,
  processExpiredMonitoringSilences,
  recordMonitoringCheckPing,
  recordMonitoringObservation,
  resumeMonitoringCheck,
  updateMonitoringCheck,
} from '../../db/queries/monitoring.js';
import { expiredPushOccurrence, pushScheduledOccurrence } from './push.js';
import { runMonitoringProbe } from './probes.js';
import type { MonitoringCheck } from '../../types/monitoring.js';

const run = process.env.CRON_PUSH_IT_DB === '1';

describe.skipIf(!run)('cron push checks (PostgreSQL integration)', () => {
  let targetId: number;

  beforeAll(async () => {
    if (!/^robin_test_cron($|_)/.test(process.env.DB_NAME ?? '') || !['127.0.0.1', 'localhost'].includes(process.env.DB_HOST ?? '')) {
      throw new Error('Fresh disposable test database required');
    }
    await initializeSchema();
    targetId = (await createMonitoringTarget({ name: 'Cron integration', targetType: 'host', environment: 'test' })).id;
  }, 120_000);

  afterAll(async () => closePool());

  async function createCheck(name: string): Promise<MonitoringCheck> {
    return createMonitoringCheck({
      targetId, name, checkType: 'push', endpoint: 'push', intervalSeconds: 3600,
      confirmationSeconds: 120, recoverySeconds: 0, pushCronExpression: '* * * * *', pushTimezone: 'UTC',
    });
  }

  async function observe(check: MonitoringCheck): Promise<void> {
    const now = new Date();
    await recordMonitoringObservation({ check, ...await runMonitoringProbe(check), observedAt: now });
  }

  it('waits for the first observation without changing the new schedule', async () => {
    const created = await createCheck('Awaiting observation');
    await evaluateMonitoringCheckLocations(created.id, false);
    expect(await getMonitoringCheck(created.id)).toMatchObject({
      currentStatus: 'unknown', pushScheduleCursor: null, lastError: expect.stringContaining('Waiting for'),
    });
  });

  it('keeps issues active through overlapping silences and notifies once they all end', async () => {
    const created = await createCheck('Silenced maintenance');
    await query("UPDATE monitoring_checks SET push_schedule_started_at = NOW() - INTERVAL '1 day' WHERE id = $1", [created.id]);
    const now = new Date();
    const first = await createMonitoringSilence({
      name: 'Target upgrade', scopeType: 'target', targetId, reason: null,
      startsAt: new Date(now.getTime() - 60_000), endsAt: new Date(now.getTime() + 60_000), createdBy: null,
    });
    const second = await createMonitoringSilence({
      name: 'Check verification', scopeType: 'check', checkId: created.id, reason: null,
      startsAt: new Date(now.getTime() - 30_000), endsAt: new Date(now.getTime() + 120_000), createdBy: null,
    });
    expect(first?.targetName).toBe('Cron integration');
    expect(second?.targetName).toBe('Cron integration');

    const webhook = await createAlertWebhook({
      name: 'Silence integration alert', adapter: 'generic', webhookUrl: 'https://example.test/alerts', enabled: true,
      subscriptions: [{ alertType: 'monitoring_issue', enabled: true }],
    });
    const previousSetting = await query<{ value: string }>("SELECT value FROM admin_config WHERE key = 'alertsEnabled'");
    try {
      await query(`INSERT INTO admin_config (key, value) VALUES ('alertsEnabled', 'true')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
      await observe((await getMonitoringCheck(created.id))!);
      const issue = await query<{ id: number; notification_suppressed: boolean }>(
        'SELECT id, notification_suppressed FROM monitoring_issues WHERE check_id = $1 AND status = $2', [created.id, 'open'],
      );
      expect(issue.rows[0]?.notification_suppressed).toBe(true);
      expect((await query('SELECT id FROM alert_deliveries WHERE monitoring_issue_id = $1', [issue.rows[0].id])).rowCount).toBe(0);

      await query("UPDATE monitoring_issues SET severity = 'warning' WHERE id = $1", [issue.rows[0].id]);
      await query(
        "UPDATE monitoring_checks SET current_status = 'warning', status_since = NOW() - INTERVAL '5 minutes' WHERE id = $1",
        [created.id],
      );
      await observe((await getMonitoringCheck(created.id))!);
      expect((await query('SELECT id FROM alert_deliveries WHERE monitoring_issue_id = $1', [issue.rows[0].id])).rowCount).toBe(0);

      await endMonitoringSilence(first!.id);
      expect(await processExpiredMonitoringSilences()).toBe(0);
      expect((await query('SELECT id FROM alert_deliveries WHERE monitoring_issue_id = $1', [issue.rows[0].id])).rowCount).toBe(0);

      await endMonitoringSilence(second!.id);
      expect(await processExpiredMonitoringSilences()).toBe(1);
      expect((await getMonitoringCheck(created.id))?.currentStatus).toBe('down');
      expect((await query('SELECT id FROM alert_deliveries WHERE monitoring_issue_id = $1 AND webhook_id = $2', [issue.rows[0].id, webhook.id])).rowCount).toBe(1);
      expect((await query('SELECT notification_suppressed FROM monitoring_issues WHERE id = $1', [issue.rows[0].id])).rows[0].notification_suppressed).toBe(false);
      expect(await processExpiredMonitoringSilences()).toBe(0);
    } finally {
      if (previousSetting.rows[0]) {
        await query("UPDATE admin_config SET value = $1 WHERE key = 'alertsEnabled'", [previousSetting.rows[0].value]);
      } else {
        await query("DELETE FROM admin_config WHERE key = 'alertsEnabled'");
      }
      await deleteAlertWebhook(webhook.id);
    }
  });

  it('opens a missed-run issue after grace and closes it after a successful ping', async () => {
    const created = await createCheck('Missed backup');
    expect(created).toMatchObject({ pushCronExpression: '* * * * *', pushTimezone: 'UTC' });
    expect(created.pushScheduleStartedAt).toBeInstanceOf(Date);
    await query(`UPDATE monitoring_checks SET push_schedule_started_at = NOW() - INTERVAL '1 day',
      last_ping_at = NOW() - INTERVAL '10 minutes', last_ping_status = 'ok' WHERE id = $1`, [created.id]);
    const stale = (await getMonitoringCheck(created.id))!;
    await observe(stale);
    expect((await getMonitoringCheck(created.id))?.currentStatus).toBe('down');
    const opened = await query<{ id: number; status: string }>(
      `SELECT id, status FROM monitoring_issues WHERE check_id = $1`, [created.id],
    );
    expect(opened.rows).toHaveLength(1);
    expect(opened.rows[0].status).toBe('open');

    const token = (await getMonitoringCheckPushToken(created.id))!;
    expect(await recordMonitoringCheckPing(token, 'ok')).toBe(created.id);
    await observe((await getMonitoringCheck(created.id))!);
    expect((await getMonitoringCheck(created.id))?.currentStatus).toBe('up');
    const recovered = await query<{ status: string }>('SELECT status FROM monitoring_issues WHERE id = $1', [opened.rows[0].id]);
    expect(recovered.rows[0].status).toBe('closed');
  });

  it('keeps schedule start on unrelated edits, resets it on schedule changes, and rejects stale observations', async () => {
    const created = await createCheck('Schedule edit');
    await query(`UPDATE monitoring_checks SET push_schedule_started_at = NOW() - INTERVAL '1 day',
      last_ping_at = NOW() - INTERVAL '10 minutes', last_ping_status = 'ok' WHERE id = $1`, [created.id]);
    const original = (await getMonitoringCheck(created.id))!;
    const renamed = (await updateMonitoringCheck(created.id, { name: 'Renamed' }))!;
    expect(renamed.pushScheduleStartedAt?.getTime()).toBe(original.pushScheduleStartedAt?.getTime());
    const edited = (await updateMonitoringCheck(created.id, { pushCronExpression: '0 * * * *' }))!;
    expect(edited.pushScheduleStartedAt!.getTime()).toBeGreaterThan(original.pushScheduleStartedAt!.getTime());
    expect(edited.pushTimezone).toBe('UTC');

    await observe(original);
    expect((await getMonitoringCheck(created.id))?.currentStatus).toBe('unknown');
    expect((await query('SELECT id FROM monitoring_issues WHERE check_id = $1', [created.id])).rowCount).toBe(0);
    await observe((await getMonitoringCheck(created.id))!);
    expect((await getMonitoringCheck(created.id))?.currentStatus).toBe('up');

    const interval = (await updateMonitoringCheck(created.id, { pushCronExpression: null }))!;
    expect(interval).toMatchObject({ pushCronExpression: null, pushTimezone: null, pushScheduleStartedAt: null });
  });

  it('does not open issues while paused but evaluates missed runs on resume', async () => {
    const created = await createCheck('Paused check');
    await query(`UPDATE monitoring_checks SET push_schedule_started_at = NOW() - INTERVAL '1 day',
      last_ping_at = NOW() - INTERVAL '10 minutes', last_ping_status = 'ok' WHERE id = $1`, [created.id]);
    await pauseMonitoringCheck(created.id, 'maintenance');
    await observe((await getMonitoringCheck(created.id))!);
    expect((await query('SELECT id FROM monitoring_issues WHERE check_id = $1', [created.id])).rowCount).toBe(0);
    await resumeMonitoringCheck(created.id);
    await observe((await getMonitoringCheck(created.id))!);
    expect((await query("SELECT id FROM monitoring_issues WHERE check_id = $1 AND status = 'open'", [created.id])).rowCount).toBe(1);
  });

  it('detects an earlier missed run even when a later run succeeds before its grace expires', async () => {
    const created = await createCheck('Overlapping grace');
    await query("UPDATE monitoring_checks SET push_schedule_started_at = NOW() - INTERVAL '1 day' WHERE id = $1", [created.id]);
    const configured = (await getMonitoringCheck(created.id))!;
    const now = new Date();
    const expired = expiredPushOccurrence(configured, now)!;
    const later = pushScheduledOccurrence(configured, now)!;
    expect(later.getTime()).toBeGreaterThan(expired.getTime());
    await query('UPDATE monitoring_checks SET push_schedule_cursor = $2 WHERE id = $1', [created.id, new Date(expired.getTime() - 60_000)]);
    await query(`INSERT INTO monitoring_push_checkins (check_id, scheduled_at, received_at) VALUES ($1, $2, NOW())`, [created.id, later]);
    await query("UPDATE monitoring_checks SET last_ping_at = NOW(), last_ping_status = 'ok' WHERE id = $1", [created.id]);
    await observe((await getMonitoringCheck(created.id))!);
    expect(await getMonitoringCheck(created.id)).toMatchObject({
      currentStatus: 'down', pushScheduleCursor: expired, lastError: expect.stringContaining(expired.toISOString()),
    });
    expect((await query("SELECT id FROM monitoring_issues WHERE check_id = $1 AND status = 'open'", [created.id])).rowCount).toBe(1);

    await recordMonitoringCheckPing((await getMonitoringCheckPushToken(created.id))!, 'ok');
    await observe((await getMonitoringCheck(created.id))!);
    expect((await getMonitoringCheck(created.id))?.currentStatus).toBe('up');
    expect((await query("SELECT id FROM monitoring_issues WHERE check_id = $1 AND status = 'open'", [created.id])).rowCount).toBe(0);
    await observe((await getMonitoringCheck(created.id))!);
    expect((await getMonitoringCheck(created.id))?.currentStatus).toBe('up');
  });

  it('detects a skipped missed run even if a subsequent expired run checked in', async () => {
    const created = await createCheck('Skipped evaluation');
    await query("UPDATE monitoring_checks SET push_schedule_started_at = NOW() - INTERVAL '1 day' WHERE id = $1", [created.id]);
    const configured = (await getMonitoringCheck(created.id))!;
    const expired = expiredPushOccurrence(configured, new Date())!;
    const cursor = new Date(expired.getTime() - 180_000);
    const missed = new Date(expired.getTime() - 60_000);
    await query("UPDATE monitoring_checks SET push_schedule_cursor = $2, last_ping_at = NOW(), last_ping_status = 'ok' WHERE id = $1", [created.id, cursor]);
    await query(`INSERT INTO monitoring_push_checkins (check_id, scheduled_at, received_at)
      VALUES ($1, $2::timestamptz, $2::timestamptz + INTERVAL '1 second'),
             ($1, $3::timestamptz, $3::timestamptz + INTERVAL '1 second')`,
    [created.id, new Date(cursor.getTime() + 60_000), expired]);

    await observe((await getMonitoringCheck(created.id))!);
    expect(await getMonitoringCheck(created.id)).toMatchObject({
      currentStatus: 'down', pushScheduleCursor: missed, lastError: expect.stringContaining(missed.toISOString()),
    });
    expect((await query("SELECT id FROM monitoring_issues WHERE check_id = $1 AND status = 'open'", [created.id])).rowCount).toBe(1);
    await observe((await getMonitoringCheck(created.id))!);
    expect((await getMonitoringCheck(created.id))?.currentStatus).toBe('up');
    expect((await query("SELECT id FROM monitoring_issues WHERE check_id = $1 AND status = 'closed'", [created.id])).rowCount).toBe(1);
  });

  it('records a late ping as a miss even if it arrives before the scheduler evaluates', async () => {
    const created = await createCheck('Late before evaluation');
    await updateMonitoringCheck(created.id, { pushCronExpression: '0 * * * *', confirmationSeconds: 30 });
    await query("UPDATE monitoring_checks SET push_schedule_started_at = NOW() - INTERVAL '1 day' WHERE id = $1", [created.id]);
    const configured = (await getMonitoringCheck(created.id))!;
    const now = new Date();
    const due = expiredPushOccurrence(configured, now)!;
    const lateSlot = now.getTime() - due.getTime() > 30_000 ? due : new Date(due.getTime() - 3_600_000);
    const latePing = new Date(lateSlot.getTime() + 30_001);
    await query(`UPDATE monitoring_checks SET push_schedule_started_at = $2, push_schedule_cursor = $3,
      last_ping_at = $4, last_ping_status = 'ok' WHERE id = $1`,
    [created.id, new Date(lateSlot.getTime() - 7_200_000), new Date(lateSlot.getTime() - 3_600_000),
      lateSlot.getTime() === due.getTime() ? latePing : due]);
    await query('INSERT INTO monitoring_push_checkins (check_id, scheduled_at, received_at) VALUES ($1, $2, $3)', [created.id, lateSlot, latePing]);
    if (lateSlot < due) {
      await query('INSERT INTO monitoring_push_checkins (check_id, scheduled_at, received_at) VALUES ($1, $2, $2)', [created.id, due]);
    }

    await observe((await getMonitoringCheck(created.id))!);
    expect(await getMonitoringCheck(created.id)).toMatchObject({
      currentStatus: 'down', pushScheduleCursor: lateSlot, lastError: expect.stringContaining(lateSlot.toISOString()),
    });
    await observe((await getMonitoringCheck(created.id))!);
    expect((await getMonitoringCheck(created.id))?.currentStatus).toBe('up');
    expect((await query("SELECT id FROM monitoring_issues WHERE check_id = $1 AND status = 'closed'", [created.id])).rowCount).toBe(1);
  });

  it('accepts a successful receipt exactly at its grace deadline', async () => {
    const created = await createCheck('Deadline boundary');
    await updateMonitoringCheck(created.id, { pushCronExpression: '0 * * * *', confirmationSeconds: 30 });
    await query("UPDATE monitoring_checks SET push_schedule_started_at = NOW() - INTERVAL '1 day' WHERE id = $1", [created.id]);
    const configured = (await getMonitoringCheck(created.id))!;
    const due = expiredPushOccurrence(configured, new Date())!;
    await query('UPDATE monitoring_checks SET push_schedule_cursor = $2 WHERE id = $1', [created.id, new Date(due.getTime() - 3_600_000)]);
    await query(`INSERT INTO monitoring_push_checkins (check_id, scheduled_at, received_at)
      VALUES ($1, $2::timestamptz, $2::timestamptz + INTERVAL '30 seconds')`, [created.id, due]);
    await observe((await getMonitoringCheck(created.id))!);
    expect((await getMonitoringCheck(created.id))?.currentStatus).toBe('up');
    expect((await query('SELECT id FROM monitoring_issues WHERE check_id = $1', [created.id])).rowCount).toBe(0);
  });

  it('uses the ordinary confirmation window for an explicit failure ping', async () => {
    const created = await createCheck('Explicit failure');
    await updateMonitoringCheck(created.id, { confirmationSeconds: 30 });
    const token = (await getMonitoringCheckPushToken(created.id))!;
    await recordMonitoringCheckPing(token, 'fail');
    await observe((await getMonitoringCheck(created.id))!);
    expect((await getMonitoringCheck(created.id))?.currentStatus).toBe('down');
    expect((await query('SELECT id FROM monitoring_issues WHERE check_id = $1', [created.id])).rowCount).toBe(0);
    await query("UPDATE monitoring_checks SET status_since = NOW() - INTERVAL '31 seconds' WHERE id = $1", [created.id]);
    await observe((await getMonitoringCheck(created.id))!);
    expect((await query("SELECT id FROM monitoring_issues WHERE check_id = $1 AND status = 'open'", [created.id])).rowCount).toBe(1);
    await recordMonitoringCheckPing(token, 'ok');
    await observe((await getMonitoringCheck(created.id))!);
    expect((await getMonitoringCheck(created.id))?.currentStatus).toBe('up');
  });

  it('keeps the first successful receipt when the same run pings again', async () => {
    const created = await createCheck('Duplicate ping');
    await updateMonitoringCheck(created.id, { pushCronExpression: '0 * * * *', confirmationSeconds: 30 });
    await query("UPDATE monitoring_checks SET push_schedule_started_at = NOW() - INTERVAL '1 day' WHERE id = $1", [created.id]);
    const configured = (await getMonitoringCheck(created.id))!;
    const scheduled = pushScheduledOccurrence(configured, new Date())!;
    await query('INSERT INTO monitoring_push_checkins (check_id, scheduled_at, received_at) VALUES ($1, $2, $2)', [created.id, scheduled]);
    await recordMonitoringCheckPing((await getMonitoringCheckPushToken(created.id))!, 'ok');
    const stored = await query<{ received_at: Date }>(
      'SELECT received_at FROM monitoring_push_checkins WHERE check_id = $1 AND scheduled_at = $2', [created.id, scheduled],
    );
    expect(stored.rows[0].received_at).toEqual(scheduled);
  });

  it('ignores a probe result from before a newer ping', async () => {
    const created = await createCheck('Stale ping observation');
    await query("UPDATE monitoring_checks SET push_schedule_started_at = NOW() - INTERVAL '1 day' WHERE id = $1", [created.id]);
    const old = (await getMonitoringCheck(created.id))!;
    const result = await runMonitoringProbe(old);
    await recordMonitoringCheckPing((await getMonitoringCheckPushToken(created.id))!, 'ok');
    await recordMonitoringObservation({ check: old, ...result });
    expect((await getMonitoringCheck(created.id))?.currentStatus).toBe('unknown');
    expect((await query('SELECT id FROM monitoring_issues WHERE check_id = $1', [created.id])).rowCount).toBe(0);
  });

  it('ignores a successful scan based on a cursor that has since advanced to a miss', async () => {
    const created = await createCheck('Stale scan observation');
    await query(`UPDATE monitoring_checks SET push_schedule_started_at = date_trunc('minute', NOW()) - INTERVAL '1004 minutes'
      WHERE id = $1`, [created.id]);
    const stale = (await getMonitoringCheck(created.id))!;
    await query(`INSERT INTO monitoring_push_checkins (check_id, scheduled_at, received_at)
      SELECT $1, slot, slot FROM generate_series($2::timestamptz + INTERVAL '1 minute',
        $2::timestamptz + INTERVAL '1000 minutes', INTERVAL '1 minute') AS slot`,
    [created.id, stale.pushScheduleStartedAt]);

    await observe(stale);
    await observe((await getMonitoringCheck(created.id))!);
    expect((await getMonitoringCheck(created.id))?.currentStatus).toBe('down');

    await observe(stale);
    expect((await getMonitoringCheck(created.id))?.currentStatus).toBe('down');
    expect((await query("SELECT id FROM monitoring_issues WHERE check_id = $1 AND status = 'open'", [created.id])).rowCount).toBe(1);
  });

  it('rolls back the cursor and issue if notification queuing fails', async () => {
    const created = await createCheck('Transactional notification');
    await query("UPDATE monitoring_checks SET push_schedule_started_at = NOW() - INTERVAL '1 day' WHERE id = $1", [created.id]);
    const webhook = await createAlertWebhook({
      name: 'Cron integration alert', adapter: 'generic', webhookUrl: 'https://example.test/alerts', enabled: true,
      subscriptions: [{ alertType: 'monitoring_issue', enabled: true }],
    });
    const previousSetting = await query<{ value: string }>("SELECT value FROM admin_config WHERE key = 'alertsEnabled'");
    try {
      await query(`INSERT INTO admin_config (key, value) VALUES ('alertsEnabled', 'true')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
      await query(`CREATE FUNCTION cron_test_reject_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected delivery failure'; END $$`);
      await query(`CREATE TRIGGER cron_test_reject_delivery BEFORE INSERT ON alert_deliveries
        FOR EACH ROW WHEN (NEW.webhook_id = ${webhook.id}) EXECUTE FUNCTION cron_test_reject_delivery()`);

      await expect(observe((await getMonitoringCheck(created.id))!)).rejects.toThrow('injected delivery failure');
      expect(await getMonitoringCheck(created.id)).toMatchObject({ currentStatus: 'unknown', pushScheduleCursor: null });
      expect((await query('SELECT id FROM monitoring_issues WHERE check_id = $1', [created.id])).rowCount).toBe(0);
      await query('DROP TRIGGER cron_test_reject_delivery ON alert_deliveries');
      await query('DROP FUNCTION cron_test_reject_delivery()');

      await observe((await getMonitoringCheck(created.id))!);
      expect((await getMonitoringCheck(created.id))?.currentStatus).toBe('down');
      expect((await query(`SELECT d.id FROM alert_deliveries d JOIN monitoring_issues i ON i.id = d.monitoring_issue_id
        WHERE i.check_id = $1 AND d.webhook_id = $2`, [created.id, webhook.id])).rowCount).toBe(1);
    } finally {
      await query('DROP TRIGGER IF EXISTS cron_test_reject_delivery ON alert_deliveries');
      await query('DROP FUNCTION IF EXISTS cron_test_reject_delivery()');
      if (previousSetting.rows[0]) {
        await query("UPDATE admin_config SET value = $1 WHERE key = 'alertsEnabled'", [previousSetting.rows[0].value]);
      } else {
        await query("DELETE FROM admin_config WHERE key = 'alertsEnabled'");
      }
      await deleteAlertWebhook(webhook.id);
    }
  });

  it('serializes a ping arriving while a missed-run issue is being opened', async () => {
    const created = await createCheck('Concurrent recovery');
    await query("UPDATE monitoring_checks SET push_schedule_started_at = NOW() - INTERVAL '1 day' WHERE id = $1", [created.id]);
    const token = (await getMonitoringCheckPushToken(created.id))!;
    const controller = await getClient();
    let observation: Promise<void> | undefined;
    let ping: Promise<number | null> | undefined;
    const waitFor = async (statement: string): Promise<void> => {
      for (let attempt = 0; attempt < 250; attempt++) {
        if ((await query<{ waiting: boolean }>(statement)).rows[0].waiting) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Timed out waiting for the expected database lock');
    };
    try {
      await controller.query('SELECT pg_advisory_lock(823648972)');
      await query(`CREATE FUNCTION cron_test_wait_issue() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(823648972); RETURN NEW; END $$`);
      await query(`CREATE TRIGGER cron_test_wait_issue BEFORE INSERT ON monitoring_issues
        FOR EACH ROW WHEN (NEW.check_id = ${created.id}) EXECUTE FUNCTION cron_test_wait_issue()`);
      observation = observe((await getMonitoringCheck(created.id))!);
      await waitFor("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = 823648972 AND NOT granted) AS waiting");
      ping = recordMonitoringCheckPing(token, 'ok');
      await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'robin-admin'
        AND wait_event_type = 'Lock' AND query LIKE '%push_token_hash = $1%') AS waiting`);
      await controller.query('SELECT pg_advisory_unlock(823648972)');
      await Promise.all([observation, ping]);
      expect((await getMonitoringCheck(created.id))?.pushRecoveredThrough).toBeInstanceOf(Date);
      await observe((await getMonitoringCheck(created.id))!);
      expect((await getMonitoringCheck(created.id))?.currentStatus).toBe('up');
      expect((await query("SELECT id FROM monitoring_issues WHERE check_id = $1 AND status = 'closed'", [created.id])).rowCount).toBe(1);
    } finally {
      await controller.query('SELECT pg_advisory_unlock(823648972)');
      await observation?.catch(() => undefined);
      await ping?.catch(() => undefined);
      controller.release();
      await query('DROP TRIGGER IF EXISTS cron_test_wait_issue ON monitoring_issues');
      await query('DROP FUNCTION IF EXISTS cron_test_wait_issue()');
    }
  }, 15_000);

  it('prunes old check-ins without losing the last sparse occurrence before the grace cutoff', async () => {
    const created = await createCheck('Sparse check-in retention');
    await updateMonitoringCheck(created.id, { pushCronExpression: '0 0 1 * *', confirmationSeconds: 86_400 });
    await query(`UPDATE monitoring_checks SET push_schedule_started_at = NOW() - INTERVAL '100 days',
      push_schedule_cursor = NOW() - INTERVAL '30 days' WHERE id = $1`, [created.id]);
    await query(`INSERT INTO monitoring_push_checkins (check_id, scheduled_at, received_at)
      VALUES ($1, NOW() - INTERVAL '60 days', NOW() - INTERVAL '60 days'),
             ($1, NOW() - INTERVAL '31 days', NOW() - INTERVAL '31 days'),
             ($1, NOW(), NOW())`, [created.id]);
    await pruneMonitoringHistory(30, 400);
    const retained = await query<{ age: number }>(
      `SELECT ROUND(EXTRACT(EPOCH FROM (NOW() - scheduled_at)) / 86400)::int AS age
       FROM monitoring_push_checkins WHERE check_id = $1 ORDER BY scheduled_at`, [created.id],
    );
    expect(retained.rows.map(row => row.age)).toEqual([31, 0]);
  });

  it('retains unprocessed check-ins when the scan cursor is behind history pruning', async () => {
    const created = await createCheck('Lagging cursor retention');
    await updateMonitoringCheck(created.id, { pushCronExpression: '0 0 * * *', confirmationSeconds: 86_400 });
    await query(`UPDATE monitoring_checks SET push_schedule_started_at = date_trunc('day', NOW()) - INTERVAL '100 days',
      push_schedule_cursor = date_trunc('day', NOW()) - INTERVAL '65 days' WHERE id = $1`, [created.id]);
    await query(`INSERT INTO monitoring_push_checkins (check_id, scheduled_at, received_at)
      SELECT $1, slot, slot FROM generate_series(date_trunc('day', NOW()) - INTERVAL '99 days',
        date_trunc('day', NOW()), INTERVAL '1 day') AS slot`, [created.id]);
    await pruneMonitoringHistory(30, 400);
    const retained = await query<{ oldest_age: number; count: string }>(
      `SELECT CURRENT_DATE - MIN(scheduled_at)::date AS oldest_age, COUNT(*) AS count
       FROM monitoring_push_checkins WHERE check_id = $1`, [created.id],
    );
    expect(retained.rows[0].oldest_age).toBe(65);
    expect(Number(retained.rows[0].count)).toBe(66);
    await observe((await getMonitoringCheck(created.id))!);
    expect((await getMonitoringCheck(created.id))?.currentStatus).toBe('up');
    expect((await query('SELECT id FROM monitoring_issues WHERE check_id = $1', [created.id])).rowCount).toBe(0);
  });

  it('preserves cron configuration and check-ins across schema initialization', async () => {
    const created = await createCheck('Schema restart');
    await query("UPDATE monitoring_checks SET push_schedule_started_at = NOW() - INTERVAL '1 day' WHERE id = $1", [created.id]);
    await recordMonitoringCheckPing((await getMonitoringCheckPushToken(created.id))!, 'ok');
    await initializeSchema();
    expect(await getMonitoringCheck(created.id)).toMatchObject({ pushCronExpression: '* * * * *', pushTimezone: 'UTC' });
    expect((await query('SELECT check_id FROM monitoring_push_checkins WHERE check_id = $1', [created.id])).rowCount).toBe(1);
  }, 30_000);
});
