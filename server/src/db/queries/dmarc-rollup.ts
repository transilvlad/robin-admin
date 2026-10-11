/**
 * Incremental maintenance of the DMARC reporting rollups.
 *
 * A report's contribution to the rollups is a pure function of its records. On
 * ingest the records are replaced wholesale (DELETE + reinsert, see
 * `insertReport`), so maintenance is applied as a **net delta**: subtract the
 * report's previous contribution, add its new one, in the same transaction as the
 * raw write. That makes a re-POST of an identical report a no-op and a changed
 * re-POST exact — the rollups can never double-count.
 *
 * The delta arithmetic is `computeRollupDelta`, a pure function over record
 * arrays (unit-tested without a database). `applyReportRollupDelta` is the thin
 * SQL layer that writes it.
 *
 * The taxonomy column set, the INSERT list, and the ON CONFLICT accumulation are
 * all derived from TAXONOMY_COLUMNS so they cannot drift from the table DDL or
 * the read path.
 */

import type { PoolClient } from 'pg';
import {
  buildBreakdown,
  breakdownToColumnValues,
  taxonomySql,
  TAXONOMY_COLUMNS,
  TAXONOMY_PROJECTION,
  type RecordAuthInput,
} from '../../services/dmarc-taxonomy.js';
import { getClient } from '../connection.js';
import { logger } from '../../logger.js';
import { ensureMonthlyPartition } from '../schema.js';
import { invalidateReportingCache } from '../../services/reporting-cache.js';

/** The subset of a DMARC record the taxonomy (and thus the rollup) depends on. */
export interface RollupInputRecord extends RecordAuthInput {
  sourceIp: string;
  count: number | string | null | undefined;
}

/**
 * Extra source-rollup columns beyond the taxonomy: raw-auth-pass volume (aligned
 * or not), which the taxonomy columns can't reconstruct but the Sources screen's
 * DKIM/SPF rate needs. The stored/written source vector is
 * `[...TAXONOMY_COLUMNS, ...SOURCE_EXTRA_COLUMNS]`.
 */
export const SOURCE_EXTRA_COLUMNS = ['dkim_pass_volume', 'spf_pass_volume'] as const;
const SOURCE_VALUE_COLUMNS = [...TAXONOMY_COLUMNS, ...SOURCE_EXTRA_COLUMNS];

export interface RollupDelta {
  /** Delta for dmarc_rollup_daily, one number per TAXONOMY_COLUMNS entry. */
  daily: number[];
  /** +1 first ingest, 0 on re-POST — reports attributed to the (day) grain. */
  reportCountDelta: number;
  /**
   * Per source_ip delta for dmarc_rollup_source_daily, one number per
   * SOURCE_VALUE_COLUMNS entry (taxonomy + extras). Zero-deltas omitted.
   */
  sources: Array<{ sourceIp: string; values: number[] }>;
}

const isPass = (value: string | null | undefined): boolean =>
  (value ?? '').trim().toLowerCase() === 'pass';

/** Raw-auth-pass volume [dkim_pass, spf_pass] over a set of records. */
function extraValues(records: RollupInputRecord[]): number[] {
  let dkim = 0;
  let spf = 0;
  for (const record of records) {
    const count = Number(record.count ?? 0);
    if (!Number.isFinite(count) || count <= 0) continue;
    if (isPass(record.dkimResult)) dkim += count;
    if (isPass(record.spfResult)) spf += count;
  }
  return [dkim, spf];
}

/** Full source vector (taxonomy + extras) in SOURCE_VALUE_COLUMNS order. */
function sourceValues(records: RollupInputRecord[]): number[] {
  return [...breakdownToColumnValues(buildBreakdown(records)), ...extraValues(records)];
}

function groupBySource(records: RollupInputRecord[]): Map<string, RollupInputRecord[]> {
  const bySource = new Map<string, RollupInputRecord[]>();
  for (const record of records) {
    const key = record.sourceIp ?? '';
    const bucket = bySource.get(key);
    if (bucket) bucket.push(record);
    else bySource.set(key, [record]);
  }
  return bySource;
}

/** Column values of the taxonomy over a set of records, in TAXONOMY_COLUMNS order. */
function columnValues(records: RollupInputRecord[]): number[] {
  return breakdownToColumnValues(buildBreakdown(records));
}

function subtract(next: number[], prev: number[]): number[] {
  return next.map((value, i) => value - (prev[i] ?? 0));
}

function isAllZero(values: number[]): boolean {
  return values.every((value) => value === 0);
}

/**
 * Net rollup delta for replacing `oldRecords` with `newRecords` for one report.
 * `inserted` is true when the report row was created (not updated) in this txn,
 * which is the only time report_count changes.
 */
export function computeRollupDelta(
  oldRecords: RollupInputRecord[],
  newRecords: RollupInputRecord[],
  inserted: boolean
): RollupDelta {
  const oldBySource = groupBySource(oldRecords);
  const newBySource = groupBySource(newRecords);

  const daily = subtract(columnValues(newRecords), columnValues(oldRecords));

  const sources: RollupDelta['sources'] = [];
  const ips = new Set<string>([...oldBySource.keys(), ...newBySource.keys()]);
  for (const ip of ips) {
    const values = subtract(
      sourceValues(newBySource.get(ip) ?? []),
      sourceValues(oldBySource.get(ip) ?? [])
    );
    if (!isAllZero(values)) sources.push({ sourceIp: ip, values });
  }

  return { daily, reportCountDelta: inserted ? 1 : 0, sources };
}

const N = TAXONOMY_COLUMNS.length;
const COL_LIST = TAXONOMY_COLUMNS.join(', ');

// $5..$(4+N) carry the taxonomy deltas; $1..$4 the daily key; $(5+N) report_count.
const DAILY_UPSERT = `
  INSERT INTO dmarc_rollup_daily (day, domain, org_name, policy, ${COL_LIST}, report_count)
  VALUES ($1, $2, $3, $4, ${TAXONOMY_COLUMNS.map((_, i) => `$${5 + i}`).join(', ')}, $${5 + N})
  ON CONFLICT (day, domain, org_name, policy) DO UPDATE SET
    ${TAXONOMY_COLUMNS.map((c) => `${c} = dmarc_rollup_daily.${c} + EXCLUDED.${c}`).join(',\n    ')},
    report_count = dmarc_rollup_daily.report_count + EXCLUDED.report_count`;

// $4..$(3+M) carry the source deltas (taxonomy + extras); $1..$3 the source key.
const SOURCE_COL_LIST = SOURCE_VALUE_COLUMNS.join(', ');
const SOURCE_UPSERT = `
  INSERT INTO dmarc_rollup_source_daily (day, domain, source_ip, ${SOURCE_COL_LIST})
  VALUES ($1, $2, $3, ${SOURCE_VALUE_COLUMNS.map((_, i) => `$${4 + i}`).join(', ')})
  ON CONFLICT (day, domain, source_ip) DO UPDATE SET
    ${SOURCE_VALUE_COLUMNS.map((c) => `${c} = dmarc_rollup_source_daily.${c} + EXCLUDED.${c}`).join(',\n    ')}`;

interface RollupKey {
  day: string; // 'YYYY-MM-DD'
  domain: string; // lower-cased
  org_name: string; // lower-cased, '' for unknown
  policy: string; // '' for none
}

/**
 * Apply the rollup delta for one report, in the caller's transaction.
 *
 * Reads the canonical daily key (day/domain/org/policy) from the already-written
 * `dmarc_reports` row so the day bucket matches the read path's
 * `DATE_TRUNC('day', date_begin)` exactly, with no Node/DB timezone skew. Must be
 * called AFTER the report row and its new records are written, with `oldRecords`
 * captured BEFORE the old records were deleted.
 */
export async function applyReportRollupDelta(
  client: PoolClient,
  reportDbId: number,
  inserted: boolean,
  oldRecords: RollupInputRecord[],
  newRecords: RollupInputRecord[]
): Promise<void> {
  const delta = computeRollupDelta(oldRecords, newRecords, inserted);

  const keyResult = await client.query<RollupKey>(
    `SELECT DATE_TRUNC('day', date_begin)::date::text AS day,
            LOWER(domain)                 AS domain,
            LOWER(COALESCE(org_name, '')) AS org_name,
            COALESCE(policy, '')          AS policy
     FROM dmarc_reports WHERE id = $1`,
    [reportDbId]
  );
  const key = keyResult.rows[0];
  if (!key) return; // report vanished (shouldn't happen inside the ingest txn)

  const dailyChanged = !isAllZero(delta.daily) || delta.reportCountDelta !== 0;
  if (dailyChanged) {
    await client.query(DAILY_UPSERT, [
      key.day,
      key.domain,
      key.org_name,
      key.policy,
      ...delta.daily,
      delta.reportCountDelta,
    ]);
  }

  if (delta.sources.length > 0) {
    await ensureMonthlyPartition(client, 'dmarc_rollup_source_daily', new Date(`${key.day}T00:00:00Z`));
    for (const source of delta.sources) {
      await client.query(SOURCE_UPSERT, [key.day, key.domain, source.sourceIp, ...source.values]);
    }
    // A re-POST that drops a source leaves its row at zero (total_volume = 0 ⟺
    // fully removed). Delete those so distinct-source counts stay exact and the
    // rollup matches a fresh rebuild.
    await client.query(
      `DELETE FROM dmarc_rollup_source_daily
       WHERE day = $1 AND domain = $2 AND source_ip = ANY($3::text[]) AND total_volume = 0`,
      [key.day, key.domain, delta.sources.map((s) => s.sourceIp)]
    );
  }
}

// ── Backfill / full rebuild ──────────────────────────────────────────────────
// Recompute retained days atomically from complete raw evidence, for
// a manual rebuild (npm run rollups:backfill) after a data fix. The result is
// byte-identical to what incremental maintenance would have produced (asserted in
// dmarc-rollup.integration.test.ts), because both derive from the same taxonomy.

const ZEROS = TAXONOMY_COLUMNS.map(() => '0').join(', ');

// Records → taxonomy per (day, domain, org, policy). report_count filled by the
// reports pass below. OFFSET 0 is the optimisation fence (see taxonomyScan).
const DAILY_BACKFILL_TAXONOMY = `
  INSERT INTO dmarc_rollup_daily (day, domain, org_name, policy, ${COL_LIST}, report_count)
  SELECT DATE_TRUNC('day', tx.date_begin)::date,
         LOWER(tx.domain),
         LOWER(COALESCE(tx.org_name, '')),
         COALESCE(tx.policy, ''),
         ${taxonomySql('tx')},
         0
  FROM (
    SELECT rep.date_begin, rep.domain, rep.org_name, rep.policy, ${TAXONOMY_PROJECTION}
    FROM dmarc_records r JOIN dmarc_reports rep ON rep.id = r.report_id
    WHERE rep.date_begin >= $1 AND rep.date_begin < $2
    OFFSET 0
  ) tx
  GROUP BY 1, 2, 3, 4`;

// Reports → report_count per grain (independent of records, so a record-less
// report is still counted — matching the ingest path's report_count semantics).
const DAILY_BACKFILL_REPORTS = `
  INSERT INTO dmarc_rollup_daily (day, domain, org_name, policy, ${COL_LIST}, report_count)
  SELECT DATE_TRUNC('day', rep.date_begin)::date,
         LOWER(rep.domain),
         LOWER(COALESCE(rep.org_name, '')),
         COALESCE(rep.policy, ''),
         ${ZEROS},
         COUNT(*)
  FROM dmarc_reports rep
  WHERE rep.date_begin >= $1 AND rep.date_begin < $2
  GROUP BY 1, 2, 3, 4
  ON CONFLICT (day, domain, org_name, policy) DO UPDATE SET
    report_count = dmarc_rollup_daily.report_count + EXCLUDED.report_count`;

const SOURCE_BACKFILL = `
  INSERT INTO dmarc_rollup_source_daily (day, domain, source_ip, ${SOURCE_COL_LIST})
  SELECT DATE_TRUNC('day', tx.date_begin)::date,
         LOWER(tx.domain),
         tx.source_ip,
         ${taxonomySql('tx')},
         SUM(CASE WHEN tx.tx_dkim_auth THEN tx.tx_volume ELSE 0 END) AS dkim_pass_volume,
         SUM(CASE WHEN tx.tx_spf_auth  THEN tx.tx_volume ELSE 0 END) AS spf_pass_volume
  FROM (
    SELECT rep.date_begin, rep.domain, r.source_ip, ${TAXONOMY_PROJECTION}
    FROM dmarc_records r JOIN dmarc_reports rep ON rep.id = r.report_id
    WHERE rep.date_begin >= $1 AND rep.date_begin < $2
    OFFSET 0
  ) tx
  GROUP BY 1, 2, 3`;

export interface RollupRebuildResult {
  days: number;
  dailyRows: number;
  sourceRows: number;
  from: string | null;
  to: string | null;
}

/**
 * Replace only days with complete retained raw evidence. Retired days remain
 * untouched. The transaction blocks raw writers and rolls back every day on
 * failure; run this maintenance operation during a quiet ingestion window.
 */
export async function rebuildDmarcRollups(): Promise<RollupRebuildResult> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30min'");
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('robin-admin:dmarc-rebuild')) AS acquired"
    );
    if (!lock.rows[0]?.acquired) throw new Error('A DMARC rollup rebuild is already running');
    // Raw locks precede rollup locks, matching ingestion's write order. These
    // also coordinate with partition retention and direct database writers.
    await client.query('LOCK TABLE dmarc_reports, dmarc_records IN SHARE MODE');
    await client.query('LOCK TABLE dmarc_rollup_daily, dmarc_rollup_source_daily IN SHARE ROW EXCLUSIVE MODE');
    const retained = await client.query<{ day: string }>(
      "SELECT DISTINCT DATE_TRUNC('day', date_begin)::date::text AS day FROM dmarc_reports ORDER BY day"
    );
    const incomplete = await client.query<{ incomplete: boolean }>(`
      WITH raw_counts AS (
        SELECT DATE_TRUNC('day', date_begin)::date AS day, LOWER(domain) AS domain,
               LOWER(COALESCE(org_name, '')) AS org_name, COALESCE(policy, '') AS policy,
               COUNT(*) AS reports
        FROM dmarc_reports GROUP BY 1, 2, 3, 4
      )
      SELECT EXISTS (
        SELECT 1 FROM dmarc_rollup_daily d
        LEFT JOIN raw_counts r USING (day, domain, org_name, policy)
        WHERE d.day IN (SELECT day FROM raw_counts)
          AND d.report_count > COALESCE(r.reports, 0)
      ) OR EXISTS (
        SELECT 1 FROM dmarc_reports rep
        LEFT JOIN (SELECT report_id, report_day, COUNT(*) AS records FROM dmarc_records
                   GROUP BY report_id, report_day) rec
          ON rec.report_id = rep.id AND rec.report_day = rep.date_begin::date
        WHERE CASE WHEN jsonb_typeof(rep.raw_payload->'records') = 'array'
                   THEN jsonb_array_length(rep.raw_payload->'records') <> COALESCE(rec.records, 0)
                   ELSE TRUE END
      ) OR EXISTS (
        SELECT 1 FROM dmarc_records rec LEFT JOIN dmarc_reports rep
          ON rep.id = rec.report_id AND rep.date_begin::date = rec.report_day
        WHERE rep.id IS NULL
      ) AS incomplete
    `);
    if (incomplete.rows[0]?.incomplete) {
      throw new Error('DMARC raw history is incomplete or lacks original record counts; rollups were not changed. Restore complete evidence before rebuilding.');
    }
    for (const { day } of retained.rows) {
      const dayStart = new Date(`${day}T00:00:00Z`);
      const startStr = dayStart.toISOString();
      const endStr = new Date(dayStart.getTime() + 86_400_000).toISOString();
      await ensureMonthlyPartition(client, 'dmarc_rollup_source_daily', dayStart);
      await client.query('DELETE FROM dmarc_rollup_daily WHERE day = $1', [day]);
      await client.query('DELETE FROM dmarc_rollup_source_daily WHERE day = $1', [day]);
      await client.query(DAILY_BACKFILL_TAXONOMY, [startStr, endStr]);
      await client.query(DAILY_BACKFILL_REPORTS, [startStr, endStr]);
      await client.query(SOURCE_BACKFILL, [startStr, endStr]);
    }
    const counts = await client.query<{ daily: string; source: string }>(
      `SELECT (SELECT COUNT(*) FROM dmarc_rollup_daily) AS daily,
              (SELECT COUNT(*) FROM dmarc_rollup_source_daily) AS source`
    );
    const result: RollupRebuildResult = {
      days: retained.rows.length,
      dailyRows: Number(counts.rows[0]?.daily ?? 0),
      sourceRows: Number(counts.rows[0]?.source ?? 0),
      from: retained.rows[0]?.day ?? null,
      to: retained.rows.at(-1)?.day ?? null,
    };
    await client.query('COMMIT');
    invalidateReportingCache();
    logger.info('DMARC retained-day rollups rebuilt', result);
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
