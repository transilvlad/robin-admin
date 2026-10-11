/**
 * DMARC database queries.
 */

import { query, getClient } from '../connection.js';
import { scheduleReportingCacheInvalidation, memo, cacheKey } from '../../services/reporting-cache.js';
import { applyReportRollupDelta, type RollupInputRecord } from './dmarc-rollup.js';
import { ensureMonthlyPartition } from '../schema.js';

export interface DmarcReporter {
  id: number;
  name: string;
  displayName: string;
  reportCount: number;
}

export interface DmarcReport {
  id: number;
  reportId: string;
  reporterId: number;
  reporterName?: string;
  orgName: string;
  email: string;
  domain: string;
  dateBegin: Date;
  dateEnd: Date;
  policy: string;
  subdomainPolicy: string;
  dkimAlignment: string;
  spfAlignment: string;
  pct: number;
  totalCount: number;
  errorCount: number;
  createdAt: Date;
}

export interface DmarcRecord {
  id: number;
  reportId: number;
  sourceIp: string;
  count: number;
  disposition: string;
  dkim: string;
  spf: string;
  reasonType: string;
  reasonComment: string;
  headerFrom: string;
  envelopeFrom: string;
  envelopeTo: string;
  dkimDomain: string;
  dkimResult: string;
  dkimSelector: string;
  spfDomain: string;
  spfResult: string;
  spfScope: string;
  recordType: number;
}

export interface DmarcReportInput {
  reportId: string;
  orgName: string;
  email: string;
  domain: string;
  dateBegin: number;
  dateEnd: number;
  policy: string;
  subdomainPolicy: string;
  dkimAlignment: string;
  spfAlignment: string;
  pct: string;
  totalCount: number;
  errorCount: number;
  records: DmarcRecordInput[];
}

export interface DmarcRecordInput {
  sourceIp: string;
  count: number;
  disposition: string;
  dkim: string;
  spf: string;
  reasonType?: string;
  reasonComment?: string;
  headerFrom?: string;
  envelopeFrom?: string;
  envelopeTo?: string;
  dkimDomain?: string;
  dkimResult?: string;
  dkimSelector?: string;
  spfDomain?: string;
  spfResult?: string;
  spfScope?: string;
}

/**
 * Get or create a reporter.
 */
export async function getOrCreateReporter(name: string): Promise<number> {
  // Try to find existing.
  const existing = await query<{ id: number }>(
    'SELECT id FROM dmarc_reporters WHERE name = $1',
    [name]
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  // Create new.
  const result = await query<{ id: number }>(
    'INSERT INTO dmarc_reporters (name, display_name) VALUES ($1, $2) RETURNING id',
    [name, name]
  );
  return result.rows[0].id;
}

/**
 * Insert a DMARC report with records.
 */
export async function insertReport(report: DmarcReportInput): Promise<number> {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    // Get or create reporter.
    const reporterName = report.orgName || 'unknown';
    const reporterResult = await client.query<{ id: number }>(
      `INSERT INTO dmarc_reporters (name, display_name) 
       VALUES ($1, $2) 
       ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
      [reporterName, reporterName]
    );
    const reporterId = reporterResult.rows[0].id;

    // The report's start as Postgres stores it decides both partitions (the
    // report's month and its records' report_day), so derive it once there.
    const startResult = await client.query<{ report_day: string }>(
      'SELECT to_timestamp($1)::timestamp::date::text AS report_day',
      [report.dateBegin]
    );
    const reportDay = startResult.rows[0].report_day;
    const month = new Date(`${reportDay}T00:00:00Z`);
    await ensureMonthlyPartition(client, 'dmarc_reports', month);
    await ensureMonthlyPartition(client, 'dmarc_records', month);

    // Insert report. A retry of the same report has the same start, so it
    // lands on the same row. `inserted` compares created_at with this
    // transaction's start (its default): partitioned tables can't return xmax
    // from an upsert, and a retry updates a row an earlier transaction made.
    const reportResult = await client.query<{ id: number; inserted: boolean }>(
      `INSERT INTO dmarc_reports (
        report_id, reporter_id, org_name, email, domain,
        date_begin, date_end, policy, subdomain_policy,
        dkim_alignment, spf_alignment, pct, total_count, error_count, raw_payload
      ) VALUES ($1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7), $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
      ON CONFLICT (report_id, reporter_id, date_begin) DO UPDATE SET
        total_count = EXCLUDED.total_count,
        error_count = EXCLUDED.error_count,
        raw_payload = EXCLUDED.raw_payload
      RETURNING id, (created_at = LOCALTIMESTAMP) AS inserted`,
      [
        report.reportId,
        reporterId,
        report.orgName || '',
        report.email || '',
        report.domain,
        report.dateBegin,
        report.dateEnd,
        report.policy || '',
        report.subdomainPolicy || '',
        report.dkimAlignment || '',
        report.spfAlignment || '',
        parseInt(report.pct || '100', 10),
        report.totalCount,
        report.errorCount,
        JSON.stringify(report),
      ]
    );
    const reportDbId = reportResult.rows[0].id;
    const inserted = reportResult.rows[0].inserted ?? false;

    // Capture this report's existing rollup contribution BEFORE deleting its
    // records, so maintenance can subtract it and add the new contribution as a
    // net delta (see dmarc-rollup.ts). On a first ingest this is empty.
    const oldRecordsResult = await client.query<{
      source_ip: string;
      count: number;
      dkim: string | null;
      spf: string | null;
      dkim_result: string | null;
      spf_result: string | null;
      reason_type: string | null;
    }>(
      `SELECT source_ip, count, dkim, spf, dkim_result, spf_result, reason_type
       FROM dmarc_records WHERE report_day = $2 AND report_id = $1`,
      [reportDbId, reportDay]
    );
    const oldRollupRecords: RollupInputRecord[] = oldRecordsResult.rows.map((r) => ({
      sourceIp: r.source_ip,
      count: r.count,
      dkim: r.dkim,
      spf: r.spf,
      dkimResult: r.dkim_result,
      spfResult: r.spf_result,
      reasonType: r.reason_type,
    }));

    // Replace records on every ingest. The dmarc_reports row is
    // deduped via ON CONFLICT (report_id, reporter_id, date_begin) above, but
    // dmarc_records has no natural unique key — re-POSTing the same
    // report would otherwise append duplicates. Wiping and reinserting
    // is cheap (a handful of records per report) and keeps the data
    // idempotent against retries.
    await client.query('DELETE FROM dmarc_records WHERE report_day = $2 AND report_id = $1', [reportDbId, reportDay]);

    // Insert records. record_type is derived at read time by joining
    // sender_inventory.classification (see getReportDetail).
    for (const record of report.records) {
      await client.query(
        `INSERT INTO dmarc_records (
          report_id, source_ip, count, disposition, dkim, spf,
          reason_type, reason_comment, header_from, envelope_from, envelope_to,
          dkim_domain, dkim_result, dkim_selector, spf_domain, spf_result, spf_scope,
          report_day
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          reportDbId,
          record.sourceIp,
          record.count,
          record.disposition || '',
          record.dkim || '',
          record.spf || '',
          record.reasonType || '',
          record.reasonComment || '',
          record.headerFrom || '',
          record.envelopeFrom || '',
          record.envelopeTo || '',
          record.dkimDomain || '',
          record.dkimResult || '',
          record.dkimSelector || '',
          record.spfDomain || '',
          record.spfResult || '',
          record.spfScope || '',
          reportDay,
        ]
      );
    }

    // Maintain the reporting rollups in the same transaction as the raw write, so
    // raw and rollup can never disagree and a rollback undoes both. Net delta of
    // (new records − old records); a re-POST of an identical report is a no-op.
    const newRollupRecords: RollupInputRecord[] = report.records.map((rec) => ({
      sourceIp: rec.sourceIp,
      count: rec.count,
      dkim: rec.dkim,
      spf: rec.spf,
      dkimResult: rec.dkimResult,
      spfResult: rec.spfResult,
      reasonType: rec.reasonType,
    }));
    await applyReportRollupDelta(client, reportDbId, inserted, oldRollupRecords, newRollupRecords);

    await client.query('COMMIT');
    // Reporting aggregates are memoised on the assumption that report data is
    // immutable once stored. This is the one place that assumption changes.
    // Debounced (see reporting-cache.ts): reports arrive continuously enough
    // that invalidating immediately on every single one defeats the cache.
    scheduleReportingCacheInvalidation();
    return reportDbId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * DMARC record buckets (must match RECORD_TYPE_LABELS on the client):
 *   0: Own servers          — FCrDNS-verified own IP
 *   1: Known external       — authorized third-party sender
 *   2: DKIM forwarder       — DKIM-only pass across a relay
 *   3: Suspicious forwarder — no auth, receiver treated as benign
 *   4: Unknown              — everything else (potential spoofing)
 *
 * `record_type` is NOT stored on dmarc_records. It's derived at read time by
 * joining sender_inventory.classification in getReportDetail, so the label
 * always reflects the latest FCrDNS+SPF+PSL classification without any
 * write-amplifying UPDATE across a domain's records.
 */
const CLASSIFICATION_TO_RECORD_TYPE_SQL = `
  CASE si.classification
    WHEN 'own_server'           THEN 0
    WHEN 'authorized'           THEN 1
    WHEN 'trusted'              THEN 1
    WHEN 'forwarder'            THEN 2
    WHEN 'suspicious_forwarder' THEN 3
    WHEN 'misconfigured'        THEN 3
    WHEN 'suspicious'           THEN 3
    WHEN 'unknown'              THEN 4
    WHEN 'spoofing'             THEN 4
    ELSE 4
  END`;

/**
 * List reports with pagination.
 */
export async function listReports(
  page = 1,
  limit = 50,
  filters?: {
    domain?: string;
    reporterId?: number;
    startDate?: string;
    endDate?: string;
    sortBy?: 'date' | 'reporter' | 'domain' | 'total' | 'errors' | 'policy';
    sortOrder?: 'asc' | 'desc';
  }
): Promise<{ reports: DmarcReport[]; total: number }> {
  let whereClause = '';
  const params: (string | number)[] = [];
  let paramIdx = 1;

  if (filters?.domain) {
    whereClause += ` AND r.domain ILIKE $${paramIdx}`;
    params.push(`%${filters.domain}%`);
    paramIdx++;
  }
  if (filters?.reporterId) {
    whereClause += ` AND r.reporter_id = $${paramIdx}`;
    params.push(filters.reporterId);
    paramIdx++;
  }
  if (filters?.startDate) {
    whereClause += ` AND r.date_begin >= $${paramIdx}`;
    params.push(filters.startDate);
    paramIdx++;
  }
  if (filters?.endDate) {
    whereClause += ` AND r.date_end <= $${paramIdx}`;
    params.push(filters.endDate);
    paramIdx++;
  }

  const offset = (page - 1) * limit;
  const sortColumns: Record<string, string> = {
    date: 'r.date_begin',
    reporter: 'rp.display_name',
    domain: 'r.domain',
    total: 'r.total_count',
    errors: 'r.error_count',
    policy: 'r.policy',
  };
  const sortColumn = sortColumns[filters?.sortBy ?? 'date'] ?? sortColumns.date;
  const sortOrder = filters?.sortOrder === 'asc' ? 'ASC' : 'DESC';

  // Count and page fetched together — both scan the same filtered set, so
  // waiting for the count before starting the page fetch is round-trip padding.
  const [countResult, result] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM dmarc_reports r WHERE 1=1 ${whereClause}`,
      params
    ),
    query<{
      id: number;
      report_id: string;
      reporter_id: number;
      reporter_name: string;
      org_name: string;
      email: string;
      domain: string;
      date_begin: Date;
      date_end: Date;
      policy: string;
      subdomain_policy: string;
      dkim_alignment: string;
      spf_alignment: string;
      pct: number;
      total_count: number;
      error_count: number;
      created_at: Date;
    }>(
      `SELECT r.*, rp.display_name as reporter_name
       FROM dmarc_reports r
       LEFT JOIN dmarc_reporters rp ON r.reporter_id = rp.id
       WHERE 1=1 ${whereClause}
       ORDER BY ${sortColumn} ${sortOrder} NULLS LAST, r.id DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    ),
  ]);
  const total = parseInt(countResult.rows[0].count, 10);

  const reports = result.rows.map((row) => ({
    id: row.id,
    reportId: row.report_id,
    reporterId: row.reporter_id,
    reporterName: row.reporter_name,
    orgName: row.org_name,
    email: row.email,
    domain: row.domain,
    dateBegin: row.date_begin,
    dateEnd: row.date_end,
    policy: row.policy,
    subdomainPolicy: row.subdomain_policy,
    dkimAlignment: row.dkim_alignment,
    spfAlignment: row.spf_alignment,
    pct: row.pct,
    totalCount: row.total_count,
    errorCount: row.error_count,
    createdAt: row.created_at,
  }));

  return { reports, total };
}

/**
 * Get report detail with records.
 */
export async function getReportDetail(reportId: number): Promise<{
  report: DmarcReport | null;
  records: DmarcRecord[];
  summary: { type: number; count: number; msgCount: number }[];
}> {
  // Get report.
  const reportResult = await query<{
    id: number;
    report_id: string;
    reporter_id: number;
    reporter_name: string;
    org_name: string;
    email: string;
    domain: string;
    date_begin: Date;
    date_end: Date;
    policy: string;
    subdomain_policy: string;
    dkim_alignment: string;
    spf_alignment: string;
    pct: number;
    total_count: number;
    error_count: number;
    created_at: Date;
  }>(
    `SELECT r.*, rp.display_name as reporter_name
     FROM dmarc_reports r
     LEFT JOIN dmarc_reporters rp ON r.reporter_id = rp.id
     WHERE r.id = $1`,
    [reportId]
  );

  if (reportResult.rows.length === 0) {
    return { report: null, records: [], summary: [] };
  }

  const row = reportResult.rows[0];
  const report: DmarcReport = {
    id: row.id,
    reportId: row.report_id,
    reporterId: row.reporter_id,
    reporterName: row.reporter_name,
    orgName: row.org_name,
    email: row.email,
    domain: row.domain,
    dateBegin: row.date_begin,
    dateEnd: row.date_end,
    policy: row.policy,
    subdomainPolicy: row.subdomain_policy,
    dkimAlignment: row.dkim_alignment,
    spfAlignment: row.spf_alignment,
    pct: row.pct,
    totalCount: row.total_count,
    errorCount: row.error_count,
    createdAt: row.created_at,
  };

  // Records + per-bucket summary in one round trip. Both derive record_type at
  // read time by joining sender_inventory.classification — no denormalised
  // column, no rewrite pass.
  const [recordsResult, summaryResult] = await Promise.all([
    query<{
      id: number;
      report_id: number;
      source_ip: string;
      count: number;
      disposition: string;
      dkim: string;
      spf: string;
      reason_type: string;
      reason_comment: string;
      header_from: string;
      envelope_from: string;
      envelope_to: string;
      dkim_domain: string;
      dkim_result: string;
      dkim_selector: string;
      spf_domain: string;
      spf_result: string;
      spf_scope: string;
      record_type: number;
    }>(
      `SELECT r.*, ${CLASSIFICATION_TO_RECORD_TYPE_SQL} AS record_type
       FROM dmarc_records r
       LEFT JOIN sender_inventory si ON si.source_ip = r.source_ip AND si.domain = $2
       WHERE r.report_id = $1
       ORDER BY r.count DESC`,
      [reportId, report.domain]
    ),
    query<{ record_type: number; count: string; msg_count: string }>(
      `SELECT ${CLASSIFICATION_TO_RECORD_TYPE_SQL} AS record_type,
              COUNT(*) AS count,
              SUM(r.count) AS msg_count
       FROM dmarc_records r
       LEFT JOIN sender_inventory si ON si.source_ip = r.source_ip AND si.domain = $2
       WHERE r.report_id = $1
       GROUP BY ${CLASSIFICATION_TO_RECORD_TYPE_SQL}
       ORDER BY 1`,
      [reportId, report.domain]
    ),
  ]);

  const records = recordsResult.rows.map((r) => ({
    id: r.id,
    reportId: r.report_id,
    sourceIp: r.source_ip,
    count: r.count,
    disposition: r.disposition,
    dkim: r.dkim,
    spf: r.spf,
    reasonType: r.reason_type,
    reasonComment: r.reason_comment,
    headerFrom: r.header_from,
    envelopeFrom: r.envelope_from,
    envelopeTo: r.envelope_to,
    dkimDomain: r.dkim_domain,
    dkimResult: r.dkim_result,
    dkimSelector: r.dkim_selector,
    spfDomain: r.spf_domain,
    spfResult: r.spf_result,
    spfScope: r.spf_scope,
    recordType: r.record_type,
  }));

  const summary = summaryResult.rows.map((s) => ({
    type: s.record_type,
    count: parseInt(s.count, 10),
    msgCount: parseInt(s.msg_count, 10),
  }));

  return { report, records, summary };
}

/**
 * Daily DMARC trend for the dashboard chart, from the reporting taxonomy.
 *
 * The four series here are the DMARC-standard classes plus `benignRelay` so
 * operators can see forwarding excluded from failures.
 *
 * `values` is [compliant, authenticatedUnaligned, benignRelay, actionableFailure]
 * per day.
 */
export async function getChartData(
  startDate: string,
  endDate: string,
  domain?: string
): Promise<{ date: string; values: number[] }[]> {
  return memo(cacheKey('dmarcChart', startDate, endDate, domain), async () => {
    const conds = ['d.day >= $1::date', 'd.day <= $2::date'];
    const params: string[] = [startDate.slice(0, 10), endDate.slice(0, 10)];
    if (domain) {
      params.push(domain.toLowerCase());
      conds.push(`d.domain = $${params.length}`);
    }

    const result = await query<{
      day: string;
      compliant: string;
      auth_unaligned: string;
      benign: string;
      actionable: string;
    }>(
      `SELECT d.day::text AS day,
              SUM(d.compliant_volume)::bigint               AS compliant,
              SUM(d.authenticated_unaligned_volume)::bigint AS auth_unaligned,
              SUM(d.benign_relay_volume)::bigint            AS benign,
              SUM(d.actionable_failure_volume)::bigint      AS actionable
       FROM dmarc_rollup_daily d
       WHERE ${conds.join(' AND ')}
       GROUP BY d.day
       ORDER BY d.day`,
      params
    );

    return result.rows.map((row) => ({
      date: row.day,
      values: [
        parseInt(row.compliant, 10),
        parseInt(row.auth_unaligned, 10),
        parseInt(row.benign, 10),
        parseInt(row.actionable, 10),
      ],
    }));
  });
}

/**
 * Get reporters list.
 */
export async function listReporters(): Promise<DmarcReporter[]> {
  const result = await query<{ id: number; name: string; display_name: string; report_count: string }>(
    `SELECT
       rp.id,
       rp.name,
       rp.display_name,
       COUNT(r.id) AS report_count
     FROM dmarc_reporters rp
     LEFT JOIN dmarc_reports r ON r.reporter_id = rp.id
     GROUP BY rp.id, rp.name, rp.display_name
     ORDER BY COUNT(r.id) DESC, rp.display_name ASC`
  );
  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    displayName: r.display_name,
    reportCount: parseInt(r.report_count, 10) || 0,
  }));
}

/**
 * Get DMARC stats for dashboard.
 */
export async function getDmarcStats(): Promise<{
  totalReports: number;
  totalMessages: number;
  errorMessages: number;
  recentReports: number;
  last30Days: number;
}> {
  return memo(cacheKey('dmarcStats'), async () => {
    const result = await query<{
      total_reports: string;
      total_messages: string;
      error_messages: string;
      recent_reports: string;
      last_30_days: string;
    }>(`
      SELECT
        COUNT(*) as total_reports,
        COALESCE(SUM(total_count), 0) as total_messages,
        COALESCE(SUM(error_count), 0) as error_messages,
        COUNT(*) FILTER (WHERE date_begin >= NOW() - INTERVAL '7 days') as recent_reports,
        COUNT(*) FILTER (WHERE date_begin >= NOW() - INTERVAL '30 days') as last_30_days
      FROM dmarc_reports
    `);

    const row = result.rows[0];
    return {
      totalReports: parseInt(row.total_reports, 10),
      totalMessages: parseInt(row.total_messages, 10),
      errorMessages: parseInt(row.error_messages, 10),
      recentReports: parseInt(row.recent_reports, 10),
      last30Days: parseInt(row.last_30_days, 10),
    };
  });
}
