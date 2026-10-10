import { describe, expect, it } from 'vitest';
import { evaluatePushCheck, evaluationIntervalSeconds, formatDuration, generatePushToken, hashPushToken, isPushToken } from './push.js';

const created = new Date('2026-10-01T00:00:00Z');
const at = (iso: string) => new Date(iso);

describe('push checks', () => {
  it('is up while pings arrive within the interval', () => {
    const check = { intervalSeconds: 3600, lastPingAt: at('2026-10-08T11:30:00Z'), lastPingStatus: 'ok' as const, createdAt: created };
    expect(evaluatePushCheck(check, at('2026-10-08T12:00:00Z'))).toMatchObject({ status: 'up', errorCode: null });
  });

  it('is down once a ping is missed, and says for how long', () => {
    const check = { intervalSeconds: 3600, lastPingAt: at('2026-10-08T09:00:00Z'), lastPingStatus: 'ok' as const, createdAt: created };
    expect(evaluatePushCheck(check, at('2026-10-08T12:00:00Z'))).toMatchObject({ status: 'down', errorCode: 'ping_missed', error: 'No ping for 3 h' });
  });

  it('counts from creation until the first ping', () => {
    const check = { intervalSeconds: 3600, lastPingAt: null, lastPingStatus: null, createdAt: at('2026-10-08T11:30:00Z') };
    expect(evaluatePushCheck(check, at('2026-10-08T12:00:00Z')).status).toBe('up');
    expect(evaluatePushCheck(check, at('2026-10-08T13:00:00Z'))).toMatchObject({ status: 'down', error: 'No ping received yet' });
  });

  it('is down when the job reports a failure', () => {
    const check = { intervalSeconds: 3600, lastPingAt: at('2026-10-08T11:59:00Z'), lastPingStatus: 'fail' as const, createdAt: created };
    expect(evaluatePushCheck(check, at('2026-10-08T12:00:00Z'))).toMatchObject({ status: 'down', errorCode: 'ping_failed' });
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
