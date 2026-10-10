import { describe, expect, it, vi } from 'vitest';
import type { StateRow } from '../../db/queries/telemetry-alert-rules.js';
import type { TelemetryAlertRule } from '../../types/telemetry-alerts.js';
import {
  ABSENT_RESOLVE_SECONDS,
  buildTelemetryRulePayload,
  compareValue,
  describeCondition,
  formatSeriesLabels,
  previewTelemetryAlertRule,
  seriesKey,
  transitionSeries,
} from './telemetry-rules.js';

vi.mock('../../db/connection.js', () => ({ getClient: vi.fn(), query: vi.fn() }));

const t0 = new Date('2026-10-08T12:00:00Z');
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);
const labels = { host: 'obm-cobalt', role: 'obm' };
const key = seriesKey(labels);

function observe(value: number | null, matches: boolean) {
  return { key, labels, value, matches };
}

function state(overrides: Partial<StateRow> = {}): StateRow {
  return {
    rule_id: 1,
    series_key: key,
    labels_json: labels,
    status: 'pending',
    pending_since: t0,
    firing_since: null,
    last_value: 0,
    last_seen_at: t0,
    ...overrides,
  };
}

const rule: TelemetryAlertRule = {
  id: 1,
  name: 'SMTP egress down',
  description: null,
  query: 'min by (host) (smtp_egress_ok)',
  comparator: '<',
  threshold: 1,
  forSeconds: 300,
  severity: 'critical',
  enabled: true,
  lastEvaluatedAt: null,
  lastError: null,
  createdAt: t0.toISOString(),
  updatedAt: t0.toISOString(),
};

describe('compareValue', () => {
  it('applies each comparator and never matches a missing value', () => {
    expect(compareValue(0, '<', 1)).toBe(true);
    expect(compareValue(1, '<', 1)).toBe(false);
    expect(compareValue(1, '<=', 1)).toBe(true);
    expect(compareValue(2, '>', 1)).toBe(true);
    expect(compareValue(1, '>=', 1)).toBe(true);
    expect(compareValue(1, '==', 1)).toBe(true);
    expect(compareValue(0, '!=', 1)).toBe(true);
    expect(compareValue(null, '<', 1)).toBe(false);
    expect(compareValue(Number.NaN, '!=', 1)).toBe(false);
  });
});

describe('seriesKey', () => {
  it('does not depend on label order', () => {
    expect(seriesKey({ role: 'obm', host: 'obm-cobalt' })).toBe(key);
    expect(seriesKey({ host: 'obm-hydrogen', role: 'obm' })).not.toBe(key);
  });

  it('formats labels without the metric name', () => {
    expect(formatSeriesLabels({ __name__: 'up', role: 'obm', host: 'a' })).toBe('host=a, role=obm');
    expect(formatSeriesLabels({})).toBe('all series');
  });
});

describe('transitionSeries', () => {
  const base = { ruleId: 1, forSeconds: 300 };

  it('waits for the duration before firing, then fires once', () => {
    const pending = transitionSeries({ ...base, previous: null, observed: observe(0, true), now: t0 });
    expect(pending.next?.status).toBe('pending');
    expect(pending.event).toBeNull();

    const stillPending = transitionSeries({ ...base, previous: pending.next, observed: observe(0, true), now: at(299) });
    expect(stillPending.next?.status).toBe('pending');
    expect(stillPending.event).toBeNull();

    const firing = transitionSeries({ ...base, previous: stillPending.next, observed: observe(0, true), now: at(300) });
    expect(firing.next).toMatchObject({ status: 'firing', firing_since: at(300) });
    expect(firing.event).toBe('failure');

    const again = transitionSeries({ ...base, previous: firing.next, observed: observe(0, true), now: at(330) });
    expect(again.event).toBeNull();
    expect(again.next?.status).toBe('firing');
  });

  it('fires immediately with a zero duration', () => {
    const result = transitionSeries({ ruleId: 1, forSeconds: 0, previous: null, observed: observe(0, true), now: t0 });
    expect(result.event).toBe('failure');
    expect(result.next?.status).toBe('firing');
  });

  it('drops a pending series quietly and recovers a firing one', () => {
    expect(transitionSeries({ ...base, previous: state(), observed: observe(1, false), now: at(60) })).toEqual({ next: null, event: null, absent: false });
    const recovered = transitionSeries({ ...base, previous: state({ status: 'firing', firing_since: t0 }), observed: observe(1, false), now: at(60) });
    expect(recovered).toEqual({ next: null, event: 'recovery', absent: false });
  });

  it('keeps a firing series that briefly goes missing, and recovers it once it has been gone long enough', () => {
    const firing = state({ status: 'firing', firing_since: t0, last_seen_at: t0 });
    const missing = transitionSeries({ ...base, previous: firing, observed: null, now: at(ABSENT_RESOLVE_SECONDS - 1) });
    expect(missing).toEqual({ next: firing, event: null, absent: true });
    const gone = transitionSeries({ ...base, previous: firing, observed: null, now: at(ABSENT_RESOLVE_SECONDS) });
    expect(gone).toEqual({ next: null, event: 'recovery', absent: true });
  });

  it('drops a missing pending series without an event', () => {
    expect(transitionSeries({ ...base, previous: state(), observed: null, now: at(30) })).toEqual({ next: null, event: null, absent: true });
  });
});

describe('previewTelemetryAlertRule', () => {
  it('marks which series match the condition', async () => {
    const runQuery = vi.fn().mockResolvedValue({
      series: [{ labels: { host: 'a' }, value: 0 }, { labels: { host: 'b' }, value: 1 }],
      truncated: false,
    });
    const preview = await previewTelemetryAlertRule({ query: 'min by (host) (smtp_egress_ok)', comparator: '<', threshold: 1 }, runQuery);
    expect(preview.series.map((series) => series.matches)).toEqual([true, false]);
    expect(runQuery).toHaveBeenCalledWith({ query: 'min by (host) (smtp_egress_ok)', maxSeries: 500 });
  });
});

describe('buildTelemetryRulePayload', () => {
  it('builds a Slack message naming the rule, series, value and condition', () => {
    const payload = buildTelemetryRulePayload('slack', {
      rule,
      event: 'failure',
      state: state({ status: 'firing', firing_since: at(300), last_value: 0 }),
      absent: false,
      now: at(300),
    }) as { text: string; blocks: Array<{ fields?: Array<{ text: string }> }>; robin_alert: Record<string, unknown> };
    expect(payload.text).toBe('Telemetry critical: SMTP egress down - SMTP egress down is firing for host=obm-cobalt, role=obm');
    expect(payload.blocks[2].fields?.map((field) => field.text)).toEqual([
      '*Series*\nhost=obm-cobalt, role=obm',
      '*Value*\n0',
      '*Condition*\n&lt; 1 for 5 min',
      '*Observed*\n2026-10-08 12:05 UTC',
    ]);
    expect(payload.robin_alert).toMatchObject({ alertType: 'telemetry_rule', eventKind: 'failure' });
  });

  it('says when a series recovered by no longer being reported', () => {
    const payload = buildTelemetryRulePayload('generic', {
      rule,
      event: 'recovery',
      state: state({ status: 'firing', firing_since: t0 }),
      absent: true,
      now: at(900),
    });
    expect(payload.summary).toBe('SMTP egress down recovered: host=obm-cobalt, role=obm is no longer reported');
  });

  it('describes durations', () => {
    expect(describeCondition({ comparator: '>', threshold: 300, forSeconds: 0 })).toBe('> 300 immediately');
    expect(describeCondition({ comparator: '<', threshold: 1, forSeconds: 90 })).toBe('< 1 for 90 s');
  });
});
