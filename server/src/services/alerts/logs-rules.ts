import type { PoolClient } from 'pg';
import { getClient } from '../../db/connection.js';
import { deleteLogsAlertRule, getLogsAlertRuleById, listAllLogsAlertRules, recordLogsAlertEvaluation } from '../../db/queries/logs.js';
import { createAlertDelivery, listAlertWebhooks } from '../../db/queries/alerts.js';
import { getConfig } from '../../db/queries/config.js';
import { logger } from '../../logger.js';
import { operationsPolicy } from '../operations-settings.js';
import { countLogs, getLogsStoreStatus } from '../logs-store.js';
import type { LogsAlertComparator, LogsAlertRule } from '../../types/logs.js';
import type { AlertType, AlertWebhook, JsonRecord } from '../../types/alerts.js';
import type { LogsStoreStatus } from '../../services/logs-store.js';
import { buildSentryAlertPayload } from './sentry.js';

const EVALUATOR_LOCK_ID = 846_255_034;
const PIPELINE_CONFIRMATIONS = 2;

export function logsAlertMatches(value: number, comparator: LogsAlertComparator, threshold: number): boolean {
  switch (comparator) {
    case '>': return value > threshold;
    case '>=': return value >= threshold;
    case '<': return value < threshold;
    case '<=': return value <= threshold;
    case '==': return value === threshold;
    case '!=': return value !== threshold;
  }
}

export interface LogsAlertTransition {
  status: LogsAlertRule['status'];
  pendingSince: Date | null;
  firingSince: Date | null;
  generation: number;
  event: 'failure' | 'recovery' | null;
}

export function transitionLogsAlert(rule: LogsAlertRule, value: number, now: Date): LogsAlertTransition {
  if (!rule.enabled) {
    return {
      status: 'ok',
      pendingSince: null,
      firingSince: null,
      generation: rule.generation,
      event: rule.status === 'firing' ? 'recovery' : null,
    };
  }
  if (!logsAlertMatches(value, rule.comparator, rule.threshold)) {
    return {
      status: 'ok',
      pendingSince: null,
      firingSince: null,
      generation: rule.generation,
      event: rule.status === 'firing' ? 'recovery' : null,
    };
  }
  if (rule.status === 'firing') {
    return {
      status: 'firing',
      pendingSince: rule.pendingSince ? new Date(rule.pendingSince) : null,
      firingSince: rule.firingSince ? new Date(rule.firingSince) : now,
      generation: rule.generation,
      event: null,
    };
  }
  const pendingSince = rule.status === 'pending' && rule.pendingSince ? new Date(rule.pendingSince) : now;
  if (now.getTime() - pendingSince.getTime() >= rule.forSeconds * 1000) {
    return {
      status: 'firing',
      pendingSince,
      firingSince: pendingSince,
      generation: rule.generation + 1,
      event: 'failure',
    };
  }
  return { status: 'pending', pendingSince, firingSince: null, generation: rule.generation, event: null };
}

export async function previewLogsAlertRule(
  input: Pick<LogsAlertRule, 'query' | 'windowSeconds' | 'comparator' | 'threshold'>,
  at = new Date(),
  runCount: typeof countLogs = countLogs,
): Promise<{ value: number; matches: boolean }> {
  const value = await runCount(input.query, input.windowSeconds, at);
  return { value, matches: logsAlertMatches(value, input.comparator, input.threshold) };
}

interface PendingDelivery {
  rule: LogsAlertRule;
  event: 'failure' | 'recovery';
  value: number;
  generation: number;
  firingSince: Date;
  occurredAt: Date;
}

function isSubscribed(webhook: AlertWebhook, alertType: AlertType, event: PendingDelivery['event'], now: Date): boolean {
  const paused = webhook.pausedAt !== null && (webhook.pausedUntil === null || webhook.pausedUntil > now);
  return webhook.enabled && !paused
    && (event !== 'recovery' || webhook.notifyRecovery)
    && webhook.subscriptions.some((subscription) => subscription.alertType === alertType && subscription.enabled);
}

function escapeSlack(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 1500);
}

function buildLogsRulePayload(webhook: AlertWebhook, delivery: PendingDelivery): JsonRecord | null {
  const { rule, event, value, generation, firingSince, occurredAt } = delivery;
  const condition = `${rule.comparator} ${rule.threshold} logs in ${rule.windowSeconds}s`;
  const summary = event === 'failure'
    ? `${rule.name} matched ${value} logs (${condition})`
    : `${rule.name} recovered; the current count is ${value} logs`;
  if (webhook.adapter === 'sentry') {
    return buildSentryAlertPayload({
      alertKey: `logs-rule:${rule.id}`,
      alertType: 'logs_rule',
      eventKind: event,
      title: `Logs ${event === 'failure' ? 'alert' : 'recovered'}: ${rule.name}`,
      message: summary,
      severity: 'warning',
      tags: { rule: rule.name, generation },
      context: {
        ruleId: rule.id,
        query: rule.query,
        condition,
        count: value,
        windowSeconds: rule.windowSeconds,
        firingSince: firingSince.toISOString(),
      },
      linkPath: '/logs/alerts',
      occurredAt,
    });
  }
  const detail: JsonRecord = {
    version: 1,
    eventKind: event,
    alertType: 'logs_rule',
    summary,
    rule: { id: rule.id, name: rule.name, query: rule.query, comparator: rule.comparator, threshold: rule.threshold, windowSeconds: rule.windowSeconds, forSeconds: rule.forSeconds },
    count: value,
    generation,
    firingSince: firingSince.toISOString(),
    observedAt: occurredAt.toISOString(),
  };
  if (webhook.adapter !== 'slack') return detail;
  const title = `Logs ${event === 'failure' ? 'alert' : 'recovered'}: ${rule.name}`;
  return {
    text: `${title} — ${summary}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: title.slice(0, 150) } },
      { type: 'section', text: { type: 'mrkdwn', text: `*${escapeSlack(summary)}*` } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Query*\n${escapeSlack(rule.query || '*')}` },
        { type: 'mrkdwn', text: `*Condition*\n${escapeSlack(condition)}` },
        { type: 'mrkdwn', text: `*For*\n${rule.forSeconds}s` },
        { type: 'mrkdwn', text: `*Firing since*\n${firingSince.toISOString()}` },
      ] },
    ],
    robin_alert: detail,
  };
}

async function enqueueDeliveries(client: PoolClient, deliveries: PendingDelivery[]): Promise<void> {
  if (deliveries.length === 0 || !operationsPolicy().alertsEnabled) return;
  const webhooks = await listAlertWebhooks();
  for (const delivery of deliveries) {
    for (const webhook of webhooks.filter((item) => isSubscribed(item, 'logs_rule', delivery.event, delivery.occurredAt))) {
      const payload = buildLogsRulePayload(webhook, delivery);
      if (!payload) continue;
      await createAlertDelivery({
        dedupeKey: `logs-rule:${delivery.rule.id}:${delivery.generation}:${delivery.event}:${webhook.id}`,
        webhookId: webhook.id,
        webhookName: webhook.name,
        fleetServiceId: null,
        serviceId: `logs-rule-${delivery.rule.id}`,
        serviceName: delivery.rule.name,
        serviceType: 'monitoring',
        alertType: 'logs_rule',
        eventKind: delivery.event,
        adapter: webhook.adapter,
        payload,
        client,
      });
    }
  }
}

interface PipelineState {
  degraded: boolean;
  failing_checks: number;
  healthy_checks: number;
  generation: string;
  dropped_rows_total: string | null;
  dropped_observed_at: Date | null;
}

function pipelineReasons(status: LogsStoreStatus, now: Date, droppedRowsRecentlyObserved: boolean): string[] {
  const reasons: string[] = [];
  if (!status.reachable) reasons.push(`VictoriaLogs is unreachable${status.error ? `: ${status.error}` : ''}`);
  if (status.write.queuedLines > 0) reasons.push('Logs lines are waiting in the ingestion queue');
  const oldest = status.write.oldestQueuedAt ? Date.parse(status.write.oldestQueuedAt) : NaN;
  if (Number.isFinite(oldest) && now.getTime() - oldest >= 5 * 60 * 1000) reasons.push('The oldest queued batch is at least five minutes old');
  if (status.write.capacityBytes > 0 && status.write.usedBytes / status.write.capacityBytes >= 0.8) reasons.push('The ingestion queue is at least 80% utilized');
  if (status.write.droppedLines24h > 0) reasons.push(`${status.write.droppedLines24h} lines were dropped in the last 24 hours`);
  if (status.write.discardedLines24h > 0) reasons.push(`${status.write.discardedLines24h} lines were explicitly discarded in the last 24 hours`);
  if (status.write.quarantinedBatches > 0 || status.write.rejectedLines24h > 0) reasons.push('One or more batches are rejected or quarantined');
  if (status.write.uncertainBatches > 0 || status.write.uncertainDeliveries24h > 0) reasons.push('One or more writes have uncertain store outcomes');
  if (droppedRowsRecentlyObserved) reasons.push('VictoriaLogs recently reported newly dropped rows');
  return reasons;
}

function logsDataIsIncomplete(status: LogsStoreStatus, droppedRowsRecentlyObserved: boolean): boolean {
  return !status.reachable
    || status.write.queuedLines > 0
    || status.write.quarantinedBatches > 0
    || status.write.uncertainBatches > 0
    || status.write.uncertainDeliveries24h > 0
    || status.write.droppedLines24h > 0
    || status.write.rejectedLines24h > 0
    || status.write.discardedLines24h > 0
    || droppedRowsRecentlyObserved;
}

async function enqueuePipelineHealthDelivery(
  client: PoolClient,
  input: { event: 'failure' | 'recovery'; generation: number; reasons: string[]; occurredAt: Date },
): Promise<void> {
  if (!operationsPolicy().alertsEnabled) return;
  const webhooks = await listAlertWebhooks();
  const summary = input.event === 'failure'
    ? `Logs ingestion pipeline is degraded: ${input.reasons.join('; ')}`
    : 'Logs ingestion pipeline has recovered';
  for (const webhook of webhooks.filter((item) => isSubscribed(item, 'logs_pipeline_health', input.event, input.occurredAt))) {
    const detail: JsonRecord = {
      version: 1,
      eventKind: input.event,
      alertType: 'logs_pipeline_health',
      summary,
      reasons: input.reasons,
      generation: input.generation,
      observedAt: input.occurredAt.toISOString(),
    };
    let payload: JsonRecord = detail;
    if (webhook.adapter === 'sentry') {
      const sentryPayload = buildSentryAlertPayload({
        alertKey: 'logs-pipeline-health',
        alertType: 'logs_pipeline_health',
        eventKind: input.event,
        title: `Logs pipeline ${input.event === 'failure' ? 'degraded' : 'recovered'}`,
        message: summary,
        severity: 'warning',
        tags: { generation: input.generation },
        context: { reasons: input.reasons },
        linkPath: '/logs/health',
        occurredAt: input.occurredAt,
      });
      if (!sentryPayload) continue;
      payload = sentryPayload;
    } else if (webhook.adapter === 'slack') {
      const title = `Logs pipeline ${input.event === 'failure' ? 'degraded' : 'recovered'}`;
      payload = {
        text: `${title} — ${summary}`,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: title } },
          { type: 'section', text: { type: 'mrkdwn', text: `*${escapeSlack(summary)}*` } },
        ],
        robin_alert: detail,
      };
    }
    await createAlertDelivery({
      dedupeKey: `logs-pipeline:${input.generation}:${input.event}:${webhook.id}`,
      webhookId: webhook.id,
      webhookName: webhook.name,
      fleetServiceId: null,
      serviceId: 'logs-pipeline',
      serviceName: 'Logs ingestion pipeline',
      serviceType: 'monitoring',
      alertType: 'logs_pipeline_health',
      eventKind: input.event,
      adapter: webhook.adapter,
      payload,
      client,
    });
  }
}

async function evaluatePipelineHealth(
  client: PoolClient,
  status: LogsStoreStatus,
  now: Date,
): Promise<{ degraded: boolean; reasons: string[]; droppedRowsRecentlyObserved: boolean }> {
  await client.query('BEGIN');
  try {
    const result = await client.query<PipelineState>(
      'SELECT degraded, failing_checks, healthy_checks, generation, dropped_rows_total, dropped_observed_at FROM logs_pipeline_health_state WHERE id = 1 FOR UPDATE',
    );
    const current = result.rows[0] ?? {
      degraded: false, failing_checks: 0, healthy_checks: 0, generation: '0',
      dropped_rows_total: null, dropped_observed_at: null,
    };
    let droppedRowsTotal = current.dropped_rows_total;
    let droppedObservedAt = current.dropped_observed_at;
    const reportedDroppedRows = status.metrics.rowsDroppedTotal;
    if (reportedDroppedRows !== null) {
      const observedCount = Number(reportedDroppedRows);
      const previousCount = droppedRowsTotal === null ? null : Number(droppedRowsTotal);
      if (Number.isFinite(observedCount) && (previousCount === null || observedCount < previousCount)) {
        droppedRowsTotal = String(observedCount);
      } else if (Number.isFinite(observedCount) && previousCount !== null && observedCount > previousCount) {
        droppedRowsTotal = String(observedCount);
        droppedObservedAt = now;
      }
    }
    const lastDropAt = droppedObservedAt instanceof Date ? droppedObservedAt.getTime()
      : droppedObservedAt ? Date.parse(String(droppedObservedAt)) : NaN;
    const droppedRowsRecentlyObserved = Number.isFinite(lastDropAt)
      && now.getTime() - lastDropAt >= 0
      && now.getTime() - lastDropAt < 24 * 60 * 60 * 1000;
    const reasons = pipelineReasons(status, now, droppedRowsRecentlyObserved);
    const failing = reasons.length > 0;
    let degraded = current.degraded;
    let failingChecks = current.failing_checks;
    let healthyChecks = current.healthy_checks;
    let generation = Number(current.generation);
    let event: 'failure' | 'recovery' | null = null;
    if (failing) {
      failingChecks = current.failing_checks + 1;
      healthyChecks = 0;
      if (!current.degraded && failingChecks >= PIPELINE_CONFIRMATIONS) {
        degraded = true;
        generation += 1;
        event = 'failure';
      }
    } else {
      failingChecks = 0;
      if (current.degraded) {
        healthyChecks = current.healthy_checks + 1;
        if (healthyChecks >= PIPELINE_CONFIRMATIONS) {
          degraded = false;
          healthyChecks = 0;
          event = 'recovery';
        }
      } else {
        healthyChecks = 0;
      }
    }
    await client.query(
      `UPDATE logs_pipeline_health_state
          SET degraded = $1, failing_checks = $2, healthy_checks = $3, generation = $4,
              dropped_rows_total = $5, dropped_observed_at = $6, last_reason = $7, updated_at = $8
        WHERE id = 1`,
      [degraded, failingChecks, healthyChecks, generation, droppedRowsTotal, droppedObservedAt,
        failing ? reasons.join('; ').slice(0, 1000) : null, now],
    );
    if (event) {
      await enqueuePipelineHealthDelivery(client, {
        event,
        generation,
        reasons: event === 'failure' ? reasons : [],
        occurredAt: now,
      });
    }
    await client.query('COMMIT');
    return { degraded, reasons, droppedRowsRecentlyObserved };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function runLogsAlertEvaluation(now = new Date(), runCount: typeof countLogs = countLogs): Promise<boolean> {
  if (!(await getConfig()).logsEnabled) return false;
  const client = await getClient();
  let lockAcquired = false;
  try {
    // Keep evaluations single-flight without holding a transaction open during VictoriaLogs queries.
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [EVALUATOR_LOCK_ID],
    );
    if (!lock.rows[0]?.locked) return false;
    lockAcquired = true;

    const pipelineStatus = await getLogsStoreStatus();
    const pipeline = await evaluatePipelineHealth(client, pipelineStatus, now);
    const incomplete = logsDataIsIncomplete(pipelineStatus, pipeline.droppedRowsRecentlyObserved) || pipeline.degraded;
    for (const rule of await listAllLogsAlertRules(client)) {
      let value = rule.lastValue ?? 0;
      let queryError: string | null = null;
      if (rule.enabled && !incomplete) {
        try {
          value = await runCount(rule.query, rule.windowSeconds, now);
        } catch (error) {
          queryError = (error instanceof Error ? error.message : String(error)) || 'Logs alert query failed';
        }
      }

      await client.query('BEGIN');
      try {
        const current = await getLogsAlertRuleById(client, rule.id);
        if (!current || !sameAlertDefinition(rule, current)) {
          await client.query('ROLLBACK');
          continue;
        }
        if (incomplete && current.enabled) {
          await recordLogsAlertEvaluation(client, {
            id: current.id,
            status: current.status,
            value: current.lastValue,
            pendingSince: null,
            firingSince: current.firingSince ? new Date(current.firingSince) : null,
            error: `Logs alert evaluation paused while ingestion data is incomplete${pipeline.reasons.length ? `: ${pipeline.reasons.join('; ')}` : ''}`.slice(0, 500),
            evaluatedAt: now,
          });
          await client.query('COMMIT');
          continue;
        }
        if (queryError !== null) {
          await recordLogsAlertEvaluation(client, {
            id: current.id,
            status: current.status,
            value: current.lastValue,
            pendingSince: null,
            firingSince: current.firingSince ? new Date(current.firingSince) : null,
            error: queryError,
            evaluatedAt: now,
          });
          await client.query('COMMIT');
          continue;
        }

        const transition = transitionLogsAlert(current, value, now);
        if (transition.event) {
          await enqueueDeliveries(client, [{
            rule: current,
            event: transition.event,
            value,
            generation: transition.generation,
            firingSince: transition.firingSince ?? new Date(current.firingSince ?? now),
            occurredAt: now,
          }]);
        }
        await recordLogsAlertEvaluation(client, {
          id: current.id,
          status: transition.status,
          value: current.enabled ? value : current.lastValue,
          pendingSince: transition.pendingSince,
          firingSince: transition.firingSince,
          ...(transition.event === 'failure' ? { generation: transition.generation, notifiedAt: now } : {}),
          error: null,
          evaluatedAt: now,
        });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return true;
  } finally {
    if (lockAcquired) {
      try {
        const unlock = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock($1) AS unlocked',
          [EVALUATOR_LOCK_ID],
        );
        if (!unlock.rows[0]?.unlocked) {
          throw new Error('Logs alert evaluator lock was not held by its database connection');
        }
      } catch (error) {
        client.release(true);
        logger.error('Failed to release Logs alert evaluator lock; database connection was discarded', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    client.release();
  }
}

function sameAlertDefinition(left: LogsAlertRule, right: LogsAlertRule): boolean {
  return left.updatedAt === right.updatedAt
    && left.query === right.query
    && left.windowSeconds === right.windowSeconds
    && left.comparator === right.comparator
    && left.threshold === right.threshold
    && left.forSeconds === right.forSeconds
    && left.enabled === right.enabled;
}

export async function deleteLogsAlertRuleWithRecovery(id: number): Promise<boolean> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [EVALUATOR_LOCK_ID]);
    const rule = await getLogsAlertRuleById(client, id);
    if (!rule) {
      await client.query('ROLLBACK');
      return false;
    }
    if (rule.status === 'firing') {
      await enqueueDeliveries(client, [{
        rule,
        event: 'recovery',
        value: rule.lastValue ?? 0,
        generation: rule.generation,
        firingSince: rule.firingSince ? new Date(rule.firingSince) : new Date(),
        occurredAt: new Date(),
      }]);
    }
    await deleteLogsAlertRule(client, id);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
