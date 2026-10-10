import { initializeSchema } from '../src/db/schema.js';
import { analyzeDmarcIntelligence } from '../src/services/dmarc-intelligence.js';
import { analyzeTlsrptIntelligence } from '../src/services/tlsrpt-intelligence.js';
import { analyzeForensicIntelligence } from '../src/services/forensic-intelligence.js';
import { closePool, query } from '../src/db/connection.js';

async function main(): Promise<void> {
  await initializeSchema();

  const rangeResult = await query<{ start_ts: string | null }>(
    `SELECT MIN(ts) AS start_ts FROM (
       SELECT MIN(date_begin) AS ts FROM dmarc_reports
       UNION ALL
       SELECT MIN(date_begin) AS ts FROM tlsrpt_reports
       UNION ALL
       SELECT MIN(COALESCE(arrival_date, received_date, created_at)) AS ts FROM forensic_reports
     ) t`
  );

  const startDate = rangeResult.rows[0]?.start_ts
    ? new Date(rangeResult.rows[0].start_ts)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const endDate = new Date();

  await query(
    `TRUNCATE TABLE
       remediation_suggestions,
       reporting_issues,
       domain_health,
       sender_inventory
     RESTART IDENTITY`
  );

  const [dmarc, tlsrpt, forensic] = await Promise.all([
    analyzeDmarcIntelligence({ startDate, endDate }),
    analyzeTlsrptIntelligence({ startDate, endDate }),
    analyzeForensicIntelligence({ startDate, endDate }),
  ]);

  const counts = await query<{ table_name: string; row_count: string }>(
    `SELECT table_name, row_count FROM (
       SELECT 'sender_inventory' AS table_name, COUNT(*)::text AS row_count FROM sender_inventory
       UNION ALL
       SELECT 'domain_health', COUNT(*)::text FROM domain_health
       UNION ALL
       SELECT 'reporting_issues', COUNT(*)::text FROM reporting_issues
       UNION ALL
       SELECT 'remediation_suggestions', COUNT(*)::text FROM remediation_suggestions
     ) counts`
  );

  console.log(JSON.stringify({
    rebuiltFrom: startDate.toISOString(),
    rebuiltTo: endDate.toISOString(),
    results: { dmarc, tlsrpt, forensic },
    derivedCounts: counts.rows,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
