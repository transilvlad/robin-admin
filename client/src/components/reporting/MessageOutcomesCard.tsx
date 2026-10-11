import { ComplianceBar, formatCount, formatDate, formatRate } from './primitives';
import type { TaxonomyBreakdown, TrendPoint } from '../../types/reporting';

/**
 * "Message outcomes" card — DMARC compliance breakdown (compliant / authenticated
 * but not aligned / failed) plus the aligned-volume splits, and an optional daily
 * trend strip. Shared between the Reporting Overview page and the dashboard.
 */
export function MessageOutcomesCard({ breakdown, trend }: { breakdown: TaxonomyBreakdown; trend?: TrendPoint[] }) {
  return (
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
      {trend && trend.length > 0 && (
        <div className="mt-4 border-t border-gray-200 pt-4 dark:border-robin-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400">Daily compliance rate</p>
          <div className="mt-2 flex items-end gap-1" style={{ height: 44 }}>
            {trend.map((p) => (
              <div
                key={p.date}
                className="group relative flex-1"
                title={`${formatDate(p.date)}: ${formatRate(p.complianceRate)} of ${formatCount(p.breakdown.totalVolume)}`}
              >
                <div
                  className={`w-full rounded-t ${p.complianceRate >= 0.98 ? 'bg-green-500' : 'bg-amber-500'}`}
                  style={{ height: `${Math.max(2, p.complianceRate * 44)}px` }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex justify-between text-[11px] text-gray-500 dark:text-gray-400">
            <span>{formatDate(trend[0]?.date)}</span>
            <span>{formatDate(trend[trend.length - 1]?.date)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
