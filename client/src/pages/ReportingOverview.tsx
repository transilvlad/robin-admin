/**
 * Reporting Overview.
 *
 *  1. Every headline number is the length of a list you can click through to.
 *     The counts here come from the same timeframe-scoped aggregate that the
 *     Sources and Domains tables read.
 *  2. No percentage stands alone. At 99.77% fleet compliance a lone percentage
 *     reads as "nothing to do" and buries the ~1,000 messages that failed.
 *  3. Emptiness is never rendered as good news — the timeframe banner says when
 *     the data is stale, and empty states say whether data was missing or
 *     whether there genuinely were no problems.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, Globe, Inbox, Server, ShieldAlert } from 'lucide-react';
import { MetricCard } from '../components/ui/MetricCard';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { reportingApi } from '../api/client';
import { TimeframeControl } from '../components/reporting/TimeframeControl';
import { useTimeframe } from '../components/reporting/useTimeframe';
import {
  AttentionRow,
  BucketBadge,
  ComplianceBar,
  formatCount,
  formatDate,
  formatRate,
  TimeframeBanner,
} from '../components/reporting/primitives';
import type {
  DomainAggregate,
  ReportingOverview,
  SourceAggregate,
} from '../types/reporting';

export default function ReportingOverviewPage() {
  const { query, from, to, setRange, clear } = useTimeframe();

  const [overview, setOverview] = useState<ReportingOverview | null>(null);
  const [attention, setAttention] = useState<SourceAggregate[]>([]);
  const [worstDomains, setWorstDomains] = useState<DomainAggregate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // One request serves the whole screen: the server folds sources and
      // domains once and returns the top of each.
      const overviewRes = await reportingApi.getOverview(query);
      const data = overviewRes.data ?? null;
      setOverview(data);
      setAttention((data?.topSources ?? []).filter((s) => s.breakdown.actionableFailureVolume > 0));
      setWorstDomains(
        (data?.topDomains ?? []).filter((d) => d.breakdown.actionableFailureVolume > 0)
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reporting overview');
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  const timeframe = overview?.timeframe ?? null;
  const totals = overview?.totals ?? null;
  const breakdown = totals?.breakdown ?? null;
  const tfQuery = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v) as [string, string][]
  ).toString();

  return (
    <div className="space-y-6">
      <PageHeader
        icon={BarChart3}
        title="Reporting overview"
        description="What receivers told us about mail claiming to be from your domains, for one explicit window. Every figure below links to the list it was counted from."
      />

      <TimeframeControl
        timeframe={timeframe}
        from={from}
        to={to}
        onChange={setRange}
        onClear={clear}
      />

      {timeframe && <TimeframeBanner timeframe={timeframe} />}

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      )}

      {loading && !overview ? (
        <div className="flex justify-center py-16">
          <Spinner className="text-robin-orange" />
        </div>
      ) : !overview || !totals || !breakdown ? null : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="DMARC compliance"
              value={formatRate(totals.complianceRate)}
              tone={totals.complianceRate >= 0.98 ? 'success' : 'warning'}
              toneValue
              sub={`${formatCount(breakdown.compliantVolume)} of ${formatCount(
                breakdown.totalVolume
              )} messages`}
            />
            <MetricCard
              label="Needs attention"
              value={formatCount(breakdown.actionableFailureVolume)}
              tone={breakdown.actionableFailureVolume > 0 ? 'danger' : 'success'}
              toneValue
              sub="Failed DMARC with no forwarding or relay explanation"
              icon={<ShieldAlert className="h-5 w-5" />}
            />
            <MetricCard
              label="Benign forwarding"
              value={formatCount(breakdown.benignRelayVolume)}
              sub="Failed only because a receiver forwarded the message"
            />
            <MetricCard
              label="Coverage"
              value={formatCount(totals.domainCount)}
              sub={`domains · ${formatCount(
                overview.sourceBuckets.all
              )} sending services (${formatCount(
                totals.sourceCount
              )} IPs) · ${formatCount(totals.reportCount)} reports from ${formatCount(
                totals.reporterCount
              )} reporters`}
              icon={<Globe className="h-5 w-5" />}
            />
          </div>

          <div className="card p-5">
            <h2 className="text-sm font-semibold">Message outcomes</h2>
            <p className="mb-4 mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              Compliant · authenticated but not aligned · failed. Failures are split by
              whether the receiver itself explained them as forwarding.
            </p>
            <ComplianceBar breakdown={breakdown} />
            <div className="mt-4 grid gap-3 border-t border-gray-200 pt-4 text-xs dark:border-robin-gray-700 sm:grid-cols-3">
              <div>
                <span className="text-gray-500 dark:text-gray-400">Fully aligned </span>
                <span className="font-medium">{formatCount(breakdown.fullyAlignedVolume)}</span>
              </div>
              <div>
                <span className="text-gray-500 dark:text-gray-400">DKIM aligned only </span>
                <span className="font-medium">{formatCount(breakdown.dkimAlignedVolume)}</span>
              </div>
              <div>
                <span className="text-gray-500 dark:text-gray-400">SPF aligned only </span>
                <span className="font-medium">{formatCount(breakdown.spfAlignedVolume)}</span>
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {(
              [
                ['non_compliant', overview.sourceBuckets.non_compliant],
                ['threat_unknown', overview.sourceBuckets.threat_unknown],
                ['forwarder', overview.sourceBuckets.forwarder],
                ['capable', overview.sourceBuckets.capable],
              ] as const
            ).map(([bucket, count]) => (
              <Link
                key={bucket}
                to={`/reporting/sources?${tfQuery}`}
                className="card p-4 transition hover:border-robin-orange"
              >
                <BucketBadge bucket={bucket} />
                <div className="mt-2 text-2xl font-semibold">{formatCount(count)}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">sending services</div>
              </Link>
            ))}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="card p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">Services needing attention</h2>
                <Link
                  to={`/reporting/sources?${tfQuery}`}
                  className="text-xs text-robin-orange hover:underline"
                >
                  All sources
                </Link>
              </div>
              <div className="mt-2">
                {attention.length === 0 ? (
                  <NothingToDo
                    empty={Boolean(timeframe?.empty)}
                    message="No sending service failed DMARC unexplained in this window."
                  />
                ) : (
                  attention.map((s) => (
                    <AttentionRow
                      key={s.key}
                      title={s.displayName}
                      detail={`${formatCount(
                        s.breakdown.actionableFailureVolume
                      )} unexplained failures · ${formatRate(
                        s.complianceRate
                      )} compliant · ${formatCount(s.domainCount)} domains`}
                      action={
                        <Link
                          to={`/reporting/sources?${tfQuery}`}
                          className="text-xs text-robin-orange hover:underline"
                        >
                          Review
                        </Link>
                      }
                    />
                  ))
                )}
              </div>
            </section>

            <section className="card p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">Domains needing attention</h2>
                <Link
                  to={`/reporting/domains?${tfQuery}`}
                  className="text-xs text-robin-orange hover:underline"
                >
                  All domains
                </Link>
              </div>
              <div className="mt-2">
                {worstDomains.length === 0 ? (
                  <NothingToDo
                    empty={Boolean(timeframe?.empty)}
                    message="No domain had unexplained DMARC failures in this window."
                  />
                ) : (
                  worstDomains.map((d) => (
                    <AttentionRow
                      key={d.domain}
                      title={d.domain}
                      detail={`${formatCount(
                        d.breakdown.actionableFailureVolume
                      )} unexplained failures · ${formatRate(d.complianceRate)} compliant · p=${
                        d.policy ?? 'unknown'
                      }`}
                      action={
                        <Link
                          to={`/reporting/domains/${encodeURIComponent(d.domain)}?${tfQuery}`}
                          className="text-xs text-robin-orange hover:underline"
                        >
                          Open
                        </Link>
                      }
                    />
                  ))
                )}
              </div>
            </section>
          </div>

          <section className="card p-5">
            <h2 className="text-sm font-semibold">Who is reporting to us</h2>
            <p className="mb-3 mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              Compliance differs by receiver. A single reporter showing much worse numbers
              usually means an alignment problem specific to that path.
            </p>
            {overview.reporters.length === 0 ? (
              <NothingToDo
                empty
                message="No aggregate reports were received in this window."
              />
            ) : (
              <div className="table-container">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Reporter</th>
                      <th>Reports</th>
                      <th>Volume</th>
                      <th>Compliance</th>
                      <th>Needs attention</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.reporters.map((r) => (
                      <tr key={r.reporter}>
                        <td className="font-medium">{r.reporter}</td>
                        <td>{formatCount(r.reportCount)}</td>
                        <td>{formatCount(r.breakdown.totalVolume)}</td>
                        <td>
                          {formatRate(r.complianceRate)}{' '}
                          <span className="text-xs text-gray-500">
                            ({formatCount(r.breakdown.compliantVolume)})
                          </span>
                        </td>
                        <td
                          className={
                            r.breakdown.actionableFailureVolume > 0
                              ? 'font-medium text-red-600 dark:text-red-400'
                              : 'text-gray-400'
                          }
                        >
                          {formatCount(r.breakdown.actionableFailureVolume)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {overview.trend.length > 0 && (
            <section className="card p-5">
              <h2 className="text-sm font-semibold">Daily compliance</h2>
              <div className="mt-4 flex items-end gap-1" style={{ height: 120 }}>
                {overview.trend.map((p) => (
                  <div
                    key={p.date}
                    className="group relative flex-1"
                    title={`${formatDate(p.date)}: ${formatRate(
                      p.complianceRate
                    )} of ${formatCount(p.breakdown.totalVolume)}`}
                  >
                    <div
                      className={`w-full rounded-t ${
                        p.complianceRate >= 0.98 ? 'bg-green-500' : 'bg-amber-500'
                      }`}
                      style={{ height: `${Math.max(2, p.complianceRate * 120)}px` }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-2 flex justify-between text-xs text-gray-500 dark:text-gray-400">
                <span>{formatDate(overview.trend[0]?.date)}</span>
                <span>{formatDate(overview.trend[overview.trend.length - 1]?.date)}</span>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function NothingToDo({ empty, message }: { empty: boolean; message: string }) {
  if (empty) {
    return (
      <div className="flex items-start gap-2 py-6 text-sm text-gray-500 dark:text-gray-400">
        <Inbox className="mt-0.5 h-4 w-4 shrink-0" />
        <span>No data in this window — this is missing data, not a clean result.</span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 py-6 text-sm text-gray-500 dark:text-gray-400">
      <Server className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
      <span>{message}</span>
    </div>
  );
}
