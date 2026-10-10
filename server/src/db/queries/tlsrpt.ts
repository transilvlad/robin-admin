/**
 * TLSRPT (TLS Reporting - RFC 8460) database queries.
 */

import { getClient, query } from '../connection.js';
import { scheduleReportingCacheInvalidation, memo, cacheKey } from '../../services/reporting-cache.js';

/**
 * Input structure for TLSRPT report from Robin bot.
 */
export interface TlsrptReportInput {
  reportId: string;
  organizationName?: string;
  contactInfo?: string;
  dateBegin?: string;
  dateEnd?: string;
  totalSuccess?: number;
  totalFailure?: number;
  policies?: TlsrptPolicyInput[];
}

export interface TlsrptPolicyInput {
  policyType: string;
  policyDomain: string;
  policyString?: string[];
  mxHost?: string;
  successCount?: number;
  failureCount?: number;
  failures?: TlsrptFailureInput[];
}

export interface TlsrptFailureInput {
  resultType: string;
  sendingMtaIp?: string;
  receivingMxHostname?: string;
  receivingMxHelo?: string;
  receivingIp?: string;
  failedSessionCount?: number;
  failureReasonCode?: string;
  additionalInfo?: string;
}

/**
 * Database row types.
 */
interface TlsrptReportRow {
  id: number;
  report_id: string;
  organization_name: string | null;
  contact_info: string | null;
  date_begin: Date;
  date_end: Date;
  total_success: number;
  total_failure: number;
  created_at: Date;
}

interface TlsrptPolicyRow {
  id: number;
  report_id: number;
  policy_type: string;
  policy_domain: string;
  policy_string: string[] | null;
  mx_host: string | null;
  success_count: number;
  failure_count: number;
  created_at: Date;
}

interface TlsrptFailureRow {
  id: number;
  policy_id: number;
  result_type: string;
  sending_mta_ip: string | null;
  receiving_mx_hostname: string | null;
  receiving_ip: string | null;
  failed_session_count: number;
  failure_reason_code: string | null;
  additional_info: string | null;
  created_at: Date;
}

/**
 * Insert a TLSRPT report with policies and failures.
 */
export async function insertReport(input: TlsrptReportInput): Promise<number> {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    const reportResult = await client.query<{ id: number }>(
      `INSERT INTO tlsrpt_reports 
       (report_id, organization_name, contact_info, date_begin, date_end, total_success, total_failure, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (report_id) DO UPDATE SET
         organization_name = EXCLUDED.organization_name,
         contact_info = EXCLUDED.contact_info,
         total_success = EXCLUDED.total_success,
         total_failure = EXCLUDED.total_failure,
         raw_payload = EXCLUDED.raw_payload
       RETURNING id`,
      [
        input.reportId,
        input.organizationName || null,
        input.contactInfo || null,
        input.dateBegin ? new Date(input.dateBegin) : new Date(),
        input.dateEnd ? new Date(input.dateEnd) : new Date(),
        input.totalSuccess || 0,
        input.totalFailure || 0,
        JSON.stringify(input),
      ]
    );

    const reportId = reportResult.rows[0].id;
    await client.query('DELETE FROM tlsrpt_policies WHERE report_id = $1', [reportId]);

    if (input.policies) {
      for (const policy of input.policies) {
        const policyResult = await client.query<{ id: number }>(
          `INSERT INTO tlsrpt_policies
           (report_id, policy_type, policy_domain, policy_string, mx_host, success_count, failure_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [
            reportId,
            policy.policyType,
            policy.policyDomain,
            policy.policyString || null,
            policy.mxHost || null,
            policy.successCount || 0,
            policy.failureCount || 0,
          ]
        );

        const policyId = policyResult.rows[0].id;

        if (policy.failures) {
          for (const failure of policy.failures) {
            await client.query(
              `INSERT INTO tlsrpt_failures
               (policy_id, result_type, sending_mta_ip, receiving_mx_hostname, receiving_mx_helo, receiving_ip, 
                failed_session_count, failure_reason_code, additional_info)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                policyId,
                failure.resultType,
                failure.sendingMtaIp || null,
                failure.receivingMxHostname || null,
                failure.receivingMxHelo || null,
                failure.receivingIp || null,
                failure.failedSessionCount || 1,
                failure.failureReasonCode || null,
                failure.additionalInfo || null,
              ]
            );
          }
        }
      }
    }

    await client.query('COMMIT');
    // See dmarc.ts: reporting aggregates are memoised on the assumption that
    // report data is immutable once stored, so any new report has to bust
    // that. Debounced because a burst of ingests would otherwise defeat the
    // cache.
    scheduleReportingCacheInvalidation();
    return reportId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * List TLSRPT reports with pagination.
 */
export async function listReports(
  page: number,
  limit: number,
  filters: {
    domain?: string;
    organization?: string;
    startDate?: string;
    endDate?: string;
    sortBy?: 'date' | 'organization' | 'success' | 'failure' | 'report';
    sortOrder?: 'asc' | 'desc';
  }
): Promise<{ reports: TlsrptReportRow[]; total: number }> {
  const offset = (page - 1) * limit;
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (filters.domain) {
    // Check in policies table
    conditions.push(`id IN (SELECT report_id FROM tlsrpt_policies WHERE policy_domain ILIKE $${paramIndex})`);
    params.push(`%${filters.domain}%`);
    paramIndex++;
  }

  if (filters.organization) {
    conditions.push(`organization_name ILIKE $${paramIndex}`);
    params.push(`%${filters.organization}%`);
    paramIndex++;
  }

  if (filters.startDate) {
    conditions.push(`date_begin >= $${paramIndex}`);
    params.push(new Date(filters.startDate));
    paramIndex++;
  }

  if (filters.endDate) {
    conditions.push(`date_end <= $${paramIndex}`);
    params.push(new Date(filters.endDate));
    paramIndex++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sortColumns: Record<string, string> = {
    date: 'date_begin',
    organization: 'organization_name',
    success: 'total_success',
    failure: 'total_failure',
    report: 'report_id',
  };
  const sortColumn = sortColumns[filters.sortBy ?? 'date'] ?? sortColumns.date;
  const sortOrder = filters.sortOrder === 'asc' ? 'ASC' : 'DESC';

  // Count and page fetched together — same filtered set, no reason to serialise.
  const [countResult, reportsResult] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM tlsrpt_reports ${whereClause}`,
      params
    ),
    query<TlsrptReportRow>(
      `SELECT * FROM tlsrpt_reports ${whereClause}
       ORDER BY ${sortColumn} ${sortOrder} NULLS LAST, id DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    ),
  ]);
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  return { reports: reportsResult.rows, total };
}

/**
 * Get TLSRPT report detail with policies and failures.
 */
export async function getReportDetail(id: number): Promise<{
  report: TlsrptReportRow | null;
  policies: (TlsrptPolicyRow & { failures: TlsrptFailureRow[] })[];
}> {
  // Get report
  const reportResult = await query<TlsrptReportRow>(
    'SELECT * FROM tlsrpt_reports WHERE id = $1',
    [id]
  );

  const report = reportResult.rows[0] || null;
  if (!report) {
    return { report: null, policies: [] };
  }

  // Get policies
  const policiesResult = await query<TlsrptPolicyRow>(
    'SELECT * FROM tlsrpt_policies WHERE report_id = $1 ORDER BY id',
    [id]
  );

  // One query for all policies' failures instead of N (per-policy N+1).
  const policyIds = policiesResult.rows.map((p) => p.id);
  const failuresByPolicy = new Map<number, TlsrptFailureRow[]>(policyIds.map((id) => [id, []]));
  if (policyIds.length > 0) {
    const failuresResult = await query<TlsrptFailureRow>(
      `SELECT * FROM tlsrpt_failures WHERE policy_id = ANY($1::int[]) ORDER BY policy_id, id`,
      [policyIds]
    );
    for (const row of failuresResult.rows) {
      const bucket = failuresByPolicy.get(row.policy_id);
      if (bucket) bucket.push(row);
    }
  }
  const policies = policiesResult.rows.map((policy) => ({
    ...policy,
    failures: failuresByPolicy.get(policy.id) ?? [],
  }));

  return { report, policies };
}

/**
 * Get TLSRPT chart data for visualization.
 */
export async function getChartData(
  startDate: string,
  endDate: string,
  domain?: string
): Promise<{ date: string; success: number; failure: number }[]> {
  let domainFilter = '';
  const params: unknown[] = [new Date(startDate), new Date(endDate)];

  if (domain) {
    domainFilter = `AND r.id IN (SELECT report_id FROM tlsrpt_policies WHERE policy_domain ILIKE $3)`;
    params.push(`%${domain}%`);
  }

  const result = await query<{ date: string; success: string; failure: string }>(
    `SELECT 
       DATE(r.date_begin) as date,
       COALESCE(SUM(r.total_success), 0) as success,
       COALESCE(SUM(r.total_failure), 0) as failure
     FROM tlsrpt_reports r
     WHERE r.date_begin >= $1 AND r.date_end <= $2 ${domainFilter}
     GROUP BY DATE(r.date_begin)
     ORDER BY date`,
    params
  );

  return result.rows.map((row) => ({
    date: row.date,
    success: parseInt(row.success, 10),
    failure: parseInt(row.failure, 10),
  }));
}

/**
 * Get TLSRPT stats for dashboard.
 */
export async function getTlsrptStats(): Promise<{
  totalReports: number;
  last24Hours: number;
  last30Days: number;
  totalSuccess: number;
  totalFailure: number;
  topFailureTypes: { type: string; count: number }[];
}> {
  return memo(cacheKey('tlsrptStats'), async () => {
    // A single grouped scan over tlsrpt_reports for the four report-level
    // numbers (was four separate queries in sequence), plus one grouped scan of
    // tlsrpt_failures for the top failure types, run in parallel.
    const [summary, failureTypesResult] = await Promise.all([
      query<{
        total: string;
        last_24h: string;
        last_30d: string;
        success: string;
        failure: string;
      }>(
        `SELECT
           COUNT(*)                                                           AS total,
           COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')  AS last_24h,
           COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')   AS last_30d,
           COALESCE(SUM(total_success), 0)                                    AS success,
           COALESCE(SUM(total_failure), 0)                                    AS failure
         FROM tlsrpt_reports`
      ),
      query<{ result_type: string; count: string }>(
        `SELECT result_type, COUNT(*) AS count
         FROM tlsrpt_failures
         GROUP BY result_type
         ORDER BY count DESC
         LIMIT 5`
      ),
    ]);

    const s = summary.rows[0] ?? { total: '0', last_24h: '0', last_30d: '0', success: '0', failure: '0' };
    return {
      totalReports: parseInt(s.total, 10),
      last24Hours: parseInt(s.last_24h, 10),
      last30Days: parseInt(s.last_30d, 10),
      totalSuccess: parseInt(s.success, 10),
      totalFailure: parseInt(s.failure, 10),
      topFailureTypes: failureTypesResult.rows.map((row) => ({
        type: row.result_type,
        count: parseInt(row.count, 10),
      })),
    };
  });
}

/**
 * List unique domains from TLSRPT policies.
 */
export async function listDomains(): Promise<{ domain: string; count: number }[]> {
  const result = await query<{ policy_domain: string; count: string }>(
    `SELECT policy_domain, COUNT(*) as count
     FROM tlsrpt_policies
     GROUP BY policy_domain
     ORDER BY count DESC`
  );

  return result.rows.map((row) => ({
    domain: row.policy_domain,
    count: parseInt(row.count, 10),
  }));
}
