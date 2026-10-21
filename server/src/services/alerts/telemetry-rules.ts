/**
 * Telemetry alert rules: an instant query against the telemetry store, a
 * condition (comparator and threshold) and a duration. Each result series (for
 * example each host) is tracked on its own: pending while the condition holds,
 * firing once it has held for the rule's duration, and recovered when it stops
 * holding. Deliveries go to webhooks subscribed to 'telemetry_rule'.
 */
import { createHash, randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { getClient } from '../../db/connection.js';
import { createAlertDelivery, listAlertWebhooks } from '../../db/queries/alerts.js';
import {
  clearDisabledTelemetryAlertStates,
  deleteTelemetryAlertRule,
  deleteTelemetryAlertState,
  listEnabledTelemetryAlertRules,
  listTelemetryAlertRulesByIds,
  loadTelemetryAlertStates,
  recordTelemetryAlertRuleEvaluation,
  saveTelemetryAlertState,
  updateTelemetryAlertRule,
  type StateRow,
} from '../../db/queries/telemetry-alert-rules.js';
import {
  cancelTelemetryAlertIssueFailures,
  cancelTelemetryAlertIssueDismissals,
  createTelemetryAlertIssue,
  getTelemetryAlertIssue,
  recordTelemetryAlertIssueEvent,
  resolveTelemetryAlertIssue,
  updateTelemetryAlertIssueObservation,
  updateTelemetryAlertIssueSeverity,
} from '../../db/queries/telemetry-alert-issues.js';
import { logger } from '../../logger.js';
import type { AlertWebhook, JsonRecord } from '../../types/alerts.js';
import type {
  TelemetryAlertComparator,
  TelemetryAlertPreviewSeries,
  TelemetryAlertRule,
  TelemetryAlertRuleInput,
} from '../../types/telemetry-alerts.js';
import { operationsPolicy } from '../operations-settings.js';
import { queryInstant } from '../telemetry/query.js';
import { buildSentryAlertPayload } from './sentry.js';

const EVALUATOR_LOCK_ID = 846_255_032;
// One rule may track at most this many series; more are reported as an error.
export const MAX_RULE_SERIES = 500;
// A firing series that stops being reported recovers after this long, so a
// decommissioned host does not stay firing forever. A host that stops sending
// altogether is better caught by a rule on its last sample age.
export const ABSENT_RESOLVE_SECONDS = 600;

type QueryInstant = typeof queryInstant;
export type TelemetryRuleEvent = 'failure' | 'recovery' | 'dismissed';

export function compareValue(value: number | null, comparator: TelemetryAlertComparator, threshold: number): boolean {
  if (value === null || !Number.isFinite(value)) return false;
  switch (comparator) {
    case '>': return value > threshold;
    case '>=': return value >= threshold;
    case '<': return value < threshold;
    case '<=': return value <= threshold;
    case '==': return value === threshold;
    case '!=': return value !== threshold;
  }
}

/** Stable key for a series' labels, whatever order the store returns them in. */
export function seriesKey(labels: Record<string, string>): string {
  const sorted = Object.keys(labels).sort().map((name) => [name, labels[name]]);
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

export function formatSeriesLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels).filter(([name]) => name !== '__name__');
  if (entries.length === 0) return 'all series';
  return entries.sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}=${value}`).join(', ');
}

// Why a firing series recovered without its condition clearing.
export type TelemetryRuleClearReason = 'edited' | 'disabled' | 'deleted';

export interface SeriesTransition {
  next: StateRow | null;
  event: Exclude<TelemetryRuleEvent, 'dismissed'> | null;
  absent: boolean;
  cleared?: TelemetryRuleClearReason;
}

/**
 * One series' next state. `observed` is null when the series is missing from
 * this evaluation's result. `ruleUpdatedAt` is when the rule was last edited:
 * a firing series last seen before an edit and missing after it is no longer
 * covered by the rule, so it recovers at once instead of after the absence
 * grace period.
 */
export function transitionSeries(input: {
  ruleId: number;
  forSeconds: number;
  previous: StateRow | null;
  observed: { key: string; labels: Record<string, string>; value: number | null; matches: boolean } | null;
  now: Date;
  ruleUpdatedAt?: Date;
}): SeriesTransition {
  const { previous, observed, now } = input;
  if (!observed) {
    if (!previous) return { next: null, event: null, absent: true };
    if (previous.status === 'pending') return { next: null, event: null, absent: true };
    if (input.ruleUpdatedAt && input.ruleUpdatedAt > previous.last_seen_at) {
      return { next: null, event: 'recovery', absent: true, cleared: 'edited' };
    }
    if (now.getTime() - previous.last_seen_at.getTime() >= ABSENT_RESOLVE_SECONDS * 1000) {
      return { next: null, event: 'recovery', absent: true };
    }
    return { next: previous, event: null, absent: true };
  }
  if (!observed.matches) {
    return {
      next: null,
      event: previous?.status === 'firing' ? 'recovery' : null,
      absent: false,
      ...(previous?.status === 'firing' && input.ruleUpdatedAt && input.ruleUpdatedAt > previous.last_seen_at ? { cleared: 'edited' as const } : {}),
    };
  }
  const base: StateRow = {
    rule_id: input.ruleId,
    series_key: observed.key,
    issue_id: previous?.issue_id ?? null,
    labels_json: observed.labels,
    status: previous?.status ?? 'pending',
    pending_since: previous?.pending_since ?? now,
    firing_since: previous?.firing_since ?? null,
    last_value: observed.value,
    last_seen_at: now,
  };
  if (base.status === 'firing') return { next: base, event: null, absent: false };
  if (now.getTime() - base.pending_since.getTime() >= input.forSeconds * 1000) {
    return { next: { ...base, status: 'firing', firing_since: now }, event: 'failure', absent: false };
  }
  return { next: base, event: null, absent: false };
}

export async function previewTelemetryAlertRule(
  input: { query: string; comparator: TelemetryAlertComparator; threshold: number },
  runQuery: QueryInstant = queryInstant,
): Promise<{ series: TelemetryAlertPreviewSeries[]; truncated: boolean }> {
  const result = await runQuery({ query: input.query, maxSeries: MAX_RULE_SERIES });
  return {
    series: result.series.map((series) => ({
      labels: series.labels,
      value: series.value,
      matches: compareValue(series.value, input.comparator, input.threshold),
    })),
    truncated: result.truncated,
  };
}

interface PendingDelivery {
  rule: TelemetryAlertRule;
  event: TelemetryRuleEvent;
  state: StateRow;
  issueRevision?: number;
  absent: boolean;
  now: Date;
  cleared?: TelemetryRuleClearReason;
}

/** Recoveries for the firing series of a rule that stopped tracking them. */
function clearedRecoveries(rule: TelemetryAlertRule, states: StateRow[], cleared: TelemetryRuleClearReason, now: Date): PendingDelivery[] {
  return states
    .filter((state) => state.status === 'firing')
    .map((state) => ({ rule, event: 'recovery' as const, state, absent: false, now, cleared }));
}

async function recoverDisabledRules(client: PoolClient, now: Date): Promise<PendingDelivery[]> {
  const firing = (await clearDisabledTelemetryAlertStates(client)).filter((state) => state.status === 'firing');
  if (firing.length === 0) return [];
  const rules = await listTelemetryAlertRulesByIds(client, [...new Set(firing.map((state) => state.rule_id))]);
  for (const state of firing) {
    if (state.issue_id) await resolveTelemetryAlertIssue(client, state.issue_id, 'disabled', now);
  }
  return rules.flatMap((rule) => clearedRecoveries(rule, firing.filter((state) => state.rule_id === rule.id), 'disabled', now));
}

/**
 * Deletes a rule and recovers each series it had firing, so Slack hears the
 * recovery and the Sentry issue resolves. Waits for a running evaluation.
 */
export async function deleteTelemetryAlertRuleWithRecoveries(id: number, now = new Date()): Promise<boolean> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [EVALUATOR_LOCK_ID]);
    const [rule] = await listTelemetryAlertRulesByIds(client, [id]);
    if (!rule) {
      await client.query('ROLLBACK');
      return false;
    }
    const states = await loadTelemetryAlertStates(client, id);
    for (const state of states.filter((item) => item.status === 'firing' && item.issue_id)) {
      await resolveTelemetryAlertIssue(client, state.issue_id!, 'deleted', now);
    }
    await enqueueDeliveries(client, clearedRecoveries(rule, states, 'deleted', now));
    await deleteTelemetryAlertRule(client, id);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export type TelemetryAlertIssueActionResult = 'updated' | 'not_found' | 'conflict';

export async function changeTelemetryAlertIssueDismissal(input: {
  issueId: string;
  action: 'dismiss' | 'resume';
  expectedRevision: number;
  actorAdminId: number | null;
  reason?: string | null;
  until?: Date | null;
  actorName?: string | null;
}): Promise<TelemetryAlertIssueActionResult> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [EVALUATOR_LOCK_ID]);
    const [clock] = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows;
    const now = clock.now;
    if (input.action === 'dismiss' && input.until && input.until <= now) {
      await client.query('ROLLBACK');
      return 'conflict';
    }
    const issue = await getTelemetryAlertIssue(client, input.issueId, true);
    if (!issue) {
      await client.query('ROLLBACK');
      return 'not_found';
    }
    if (issue.revision !== input.expectedRevision
      || issue.status !== (input.action === 'dismiss' ? 'active' : 'dismissed')) {
      await client.query('ROLLBACK');
      return 'conflict';
    }
    const rules = await listTelemetryAlertRulesByIds(client, [issue.ruleId]);
    const rule = rules[0];
    if (!rule?.enabled) {
      await client.query('ROLLBACK');
      return 'conflict';
    }
    const states = await loadTelemetryAlertStates(client, issue.ruleId);
    const state = states.find((item) => item.series_key === issue.seriesKey && item.status === 'firing' && item.issue_id === issue.id);
    if (!state) {
      await client.query('ROLLBACK');
      return 'conflict';
    }
    if (input.action === 'dismiss') {
      const updated = await client.query(
        `UPDATE telemetry_alert_issues
         SET status = 'dismissed', dismissed_at = $2, dismissed_by = $3, dismissed_until = $4,
             dismissal_reason = $5, revision = revision + 1, resume_notification_pending = false
         WHERE id = $1 AND revision = $6 AND status = 'active'`,
        [issue.id, now, input.actorAdminId, input.until ?? null, input.reason ?? null, input.expectedRevision],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        await client.query('ROLLBACK');
        return 'conflict';
      }
      await recordTelemetryAlertIssueEvent(
        client, issue.id, 'dismissed', input.actorAdminId, input.reason ?? null, now, input.actorName ?? null, input.until ?? null,
      );
      await cancelTelemetryAlertIssueFailures(client, issue.id, 'Telemetry alert issue dismissed');
      await enqueueDeliveries(client, [{
        rule, event: 'dismissed', state, issueRevision: input.expectedRevision + 1, absent: false, now,
      }]);
    } else {
      const updated = await client.query(
        `UPDATE telemetry_alert_issues
         SET status = 'active', dismissed_at = NULL, dismissed_by = NULL, dismissed_until = NULL,
             dismissal_reason = NULL, revision = revision + 1, resume_notification_pending = true
         WHERE id = $1 AND revision = $2 AND status = 'dismissed'`,
        [issue.id, input.expectedRevision],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        await client.query('ROLLBACK');
        return 'conflict';
      }
      await recordTelemetryAlertIssueEvent(client, issue.id, 'resumed', input.actorAdminId, null, now, input.actorName ?? null);
      await cancelTelemetryAlertIssueDismissals(client, issue.id, 'Telemetry alert issue is active again');
    }
    await client.query('COMMIT');
    return 'updated';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateTelemetryAlertRuleWithRecoveries(
  id: number,
  input: TelemetryAlertRuleInput,
): Promise<TelemetryAlertRule | null> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [EVALUATOR_LOCK_ID]);
    const [previous] = await listTelemetryAlertRulesByIds(client, [id]);
    if (!previous) {
      await client.query('ROLLBACK');
      return null;
    }
    const updated = await updateTelemetryAlertRule(id, input, client);
    if (updated && previous.severity === 'warning' && updated.severity === 'critical') {
      const states = await loadTelemetryAlertStates(client, id);
      const [clock] = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows;
      for (const state of states.filter((item) => item.status === 'firing' && item.issue_id)) {
        await updateTelemetryAlertIssueSeverity(client, state.issue_id!, updated.severity, clock.now);
      }
    }
    await client.query('COMMIT');
    return updated;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function runTelemetryRuleEvaluation(now = new Date(), runQuery: QueryInstant = queryInstant): Promise<boolean> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS locked', [EVALUATOR_LOCK_ID]);
    if (!lock.rows[0]?.locked) {
      await client.query('ROLLBACK');
      return false;
    }
    const deliveries = await recoverDisabledRules(client, now);
    const confirmedIssueIds = new Set<string>();
    for (const rule of await listEnabledTelemetryAlertRules(client)) {
      deliveries.push(...await evaluateRule(client, rule, now, runQuery, confirmedIssueIds));
    }
    await enqueueDeliveries(client, deliveries);
    await enqueuePendingIssueAttention(client, now, confirmedIssueIds);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function evaluateRule(
  client: PoolClient,
  rule: TelemetryAlertRule,
  now: Date,
  runQuery: QueryInstant,
  confirmedIssueIds: Set<string>,
): Promise<PendingDelivery[]> {
  let result: Awaited<ReturnType<QueryInstant>>;
  try {
    result = await runQuery({ query: rule.query, maxSeries: MAX_RULE_SERIES });
  } catch (error) {
    // The store is unreachable or the query is invalid: keep every series as
    // it was rather than recovering or firing on missing data.
    await recordTelemetryAlertRuleEvaluation(client, rule.id, (error as Error).message, now);
    return [];
  }
  const previousByKey = new Map((await loadTelemetryAlertStates(client, rule.id)).map((state) => [state.series_key, state]));
  const ruleUpdatedAt = new Date(rule.updatedAt);
  const deliveries: PendingDelivery[] = [];
  const apply = async (transition: SeriesTransition, previous: StateRow | null, key: string) => {
    let next = transition.next;
    if (next?.status === 'firing') {
      if (transition.event === 'failure' || !next.issue_id) {
        const issueId = randomUUID();
        next = { ...next, issue_id: issueId };
        await createTelemetryAlertIssue(client, {
          id: issueId,
          ruleId: rule.id,
          ruleName: rule.name,
          query: rule.query,
          comparator: rule.comparator,
          threshold: rule.threshold,
          forSeconds: rule.forSeconds,
          severity: rule.severity,
          seriesKey: next.series_key,
          labels: next.labels_json,
          value: next.last_value,
          openedAt: next.firing_since ?? now,
        });
      } else if (next.issue_id) {
        if (!transition.absent) {
          if (!result.truncated) confirmedIssueIds.add(next.issue_id);
          await updateTelemetryAlertIssueObservation(client, next.issue_id, {
            rule,
            labels: next.labels_json,
            value: next.last_value,
            lastSeenAt: next.last_seen_at,
          });
        }
      }
      if (next.issue_id && transition.event === null && !transition.absent) {
        const expired = await client.query<{ revision: number }>(
          `UPDATE telemetry_alert_issues
           SET status = 'active', dismissed_at = NULL, dismissed_by = NULL, dismissed_until = NULL,
               dismissal_reason = NULL, revision = revision + 1, resume_notification_pending = true
           WHERE id = $1 AND status = 'dismissed' AND dismissed_until IS NOT NULL AND dismissed_until <= $2
           RETURNING revision`,
          [next.issue_id, now],
        );
        if (expired.rows[0]) {
          await recordTelemetryAlertIssueEvent(client, next.issue_id, 'dismissal_expired', null, null, now);
          await cancelTelemetryAlertIssueDismissals(client, next.issue_id, 'Telemetry alert issue is active again');
        }
      }
    }
    if (next) await saveTelemetryAlertState(client, next);
    else if (previous) {
      if (previous.issue_id) {
        await resolveTelemetryAlertIssue(client, previous.issue_id,
          transition.cleared === 'edited' ? 'edited' : transition.absent ? 'absent' : 'recovered', now);
      }
      await deleteTelemetryAlertState(client, rule.id, key);
    }
    if (transition.event) {
      const state = transition.event === 'failure' ? next! : previous!;
      deliveries.push({
        rule,
        event: transition.event,
        state,
        ...(transition.event === 'failure' ? { issueRevision: 1 } : {}),
        absent: transition.absent,
        now,
        cleared: transition.cleared,
      });
    }
  };
  for (const series of result.series) {
    const key = seriesKey(series.labels);
    const previous = previousByKey.get(key) ?? null;
    previousByKey.delete(key);
    const transition = transitionSeries({
      ruleId: rule.id,
      forSeconds: rule.forSeconds,
      previous,
      observed: { key, labels: series.labels, value: series.value, matches: compareValue(series.value, rule.comparator, rule.threshold) },
      now,
      ruleUpdatedAt,
    });
    await apply(transition, previous, key);
  }
  // A truncated result does not show which series are really gone, so series
  // past the cut keep their state instead of recovering as absent.
  for (const [key, previous] of result.truncated ? [] : previousByKey) {
    await apply(transitionSeries({ ruleId: rule.id, forSeconds: rule.forSeconds, previous, observed: null, now, ruleUpdatedAt }), previous, key);
  }
  await recordTelemetryAlertRuleEvaluation(
    client,
    rule.id,
    result.truncated ? `The query returned more than ${MAX_RULE_SERIES} series; only the first ${MAX_RULE_SERIES} are evaluated.` : null,
    now,
  );
  return deliveries;
}

function subscribed(webhook: AlertWebhook, event: TelemetryRuleEvent, now: Date): boolean {
  const paused = webhook.pausedAt !== null && (webhook.pausedUntil === null || webhook.pausedUntil > now);
  return webhook.enabled && !paused
    && (event !== 'recovery' || webhook.notifyRecovery)
    && (event !== 'dismissed' || webhook.adapter === 'sentry')
    && webhook.subscriptions.some((subscription) => subscription.alertType === 'telemetry_rule' && subscription.enabled);
}

async function enqueueDeliveries(client: PoolClient, deliveries: PendingDelivery[]): Promise<void> {
  if (deliveries.length === 0) return;
  if (!operationsPolicy().alertsEnabled) return;
  const webhooks = await listAlertWebhooks();
  for (const delivery of deliveries) {
    const firingSince = delivery.state.firing_since ?? delivery.state.pending_since;
    const seriesLabel = formatSeriesLabels(delivery.state.labels_json);
    for (const webhook of webhooks.filter((item) => subscribed(item, delivery.event, delivery.now))) {
      const payload = buildTelemetryRulePayload(webhook.adapter, delivery);
      if (!payload) continue;
      await createAlertDelivery({
        dedupeKey: delivery.event === 'dismissed' && delivery.state.issue_id
          ? `telemetry-issue:${delivery.state.issue_id}:dismissed:${delivery.issueRevision}:${webhook.id}`
          : `telemetry-rule:${delivery.rule.id}:${delivery.state.series_key}:${firingSince.getTime()}:${delivery.event}:${webhook.id}`,
        webhookId: webhook.id,
        webhookName: webhook.name,
        fleetServiceId: null,
        serviceId: `telemetry-rule-${delivery.rule.id}`,
        serviceName: `${delivery.rule.name} · ${seriesLabel}`.slice(0, 160),
        serviceType: 'monitoring',
        alertType: 'telemetry_rule',
        eventKind: delivery.event,
        telemetryAlertIssueId: delivery.state.issue_id ?? null,
        telemetryAlertIssueRevision: delivery.issueRevision ?? null,
        adapter: webhook.adapter,
        payload,
        client,
      });
    }
  }
  logger.info('Telemetry alert rule notifications queued', { count: deliveries.length });
}

async function enqueuePendingIssueAttention(client: PoolClient, now: Date, confirmedIssueIds: Set<string>): Promise<void> {
  if (!operationsPolicy().alertsEnabled || confirmedIssueIds.size === 0) return;
  const webhooks = await listAlertWebhooks();
  const pending = await client.query<{
    id: string; rule_id: number; rule_name: string; query: string; comparator: TelemetryAlertComparator;
    threshold: number; for_seconds: number; severity: TelemetryAlertRule['severity']; series_key: string;
    labels_json: Record<string, string>; last_value: number | null; opened_at: Date; revision: number;
  }>(
    `SELECT id, rule_id, rule_name, query, comparator, threshold, for_seconds, severity, series_key,
            labels_json, last_value, opened_at, revision
     FROM telemetry_alert_issues
     WHERE status = 'active' AND resume_notification_pending = true
       AND id = ANY($1::uuid[])
     ORDER BY opened_at`,
    [[...confirmedIssueIds]],
  );
  for (const issue of pending.rows) {
    const rule = {
      id: issue.rule_id, name: issue.rule_name, description: null, query: issue.query, comparator: issue.comparator,
      threshold: Number(issue.threshold), forSeconds: issue.for_seconds, severity: issue.severity, enabled: true,
      lastEvaluatedAt: null, lastError: null, createdAt: issue.opened_at.toISOString(), updatedAt: issue.opened_at.toISOString(),
    };
    const state: StateRow = {
      rule_id: issue.rule_id, series_key: issue.series_key, issue_id: issue.id, labels_json: issue.labels_json,
      status: 'firing', pending_since: issue.opened_at, firing_since: issue.opened_at,
      last_value: issue.last_value, last_seen_at: now,
    };
    const eligible = webhooks.filter((item) => item.adapter !== 'sentry' && subscribed(item, 'failure', now));
    const sentry = webhooks.filter((item) => item.adapter === 'sentry' && subscribed(item, 'failure', now));
    let queued = false;
    for (const webhook of [...eligible, ...sentry]) {
      const payload = buildTelemetryRulePayload(webhook.adapter, {
        rule, event: 'failure', state, absent: false, now,
      });
      if (!payload) continue;
      await createAlertDelivery({
        dedupeKey: `telemetry-issue:${issue.id}:attention:${issue.revision}:${webhook.id}`,
        webhookId: webhook.id,
        webhookName: webhook.name,
        fleetServiceId: null,
        serviceId: `telemetry-rule-${issue.rule_id}`,
        serviceName: `${issue.rule_name} · ${formatSeriesLabels(issue.labels_json)}`.slice(0, 160),
        serviceType: 'monitoring',
        alertType: 'telemetry_rule',
        eventKind: 'failure',
        telemetryAlertIssueId: issue.id,
        telemetryAlertIssueRevision: issue.revision,
        adapter: webhook.adapter,
        payload,
        client,
      });
      queued = true;
    }
    if (queued) {
      await client.query(
        'UPDATE telemetry_alert_issues SET resume_notification_pending = false WHERE id = $1 AND revision = $2',
        [issue.id, issue.revision],
      );
    }
  }
}

export function describeCondition(rule: Pick<TelemetryAlertRule, 'comparator' | 'threshold' | 'forSeconds'>): string {
  const duration = rule.forSeconds === 0
    ? 'immediately'
    : rule.forSeconds % 60 === 0 ? `for ${rule.forSeconds / 60} min` : `for ${rule.forSeconds} s`;
  return `${rule.comparator} ${rule.threshold} ${duration}`;
}

export function buildTelemetryRulePayload(
  adapter: AlertWebhook['adapter'],
  delivery: Pick<PendingDelivery, 'rule' | 'event' | 'state' | 'absent' | 'now' | 'cleared'>,
): JsonRecord | null {
  const { rule, event, state } = delivery;
  if (event === 'dismissed' && adapter !== 'sentry') return null;
  const seriesLabel = formatSeriesLabels(state.labels_json);
  const value = state.last_value === null ? 'n/a' : String(Number(state.last_value.toFixed(4)));
  const outcome = event === 'failure'
    ? `${rule.name} is firing for ${seriesLabel}`
    : event === 'dismissed'
      ? `${rule.name} was dismissed while still firing for ${seriesLabel}`
      : delivery.cleared
      ? `${rule.name} cleared for ${seriesLabel}: the rule was ${delivery.cleared}`
      : delivery.absent ? `${rule.name} recovered: ${seriesLabel} is no longer reported` : `${rule.name} recovered for ${seriesLabel}`;
  const detail: JsonRecord = {
    version: 1,
    eventKind: event,
    alertType: 'telemetry_rule',
    summary: outcome,
    rule: {
      id: rule.id,
      name: rule.name,
      query: rule.query,
      comparator: rule.comparator,
      threshold: rule.threshold,
      forSeconds: rule.forSeconds,
      severity: rule.severity,
    },
    series: { labels: state.labels_json, value: state.last_value },
    firingSince: state.firing_since?.toISOString() ?? null,
    observedAt: delivery.now.toISOString(),
  };
  if (adapter === 'sentry') {
    const labelTags = Object.fromEntries(Object.entries(state.labels_json)
      .filter(([name]) => name !== '__name__')
      .slice(0, 8)
      .map(([name, labelValue]) => [name === 'host' || name === 'role' ? name : `label.${name}`, labelValue]));
    return buildSentryAlertPayload({
      alertKey: `telemetry:${rule.id}:${state.series_key.slice(0, 16)}`,
      alertType: 'telemetry_rule',
      eventKind: event,
      title: `${rule.name}: ${seriesLabel}`,
      message: outcome,
      severity: rule.severity,
      tags: { rule: rule.name, ...labelTags },
      context: {
        ruleId: rule.id,
        query: rule.query,
        condition: describeCondition(rule),
        value: state.last_value,
        series: seriesLabel,
        firingSince: state.firing_since?.toISOString() ?? null,
      },
      linkPath: '/administration/alerts',
      occurredAt: delivery.now,
    });
  }
  if (adapter !== 'slack') return detail;
  const title = event === 'recovery'
    ? `Telemetry recovered: ${rule.name}`
    : `Telemetry ${rule.severity}: ${rule.name}`;
  const fields = [
    slackField('Series', seriesLabel),
    slackField(event === 'recovery' ? 'Last value' : 'Value', value),
    slackField('Condition', describeCondition(rule)),
    slackField(event === 'recovery' ? 'Firing since' : 'Observed', formatTime(event === 'recovery' ? state.firing_since : delivery.now)),
  ];
  return {
    text: `${title} - ${outcome}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: title.slice(0, 150) } },
      { type: 'section', text: { type: 'mrkdwn', text: `*${escapeSlack(outcome)}*` } },
      { type: 'section', fields },
    ],
    robin_alert: detail,
  };
}

function slackField(label: string, value: string): { type: 'mrkdwn'; text: string } {
  return { type: 'mrkdwn', text: `*${label}*\n${escapeSlack(value)}` };
}

function escapeSlack(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 2000);
}

function formatTime(value: Date | null): string {
  if (!value) return 'n/a';
  return `${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
