/**
 * Telemetry alert rules: an instant query against the telemetry store, a
 * condition (comparator and threshold) and a duration. Each result series (for
 * example each host) is tracked on its own: pending while the condition holds,
 * firing once it has held for the rule's duration, and recovered when it stops
 * holding. Deliveries go to webhooks subscribed to 'telemetry_rule'.
 */
import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { getClient } from '../../db/connection.js';
import { createAlertDelivery, listAlertWebhooks } from '../../db/queries/alerts.js';
import {
  clearDisabledTelemetryAlertStates,
  deleteTelemetryAlertState,
  listEnabledTelemetryAlertRules,
  loadTelemetryAlertStates,
  recordTelemetryAlertRuleEvaluation,
  saveTelemetryAlertState,
  type StateRow,
} from '../../db/queries/telemetry-alert-rules.js';
import { logger } from '../../logger.js';
import type { AlertWebhook, JsonRecord } from '../../types/alerts.js';
import type {
  TelemetryAlertComparator,
  TelemetryAlertPreviewSeries,
  TelemetryAlertRule,
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
export type TelemetryRuleEvent = 'failure' | 'recovery';

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

export interface SeriesTransition {
  next: StateRow | null;
  event: TelemetryRuleEvent | null;
  absent: boolean;
}

/**
 * One series' next state. `observed` is null when the series is missing from
 * this evaluation's result.
 */
export function transitionSeries(input: {
  ruleId: number;
  forSeconds: number;
  previous: StateRow | null;
  observed: { key: string; labels: Record<string, string>; value: number | null; matches: boolean } | null;
  now: Date;
}): SeriesTransition {
  const { previous, observed, now } = input;
  if (!observed) {
    if (!previous) return { next: null, event: null, absent: true };
    if (previous.status === 'pending') return { next: null, event: null, absent: true };
    if (now.getTime() - previous.last_seen_at.getTime() >= ABSENT_RESOLVE_SECONDS * 1000) {
      return { next: null, event: 'recovery', absent: true };
    }
    return { next: previous, event: null, absent: true };
  }
  if (!observed.matches) {
    return { next: null, event: previous?.status === 'firing' ? 'recovery' : null, absent: false };
  }
  const base: StateRow = {
    rule_id: input.ruleId,
    series_key: observed.key,
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
  absent: boolean;
  now: Date;
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
    await clearDisabledTelemetryAlertStates(client);
    const deliveries: PendingDelivery[] = [];
    for (const rule of await listEnabledTelemetryAlertRules(client)) {
      deliveries.push(...await evaluateRule(client, rule, now, runQuery));
    }
    await enqueueDeliveries(client, deliveries);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function evaluateRule(client: PoolClient, rule: TelemetryAlertRule, now: Date, runQuery: QueryInstant): Promise<PendingDelivery[]> {
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
  const deliveries: PendingDelivery[] = [];
  const apply = async (transition: SeriesTransition, previous: StateRow | null, key: string) => {
    if (transition.next) await saveTelemetryAlertState(client, transition.next);
    else if (previous) await deleteTelemetryAlertState(client, rule.id, key);
    if (transition.event) {
      const state = transition.event === 'failure' ? transition.next! : previous!;
      deliveries.push({ rule, event: transition.event, state, absent: transition.absent, now });
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
    });
    await apply(transition, previous, key);
  }
  // A truncated result does not show which series are really gone, so series
  // past the cut keep their state instead of recovering as absent.
  for (const [key, previous] of result.truncated ? [] : previousByKey) {
    await apply(transitionSeries({ ruleId: rule.id, forSeconds: rule.forSeconds, previous, observed: null, now }), previous, key);
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
        dedupeKey: `telemetry-rule:${delivery.rule.id}:${delivery.state.series_key}:${firingSince.getTime()}:${delivery.event}:${webhook.id}`,
        webhookId: webhook.id,
        webhookName: webhook.name,
        fleetServiceId: null,
        serviceId: `telemetry-rule-${delivery.rule.id}`,
        serviceName: `${delivery.rule.name} · ${seriesLabel}`.slice(0, 160),
        serviceType: 'monitoring',
        alertType: 'telemetry_rule',
        eventKind: delivery.event,
        adapter: webhook.adapter,
        payload,
        client,
      });
    }
  }
  logger.info('Telemetry alert rule notifications queued', { count: deliveries.length });
}

export function describeCondition(rule: Pick<TelemetryAlertRule, 'comparator' | 'threshold' | 'forSeconds'>): string {
  const duration = rule.forSeconds === 0
    ? 'immediately'
    : rule.forSeconds % 60 === 0 ? `for ${rule.forSeconds / 60} min` : `for ${rule.forSeconds} s`;
  return `${rule.comparator} ${rule.threshold} ${duration}`;
}

export function buildTelemetryRulePayload(
  adapter: AlertWebhook['adapter'],
  delivery: Pick<PendingDelivery, 'rule' | 'event' | 'state' | 'absent' | 'now'>,
): JsonRecord | null {
  const { rule, event, state } = delivery;
  const seriesLabel = formatSeriesLabels(state.labels_json);
  const value = state.last_value === null ? 'n/a' : String(Number(state.last_value.toFixed(4)));
  const outcome = event === 'recovery'
    ? (delivery.absent ? `${rule.name} recovered: ${seriesLabel} is no longer reported` : `${rule.name} recovered for ${seriesLabel}`)
    : `${rule.name} is firing for ${seriesLabel}`;
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
