import { describe, expect, it } from 'vitest';
import { evaluatePushCheck, evaluationIntervalSeconds, formatDuration, generatePushToken, hashPushToken, inspectPushCheckins, isPushToken, PUSH_CHECKIN_SCAN_LIMIT, pushScheduledOccurrence, resolvePushSchedule } from './push.js';

const created = new Date('2026-10-01T00:00:00Z');
const at = (iso: string) => new Date(iso);
const intervalSchedule = { confirmationSeconds: 300, pushCronExpression: null, pushTimezone: null, pushScheduleStartedAt: null, pushRecoveredThrough: null, pushScheduleCursor: null, pushRevision: 0 };
const cronCheck = {
  ...intervalSchedule,
  intervalSeconds: 3600,
  lastPingAt: null,
  lastPingStatus: null,
  createdAt: at('2026-10-08T08:15:00Z'),
  pushCronExpression: '0 9 * * *',
  pushTimezone: 'UTC',
  pushScheduleStartedAt: at('2026-10-08T08:15:00Z'),
};

describe('push checks', () => {
  it('is up while pings arrive within the interval', () => {
    const check = { ...intervalSchedule, intervalSeconds: 3600, lastPingAt: at('2026-10-08T11:30:00Z'), lastPingStatus: 'ok' as const, createdAt: created };
    expect(evaluatePushCheck(check, at('2026-10-08T12:00:00Z'))).toMatchObject({ status: 'up', errorCode: null });
  });

  it('is down once a ping is missed, and says for how long', () => {
    const check = { ...intervalSchedule, intervalSeconds: 3600, lastPingAt: at('2026-10-08T09:00:00Z'), lastPingStatus: 'ok' as const, createdAt: created };
    expect(evaluatePushCheck(check, at('2026-10-08T12:00:00Z'))).toMatchObject({ status: 'down', errorCode: 'ping_missed', error: 'No ping for 3 h' });
  });

  it('counts from creation until the first ping', () => {
    const check = { ...intervalSchedule, intervalSeconds: 3600, lastPingAt: null, lastPingStatus: null, createdAt: at('2026-10-08T11:30:00Z') };
    expect(evaluatePushCheck(check, at('2026-10-08T12:00:00Z')).status).toBe('up');
    expect(evaluatePushCheck(check, at('2026-10-08T13:00:00Z'))).toMatchObject({ status: 'down', error: 'No ping received yet' });
  });

  it('is down when the job reports a failure', () => {
    const check = { ...intervalSchedule, intervalSeconds: 3600, lastPingAt: at('2026-10-08T11:59:00Z'), lastPingStatus: 'fail' as const, createdAt: created };
    expect(evaluatePushCheck(check, at('2026-10-08T12:00:00Z'))).toMatchObject({ status: 'down', errorCode: 'ping_failed' });
  });

  describe('cron push schedules', () => {
    it('starts with the first occurrence after configuration and applies grace once', () => {
      expect(evaluatePushCheck(cronCheck, at('2026-10-08T08:59:59Z')).status).toBe('up');
      expect(evaluatePushCheck(cronCheck, at('2026-10-08T09:04:59.999Z')).status).toBe('up');
      expect(evaluatePushCheck(cronCheck, at('2026-10-08T09:05:00Z')).status).toBe('up');
      expect(evaluatePushCheck(cronCheck, at('2026-10-08T09:05:00.001Z'))).toMatchObject({
        status: 'down', errorCode: 'cron_ping_missed', details: { scheduledAt: '2026-10-08T09:00:00.000Z' },
      });
    });

    it('does not count early or late pings as on-time check-ins and reports explicit failures', () => {
      const early = { ...cronCheck, lastPingAt: at('2026-10-08T08:59:59Z'), lastPingStatus: 'ok' as const };
      expect(evaluatePushCheck(early, at('2026-10-08T09:05:00.001Z')).status).toBe('down');
      const onTime = { ...early, lastPingAt: at('2026-10-08T09:00:00Z') };
      expect(pushScheduledOccurrence(onTime, onTime.lastPingAt)?.toISOString()).toBe('2026-10-08T09:00:00.000Z');
      expect(evaluatePushCheck(onTime, at('2026-10-08T09:05:00Z'), true).status).toBe('up');
      const late = { ...early, lastPingAt: at('2026-10-08T09:06:00Z') };
      expect(evaluatePushCheck(late, at('2026-10-08T09:06:00Z')).status).toBe('down');
      expect(evaluatePushCheck({ ...late, lastPingStatus: 'fail' }, at('2026-10-08T09:06:00Z')))
        .toMatchObject({ status: 'down', errorCode: 'ping_failed' });
    });

    it('does not mark frequent jobs down during the grace period for the current run', () => {
      const check = { ...cronCheck, pushCronExpression: '* * * * *', lastPingAt: at('2026-10-08T08:59:10Z'), lastPingStatus: 'ok' as const };
      expect(evaluatePushCheck(check, at('2026-10-08T09:00:00Z'), true).status).toBe('up');
      expect(evaluatePushCheck(check, at('2026-10-08T09:05:00.001Z')).status).toBe('down');
    });

    it('uses the selected timezone and handles DST gaps and repeated fixed times', () => {
      const spring = { ...cronCheck, confirmationSeconds: 0, pushCronExpression: '30 2 * * *', pushTimezone: 'America/New_York', pushScheduleStartedAt: at('2026-03-07T08:00:00Z') };
      expect(evaluatePushCheck(spring, at('2026-03-08T06:59:59Z')).status).toBe('up');
      expect(evaluatePushCheck(spring, at('2026-03-08T07:00:00Z')).status).toBe('up');
      expect(evaluatePushCheck(spring, at('2026-03-08T07:00:00.001Z'))).toMatchObject({
        status: 'down', details: { scheduledAt: '2026-03-08T07:00:00.000Z' },
      });
      const fall = { ...spring, pushCronExpression: '30 1 * * *', pushScheduleStartedAt: at('2026-10-31T08:00:00Z'), lastPingAt: at('2026-11-01T05:30:00Z'), lastPingStatus: 'ok' as const };
      expect(evaluatePushCheck(fall, at('2026-11-01T06:30:00Z'), true).status).toBe('up');
      expect(evaluatePushCheck(fall, at('2026-11-02T06:30:00.001Z'))).toMatchObject({
        status: 'down', details: { scheduledAt: '2026-11-02T06:30:00.000Z' },
      });
    });

    it('handles sparse schedules without treating pre-configuration runs as missed', () => {
      const check = { ...cronCheck, confirmationSeconds: 0, pushCronExpression: '0 0 29 2 *', pushScheduleStartedAt: at('2097-01-01T00:00:00Z') };
      expect(evaluatePushCheck(check, at('2100-03-01T00:00:00Z')).status).toBe('up');
      expect(evaluatePushCheck(check, at('2104-02-29T00:00:00.001Z'))).toMatchObject({
        status: 'down', details: { scheduledAt: '2104-02-29T00:00:00.000Z' },
      });
    });

    it('finds an omitted occurrence even when the next expired run has a check-in', () => {
      const check = { ...cronCheck, pushCronExpression: '* * * * *', pushScheduleCursor: at('2026-10-08T08:58:00Z') };
      expect(inspectPushCheckins(check, at('2026-10-08T09:01:00Z'), [
        at('2026-10-08T08:59:00Z'), at('2026-10-08T09:01:00Z'),
      ])).toEqual({
        scheduledAt: at('2026-10-08T09:00:00Z'), received: false,
        evaluatedThrough: at('2026-10-08T09:00:00Z'), hasMore: false,
      });
    });

    it('bounds successful catch-up and continues from the last processed occurrence', () => {
      const start = at('2026-10-08T08:00:00Z');
      const check = { ...cronCheck, pushCronExpression: '* * * * *', pushScheduleStartedAt: start };
      const slot = (number: number) => new Date(start.getTime() + number * 60_000);
      const checkins = Array.from({ length: PUSH_CHECKIN_SCAN_LIMIT }, (_, index) => slot(index + 1));
      const result = inspectPushCheckins(check, slot(PUSH_CHECKIN_SCAN_LIMIT + 1), checkins);
      expect(result).toEqual({
        scheduledAt: slot(PUSH_CHECKIN_SCAN_LIMIT), received: true,
        evaluatedThrough: slot(PUSH_CHECKIN_SCAN_LIMIT), hasMore: true,
      });
      expect(inspectPushCheckins({ ...check, pushScheduleCursor: result.evaluatedThrough }, slot(PUSH_CHECKIN_SCAN_LIMIT + 1), []))
        .toMatchObject({ scheduledAt: slot(PUSH_CHECKIN_SCAN_LIMIT + 1), received: false });
    });

    it('scans DST-shifted occurrences using the same times as ping assignment', () => {
      const check = {
        ...cronCheck, pushCronExpression: '30 2 * * *', pushTimezone: 'America/New_York',
        pushScheduleStartedAt: at('2026-03-01T00:00:00Z'), pushScheduleCursor: at('2026-03-07T07:30:00Z'),
      };
      const checkins = [at('2026-03-08T07:00:00Z'), at('2026-03-09T06:30:00Z')];
      expect(inspectPushCheckins(check, checkins[1], checkins)).toMatchObject({ received: true, evaluatedThrough: checkins[1] });
    });

    it('validates five-field schedules, timezones, partial updates, and disabling cron', () => {
      const current = { checkType: 'push' as const, pushCronExpression: '0 9 * * *', pushTimezone: 'UTC' };
      expect(resolvePushSchedule('push', { pushCronExpression: ' 0  17 * * MON-FRI ', pushTimezone: 'Europe/London' }))
        .toEqual({ pushCronExpression: '0 17 * * MON-FRI', pushTimezone: 'Europe/London' });
      expect(resolvePushSchedule('push', { pushTimezone: 'America/New_York' }, current))
        .toEqual({ pushCronExpression: current.pushCronExpression, pushTimezone: 'America/New_York' });
      expect(resolvePushSchedule('push', { pushCronExpression: null }, current))
        .toEqual({ pushCronExpression: null, pushTimezone: null });
      for (const [expression, timezone] of [
        ['@daily', 'UTC'], ['0 0 0 * * *', 'UTC'], ['70 * * * *', 'UTC'], ['0 0 31 2 *', 'UTC'],
        ['H * * * *', 'UTC'], ['* * * * *', 'Invalid/Zone'], ['* * * * *', '+01:00'], ['* * * * *', ''],
      ]) {
        expect(() => resolvePushSchedule('push', { pushCronExpression: expression, pushTimezone: timezone })).toThrow();
      }
      expect(() => resolvePushSchedule('push', { pushCronExpression: '* * * * *' })).toThrow('both required');
      expect(() => resolvePushSchedule('http', { pushCronExpression: '* * * * *', pushTimezone: 'UTC' })).toThrow('only supported');
    });
  });

  it('is evaluated every minute however long its interval', () => {
    expect(evaluationIntervalSeconds({ checkType: 'push', intervalSeconds: 604800 })).toBe(60);
    expect(evaluationIntervalSeconds({ checkType: 'push', intervalSeconds: 30 })).toBe(30);
    expect(evaluationIntervalSeconds({ checkType: 'http', intervalSeconds: 300 })).toBe(300);
  });

  it('generates URL-safe tokens and hashes them for lookup', () => {
    const token = generatePushToken();
    expect(isPushToken(token)).toBe(true);
    expect(isPushToken('short')).toBe(false);
    expect(hashPushToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(formatDuration(90)).toBe('90 s');
    expect(formatDuration(3 * 86400)).toBe('3 days');
  });
});
