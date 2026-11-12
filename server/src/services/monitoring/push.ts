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
import { Cron } from 'croner';
import type { MonitoringCheck, MonitoringCheckType } from '../../types/monitoring.js';
import type { MonitoringProbeResult } from './probes.js';
import { MonitoringInputError } from './options.js';

/** How often a push check is evaluated, however long its interval. */
export const PUSH_EVALUATION_SECONDS = 60;
export const PUSH_INTERVAL_MAX_SECONDS = 30 * 24 * 3600;
export const PUSH_CHECKIN_SCAN_LIMIT = 1000;
export const PUSH_MAX_RUNTIME_DEFAULT_SECONDS = 3600;
export const PUSH_MAX_RUNTIME_MAX_SECONDS = 7 * 24 * 3600;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CRON_NAMES = new Set(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC', 'SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);

type PushSchedule = Pick<MonitoringCheck, 'pushCronExpression' | 'pushTimezone'>;
type PushScheduleInput = { pushCronExpression?: unknown; pushTimezone?: unknown };
type CurrentPushSchedule = PushSchedule & Pick<MonitoringCheck, 'checkType'>;

function scheduleField(value: unknown, name: string, maximumLength: number): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximumLength) {
    throw new MonitoringInputError(`${name} must be a non-empty string of at most ${maximumLength} characters`);
  }
  return value.trim();
}

function cronSchedule(expression: string, timezone: string): Cron {
  return new Cron(expression, { timezone, mode: '5-part', domAndDow: false });
}

/** Validate a complete schedule, including partial updates and type changes. */
export function resolvePushSchedule(
  checkType: MonitoringCheckType,
  input: PushScheduleInput,
  current?: CurrentPushSchedule,
): PushSchedule {
  const expression = scheduleField(input.pushCronExpression, 'pushCronExpression', 100);
  const timezone = scheduleField(input.pushTimezone, 'pushTimezone', 128);
  if (checkType !== 'push') {
    if (expression || timezone) throw new MonitoringInputError('Cron schedules are only supported for push checks');
    return { pushCronExpression: null, pushTimezone: null };
  }
  const existing = current?.checkType === 'push' ? current : undefined;
  const nextExpression = expression === undefined ? existing?.pushCronExpression ?? null : expression;
  const nextTimezone = timezone === undefined
    ? expression === null ? null : existing?.pushTimezone ?? null
    : timezone;
  if (nextExpression === null && nextTimezone === null) return { pushCronExpression: null, pushTimezone: null };
  if (!nextExpression || !nextTimezone) throw new MonitoringInputError('Cron expression and timezone are both required');

  const normalizedExpression = nextExpression.split(/\s+/).join(' ');
  const fields = normalizedExpression.split(' ');
  if (fields.length !== 5 || fields.some(field => !/^[a-z0-9*,/-]+$/i.test(field))
    || (normalizedExpression.match(/[a-z]+/gi) ?? []).some(name => !CRON_NAMES.has(name.toUpperCase()))) {
    throw new MonitoringInputError('Cron expression must have five standard fields using numbers, names, ranges, lists, or steps');
  }
  if (!/^[a-z][a-z0-9._+/-]*$/i.test(nextTimezone)) {
    throw new MonitoringInputError('Timezone must be a valid IANA timezone, such as UTC or Europe/London');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: nextTimezone });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new MonitoringInputError('Timezone must be a valid IANA timezone, such as UTC or Europe/London');
  }
  try {
    if (!cronSchedule(normalizedExpression, nextTimezone).nextRun()) {
      throw new MonitoringInputError('Cron expression must have a future occurrence');
    }
  } catch (error) {
    if (error instanceof MonitoringInputError) throw error;
    if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
    throw new MonitoringInputError(`Invalid cron expression: ${error.message}`);
  }
  return { pushCronExpression: normalizedExpression, pushTimezone: nextTimezone };
}

export function generatePushToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isPushToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function isPushRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}

export function hashPushToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The interval the scheduler runs a check on. */
export function evaluationIntervalSeconds(check: Pick<MonitoringCheck, 'checkType' | 'intervalSeconds'>): number {
  return check.checkType === 'push' ? Math.min(check.intervalSeconds, PUSH_EVALUATION_SECONDS) : check.intervalSeconds;
}

type CronScheduleState = Pick<MonitoringCheck, 'pushCronExpression' | 'pushTimezone' | 'pushScheduleStartedAt'>;

/** The latest scheduled occurrence at or before the supplied time. */
export function pushScheduledOccurrence(check: CronScheduleState, time: Date): Date | null {
  if (!check.pushCronExpression) return null;
  if (!check.pushTimezone || !check.pushScheduleStartedAt) throw new Error('Stored push cron schedule is incomplete');
  // previousRuns excludes its reference second; adding one second makes a
  // five-field occurrence exactly at the boundary inclusive.
  const scheduled = cronSchedule(check.pushCronExpression, check.pushTimezone)
    .previousRuns(1, new Date(time.getTime() + 1000))[0];
  return scheduled && scheduled > check.pushScheduleStartedAt ? scheduled : null;
}

export function expiredPushOccurrence(
  check: CronScheduleState & Pick<MonitoringCheck, 'confirmationSeconds'>,
  now: Date,
): Date | null {
  // A receipt at the deadline is valid, so the occurrence expires strictly after it.
  return pushScheduledOccurrence(check, new Date(now.getTime() - check.confirmationSeconds * 1000 - 1));
}

type CronProgress = CronScheduleState & Pick<MonitoringCheck, 'pushScheduleCursor' | 'pushRecoveredThrough'>;

export function pushCheckinScanStart(check: CronProgress): Date {
  if (!check.pushScheduleStartedAt) throw new Error('Stored push cron schedule is incomplete');
  return [check.pushScheduleStartedAt, check.pushScheduleCursor, check.pushRecoveredThrough]
    .reduce<Date>((latest, value) => value && value > latest ? value : latest, check.pushScheduleStartedAt);
}

/** Find the first unfulfilled expired run without skipping runs between evaluations. */
export function inspectPushCheckins(
  check: CronProgress,
  due: Date,
  checkins: Date[],
): { scheduledAt: Date; received: boolean; evaluatedThrough: Date; hasMore: boolean } {
  if (!check.pushCronExpression || !check.pushTimezone) throw new Error('Stored push cron schedule is incomplete');
  const cron = cronSchedule(check.pushCronExpression, check.pushTimezone);
  const start = pushCheckinScanStart(check);
  let through = start;
  let expected = cron.nextRun(through);
  for (const received of checkins) {
    if (!expected || expected > due) break;
    if (received < expected) continue;
    if (received > expected) return { scheduledAt: expected, received: false, evaluatedThrough: expected, hasMore: false };
    through = expected;
    expected = cron.nextRun(through);
  }
  if (expected && expected <= due) {
    if (checkins.length < PUSH_CHECKIN_SCAN_LIMIT) {
      return { scheduledAt: expected, received: false, evaluatedThrough: expected, hasMore: false };
    }
    if (through > start) return { scheduledAt: through, received: true, evaluatedThrough: through, hasMore: true };
  }
  if (through.getTime() !== due.getTime()) {
    throw new Error('Stored push cron schedule could not advance to its expired occurrence');
  }
  return { scheduledAt: through, received: true, evaluatedThrough: through, hasMore: false };
}

export function evaluatePushCheck(
  check: Pick<MonitoringCheck, 'intervalSeconds' | 'confirmationSeconds' | 'lastPingAt' | 'lastPingStatus' | 'createdAt' | 'pushCronExpression' | 'pushTimezone' | 'pushScheduleStartedAt' | 'pushRecoveredThrough' | 'pushScheduleCursor' | 'pushRevision'>,
  now: Date,
  scheduledPingReceived = false,
  scheduledOverride?: Date,
): MonitoringProbeResult {
  const since = check.lastPingAt ?? check.createdAt;
  const ageSeconds = Math.max(0, Math.round((now.getTime() - since.getTime()) / 1000));
  const details = {
    lastPingAt: check.lastPingAt?.toISOString() ?? null,
    secondsSinceLastPing: check.lastPingAt ? ageSeconds : null,
    pushScheduleStartedAt: check.pushScheduleStartedAt?.toISOString() ?? null,
    pushObservedCursor: check.pushScheduleCursor?.toISOString() ?? null,
    pushRevision: check.pushRevision,
  };
  if (check.lastPingStatus === 'fail') {
    return { status: 'down', responseTimeMs: 0, error: 'The job reported a failure', errorCode: 'ping_failed', details };
  }
  if (check.pushCronExpression) {
    const scheduled = scheduledOverride ?? expiredPushOccurrence(check, now);
    if (scheduled && (!check.pushRecoveredThrough || scheduled > check.pushRecoveredThrough) && !scheduledPingReceived) {
      return {
        status: 'down',
        responseTimeMs: 0,
        error: `No successful ping since scheduled run ${scheduled.toISOString()}`,
        errorCode: 'cron_ping_missed',
        details: { ...details, scheduledAt: scheduled.toISOString(), graceSeconds: check.confirmationSeconds },
      };
    }
    return { status: 'up', responseTimeMs: 0, error: null, errorCode: null, details };
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
