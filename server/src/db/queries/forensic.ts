/**
 * Forensic (AFRF - RFC 6591) report database queries.
 */

import { query } from '../connection.js';
import { createHash } from 'node:crypto';
import { normalizeForensicReport } from '../../services/forensic-parser.js';
import { scheduleReportingCacheInvalidation, memo, cacheKey } from '../../services/reporting-cache.js';

/**
 * Input structure for forensic report from Robin bot.
 */
export interface ForensicReportInput {
  feedbackType: string;
  userAgent?: string;
  version?: string;
  originalMailFrom?: string;
  originalRcptTo?: string;
  receivedDate?: string;
  sourceIp?: string;
  reportedDomain?: string;
  authFailure?: string;
  authenticationResults?: string;
  deliveryResult?: string;
  incidents?: number;
  reportedUri?: string[];
  originalEnvelopeId?: string;
  dkimDomain?: string;
  dkimSelector?: string;
  dkimIdentity?: string;
  spfDns?: string;
  subject?: string;
  arrivalDate?: string;
  originalHeaders?: string;
}

/**
 * Database row type.
 */
interface ForensicReportRow {
  id: number;
  feedback_type: string;
  user_agent: string | null;
  version: string | null;
  original_mail_from: string | null;
  original_rcpt_to: string | null;
  received_date: Date | null;
  source_ip: string | null;
  reported_domain: string | null;
  auth_failure: string | null;
  authentication_results: string | null;
  delivery_result: string | null;
  incidents: number;
  reported_uri: string[] | null;
  original_envelope_id: string | null;
  dkim_domain: string | null;
  dkim_selector: string | null;
  dkim_identity: string | null;
  spf_dns: string | null;
  subject: string | null;
  arrival_date: Date | null;
  original_headers: string | null;
  created_at: Date;
}

/**
 * Insert a forensic report.
 */
export async function insertReport(input: ForensicReportInput): Promise<number> {
  const normalized = normalizeForensicReport(input);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({
      feedbackType: input.feedbackType,
      receivedDate: input.receivedDate ?? null,
      arrivalDate: input.arrivalDate ?? null,
      sourceIp: normalized.sourceIp,
      domain: normalized.domain,
      subject: normalized.subject,
      originalHeaders: input.originalHeaders ?? null,
      authenticationResults: input.authenticationResults ?? null,
    }))
    .digest('hex');

  const existing = await query<{ id: number }>(
    `SELECT id FROM forensic_reports WHERE message_fingerprint = $1 LIMIT 1`,
    [fingerprint]
  );
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  const result = await query<{ id: number }>(
    `INSERT INTO forensic_reports 
     (feedback_type, user_agent, version, original_mail_from, original_rcpt_to,
       received_date, source_ip, reported_domain, auth_failure, authentication_results,
       delivery_result, incidents, reported_uri, original_envelope_id, dkim_domain,
       dkim_selector, dkim_identity, spf_dns, subject, arrival_date, original_headers,
       message_fingerprint, raw_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23::jsonb)
     RETURNING id`,
    [
      input.feedbackType,
      input.userAgent || null,
      input.version || null,
      input.originalMailFrom || null,
      input.originalRcptTo || null,
      input.receivedDate ? new Date(input.receivedDate) : null,
      normalized.sourceIp,
      normalized.domain,
      input.authFailure || null,
      input.authenticationResults || null,
      input.deliveryResult || null,
      input.incidents || 1,
      input.reportedUri || null,
      input.originalEnvelopeId || null,
      input.dkimDomain || null,
      input.dkimSelector || null,
      input.dkimIdentity || null,
      input.spfDns || null,
      normalized.subject,
      input.arrivalDate ? new Date(input.arrivalDate) : null,
      input.originalHeaders || null,
      fingerprint,
      JSON.stringify(input),
    ]
  );

  // See dmarc.ts: reporting aggregates are memoised on the assumption that
  // report data is immutable once stored, so any new report has to bust that.
  // Debounced because a burst of ingests would otherwise defeat the cache.
  scheduleReportingCacheInvalidation();
  return result.rows[0].id;
}

/**
 * List forensic reports with pagination.
 */
export async function listReports(
  page: number,
  limit: number,
  filters: {
    domain?: string;
    feedbackType?: string;
    authFailure?: string;
    sourceIp?: string;
    startDate?: string;
    endDate?: string;
    sortBy?: 'date' | 'type' | 'domain' | 'sourceIp' | 'incidents';
    sortOrder?: 'asc' | 'desc';
  }
): Promise<{ reports: ForensicReportRow[]; total: number }> {
  const offset = (page - 1) * limit;
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (filters.domain) {
    conditions.push(`reported_domain ILIKE $${paramIndex}`);
    params.push(`%${filters.domain}%`);
    paramIndex++;
  }

  if (filters.feedbackType) {
    conditions.push(`feedback_type = $${paramIndex}`);
    params.push(filters.feedbackType);
    paramIndex++;
  }

  if (filters.authFailure) {
    conditions.push(`auth_failure = $${paramIndex}`);
    params.push(filters.authFailure);
    paramIndex++;
  }

  if (filters.sourceIp) {
    conditions.push(`source_ip = $${paramIndex}`);
    params.push(filters.sourceIp);
    paramIndex++;
  }

  if (filters.startDate) {
    conditions.push(`COALESCE(received_date, created_at) >= $${paramIndex}`);
    params.push(new Date(filters.startDate));
    paramIndex++;
  }

  if (filters.endDate) {
    conditions.push(`COALESCE(received_date, created_at) <= $${paramIndex}`);
    params.push(new Date(filters.endDate + 'T23:59:59'));
    paramIndex++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sortColumns: Record<string, string> = {
    date: 'COALESCE(received_date, created_at)',
    type: 'feedback_type',
    domain: 'reported_domain',
    sourceIp: 'source_ip',
    incidents: 'incidents',
  };
  const sortColumn = sortColumns[filters.sortBy ?? 'date'] ?? sortColumns.date;
  const sortOrder = filters.sortOrder === 'asc' ? 'ASC' : 'DESC';

  // Count and page fetched together — same filtered set, no reason to serialise.
  const [countResult, reportsResult] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM forensic_reports ${whereClause}`,
      params
    ),
    query<ForensicReportRow>(
      `SELECT id, feedback_type, user_agent, original_mail_from, original_rcpt_to,
              received_date, source_ip, reported_domain, auth_failure, authentication_results,
              delivery_result, incidents, dkim_domain, subject, created_at
       FROM forensic_reports ${whereClause}
       ORDER BY ${sortColumn} ${sortOrder} NULLS LAST, id DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    ),
  ]);
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  return { reports: reportsResult.rows, total };
}

/**
 * Get forensic report detail.
 */
export async function getReportDetail(id: number): Promise<ForensicReportRow | null> {
  const result = await query<ForensicReportRow>(
    'SELECT * FROM forensic_reports WHERE id = $1',
    [id]
  );

  return result.rows[0] || null;
}

/**
 * Get forensic chart data for visualization.
 */
export async function getChartData(
  startDate: string,
  endDate: string,
  groupBy: 'date' | 'type' | 'domain' = 'date'
): Promise<{ label: string; count: number }[]> {
  const params = [new Date(startDate), new Date(endDate)];

  let groupColumn: string;
  switch (groupBy) {
    case 'type':
      groupColumn = 'feedback_type';
      break;
    case 'domain':
      groupColumn = 'reported_domain';
      break;
    default:
      groupColumn = 'DATE(COALESCE(received_date, created_at))';
  }

  const result = await query<{ label: string; count: string }>(
    `SELECT 
       ${groupColumn} as label,
       COUNT(*) as count
     FROM forensic_reports
     WHERE COALESCE(received_date, created_at) >= $1 
       AND COALESCE(received_date, created_at) <= $2
     GROUP BY ${groupColumn}
     ORDER BY count DESC
     LIMIT 30`,
    params
  );

  return result.rows.map((row) => ({
    label: String(row.label),
    count: parseInt(row.count, 10),
  }));
}

/**
 * Get forensic stats for dashboard.
 */
export async function getForensicStats(): Promise<{
  totalReports: number;
  last24Hours: number;
  last30Days: number;
  byFeedbackType: { type: string; count: number }[];
  byAuthFailure: { type: string; count: number }[];
  topDomains: { domain: string; count: number }[];
  topSourceIps: { ip: string; count: number }[];
}> {
  return memo(cacheKey('forensicStats'), async () => {
    // The three summary counts merge into one grouped scan; the four
    // breakdown/top queries run in parallel with it. Was seven sequential
    // scans of forensic_reports.
    const [summary, feedbackTypeResult, authFailureResult, domainsResult, ipsResult] =
      await Promise.all([
        query<{ total: string; last_24h: string; last_30d: string }>(
          `SELECT
             COUNT(*)                                                          AS total,
             COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS last_24h,
             COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')  AS last_30d
           FROM forensic_reports`
        ),
        query<{ feedback_type: string; count: string }>(
          `SELECT feedback_type, COUNT(*) AS count
           FROM forensic_reports WHERE feedback_type IS NOT NULL
           GROUP BY feedback_type ORDER BY count DESC`
        ),
        query<{ auth_failure: string; count: string }>(
          `SELECT auth_failure, COUNT(*) AS count
           FROM forensic_reports WHERE auth_failure IS NOT NULL
           GROUP BY auth_failure ORDER BY count DESC`
        ),
        query<{ reported_domain: string; count: string }>(
          `SELECT reported_domain, COUNT(*) AS count
           FROM forensic_reports WHERE reported_domain IS NOT NULL
           GROUP BY reported_domain ORDER BY count DESC LIMIT 10`
        ),
        query<{ source_ip: string; count: string }>(
          `SELECT source_ip, COUNT(*) AS count
           FROM forensic_reports WHERE source_ip IS NOT NULL
           GROUP BY source_ip ORDER BY count DESC LIMIT 10`
        ),
      ]);

    const s = summary.rows[0] ?? { total: '0', last_24h: '0', last_30d: '0' };
    return {
      totalReports: parseInt(s.total, 10),
      last24Hours: parseInt(s.last_24h, 10),
      last30Days: parseInt(s.last_30d, 10),
      byFeedbackType: feedbackTypeResult.rows.map((row) => ({
        type: row.feedback_type,
        count: parseInt(row.count, 10),
      })),
      byAuthFailure: authFailureResult.rows.map((row) => ({
        type: row.auth_failure,
        count: parseInt(row.count, 10),
      })),
      topDomains: domainsResult.rows.map((row) => ({
        domain: row.reported_domain,
        count: parseInt(row.count, 10),
      })),
      topSourceIps: ipsResult.rows.map((row) => ({
        ip: row.source_ip,
        count: parseInt(row.count, 10),
      })),
    };
  });
}

/**
 * List unique feedback types.
 */
export async function listFeedbackTypes(): Promise<string[]> {
  const result = await query<{ feedback_type: string }>(
    `SELECT DISTINCT feedback_type
     FROM forensic_reports
     WHERE feedback_type IS NOT NULL
     ORDER BY feedback_type`
  );

  return result.rows.map((row) => row.feedback_type);
}

/**
 * List unique auth failure types.
 */
export async function listAuthFailureTypes(): Promise<string[]> {
  const result = await query<{ auth_failure: string }>(
    `SELECT DISTINCT auth_failure
     FROM forensic_reports
     WHERE auth_failure IS NOT NULL
     ORDER BY auth_failure`
  );

  return result.rows.map((row) => row.auth_failure);
}
