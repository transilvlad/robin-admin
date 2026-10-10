/**
 * Push checks: instead of probing a target, Robin Admin waits for the target
 * (a cron job, a backup script) to call a secret ping URL. The check is up
 * while pings arrive within its interval, down when one is missed or a job
 * reports failure. The confirmation window is the grace period before an
 * issue opens, so issues, alerts and status pages work as for any check.
 *
 * Push checks only ever run on the Robin Admin server (the Local location):
 * remote probe agents have nothing to probe.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { MonitoringCheck } from '../../types/monitoring.js';
import type { MonitoringProbeResult } from './probes.js';

/** How often a push check is evaluated, however long its interval. */
export const PUSH_EVALUATION_SECONDS = 60;
export const PUSH_INTERVAL_MAX_SECONDS = 30 * 24 * 3600;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generatePushToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isPushToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function hashPushToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The interval the scheduler runs a check on. */
export function evaluationIntervalSeconds(check: Pick<MonitoringCheck, 'checkType' | 'intervalSeconds'>): number {
  return check.checkType === 'push' ? Math.min(check.intervalSeconds, PUSH_EVALUATION_SECONDS) : check.intervalSeconds;
}

export function evaluatePushCheck(
  check: Pick<MonitoringCheck, 'intervalSeconds' | 'lastPingAt' | 'lastPingStatus' | 'createdAt'>,
  now: Date,
): MonitoringProbeResult {
  const since = check.lastPingAt ?? check.createdAt;
  const ageSeconds = Math.max(0, Math.round((now.getTime() - since.getTime()) / 1000));
  const details = { lastPingAt: check.lastPingAt?.toISOString() ?? null, secondsSinceLastPing: check.lastPingAt ? ageSeconds : null };
  if (check.lastPingStatus === 'fail') {
    return { status: 'down', responseTimeMs: 0, error: 'The job reported a failure', errorCode: 'ping_failed', details };
  }
  if (ageSeconds > check.intervalSeconds) {
    return {
      status: 'down',
      responseTimeMs: 0,
      error: check.lastPingAt ? `No ping for ${formatDuration(ageSeconds)}` : 'No ping received yet',
      errorCode: 'ping_missed',
      details,
    };
  }
  return { status: 'up', responseTimeMs: 0, error: null, errorCode: null, details };
}

export function formatDuration(seconds: number): string {
  if (seconds < 120) return `${seconds} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} days`;
}
