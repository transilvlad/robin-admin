/**
 * Per-domain workspace.
 *
 * Same aggregate, same timeframe, scoped to one domain — so the numbers here
 * are guaranteed to add up to the row you clicked on the Domains table.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Globe } from 'lucide-react';
import { MetricCard } from '../components/ui/MetricCard';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { reportingApi } from '../api/client';
import { TimeframeControl } from '../components/reporting/TimeframeControl';
import { useTimeframe } from '../components/reporting/useTimeframe';
import {
  BucketBadge,
  ComplianceBar,
  formatCount,
  formatDate,
  formatRate,
  TimeframeBanner,
} from '../components/reporting/primitives';
import type { DomainWorkspace } from '../types/reporting';

export default function DomainWorkspacePage() {
  const { domain = '' } = useParams();
  const navigate = useNavigate();
  const { query, from, to, setRange, clear } = useTimeframe();

  const [data, setData] = useState<DomainWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!domain) return;
    setLoading(true);
    setError('');
    try {
      const res = await reportingApi.getDomain(domain, query);
      setData(res.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load domain');
    } finally {
      setLoading(false);
    }
  }, [domain, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const tfQuery = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v) as [string, string][]
  ).toString();

  const breakdown = data?.domain.breakdown ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Globe}
        title={domain}
        description="Everything receivers reported about this domain in the selected window."
        actions={
          <button className="btn btn-secondary" onClick={() => navigate(`/reporting/domains?${tfQuery}`)}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            All domains
          </button>
        }
      />

      <TimeframeControl
        timeframe={data?.timeframe ?? null}
        from={from}
        to={to}
        onChange={setRange}
        onClear={clear}
      />

      {data && <TimeframeBanner timeframe={data.timeframe} />}

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="flex justify-center py-16">
          <Spinner className="text-robin-orange" />
        </div>
      ) : !data || !breakdown ? null : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="DMARC compliance"
              value={formatRate(data.domain.complianceRate)}
              tone={data.domain.complianceRate >= 0.98 ? 'success' : 'warning'}
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
              sub="Unexplained DMARC failures"
            />
            <MetricCard
              label="Published policy"
              value={`p=${data.domain.policy ?? '—'}`}
              sub={`${formatCount(data.domain.reportCount)} reports · last ${formatDate(
                data.domain.lastReportAt
              )}`}
            />
            <MetricCard
              label="Sending IP addresses"
              value={formatCount(data.domain.sourceCount)}
              sub={`grouped into ${formatCount(data.sources.length)} services below`}
            />
          </div>

          <div className="card p-5">
            <h2 className="mb-4 text-sm font-semibold">Message outcomes</h2>
            <ComplianceBar breakdown={breakdown} />
          </div>

          <section className="card p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Sources sending as this domain</h2>
              <Link to={`/reporting/sources?${tfQuery}`} className="text-xs text-robin-orange hover:underline">
                All sources
              </Link>
            </div>
            {data.sources.length === 0 ? (
              <p className="py-6 text-sm text-gray-500 dark:text-gray-400">
                No sources reported for this domain in this window.
              </p>
            ) : (
              <div className="table-container mt-3">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Service</th>
                      <th>Volume</th>
                      <th>DMARC</th>
                      <th>Needs attention</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sources.map((s) => (
                      <tr key={s.key}>
                        <td>
                          <div className="font-medium">{s.displayName}</div>
                          {s.ptr && (
                            <div className="text-xs text-gray-500 dark:text-gray-400">{s.ptr}</div>
                          )}
                        </td>
                        <td>{formatCount(s.breakdown.totalVolume)}</td>
                        <td>{formatRate(s.complianceRate)}</td>
                        <td
                          className={
                            s.breakdown.actionableFailureVolume > 0
                              ? 'font-medium text-red-600 dark:text-red-400'
                              : 'text-gray-400'
                          }
                        >
                          {formatCount(s.breakdown.actionableFailureVolume)}
                        </td>
                        <td>
                          <BucketBadge bucket={s.bucket} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {data.reporters.length > 0 && (
            <section className="card p-5">
              <h2 className="text-sm font-semibold">Reporters</h2>
              <div className="table-container mt-3">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Reporter</th>
                      <th>Reports</th>
                      <th>Volume</th>
                      <th>Compliance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.reporters.map((r) => (
                      <tr key={r.reporter}>
                        <td className="font-medium">{r.reporter}</td>
                        <td>{formatCount(r.reportCount)}</td>
                        <td>{formatCount(r.breakdown.totalVolume)}</td>
                        <td>{formatRate(r.complianceRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <Link
            to={`/reporting/explorer?${new URLSearchParams({
              ...Object.fromEntries(
                Object.entries(query).filter(([, v]) => v) as [string, string][]
              ),
              domain,
            }).toString()}`}
            className="inline-flex text-sm text-robin-orange hover:underline"
          >
            Inspect this domain's records in Explorer
          </Link>
        </>
      )}
    </div>
  );
}
