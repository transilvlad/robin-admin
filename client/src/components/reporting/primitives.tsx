/**
 * Shared reporting v2 presentation primitives.
 *
 * Presentation rules for trustworthy reporting screens:
 *  - A percentage never appears without the absolute count behind it. At 99.77%
 *    fleet compliance a bare percentage reads as "all green" and hides the
 *    thousand messages that genuinely failed.
 *  - Every screen states the window it is describing, and says so loudly when
 *    the newest report is months old.
 *  - "No data in this window" and "no problems in this window" are different
 *    sentences and are never collapsed into one.
 */

import type { ReactNode } from 'react';
import { AlertTriangle, CalendarClock, Inbox, ShieldCheck } from 'lucide-react';
import type {
  SourceBucket,
  TaxonomyBreakdown,
  TimeframeInfo,
} from '../../types/reporting';
import { SOURCE_BUCKET_LABELS } from '../../types/reporting';

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString();
}

export function formatRate(rate: number | null | undefined, digits = 2): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '—';
  return `${(rate * 100).toFixed(digits)}%`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString().slice(0, 10);
}

/**
 * The Mimecast/dmarcian three-class volume bar: compliant, authenticated but
 * unaligned, failed. Segments are proportional but every segment also carries
 * its absolute volume in the legend.
 */
export function ComplianceBar({ breakdown }: { breakdown: TaxonomyBreakdown }) {
  const total = breakdown.totalVolume || 1;
  const segments = [
    {
      key: 'compliant',
      label: 'DMARC compliant',
      value: breakdown.compliantVolume,
      className: 'bg-green-500',
    },
    {
      key: 'authenticated_unaligned',
      label: 'Authenticated, not aligned',
      value: breakdown.authenticatedUnalignedVolume,
      className: 'bg-amber-500',
    },
    {
      key: 'benign',
      label: 'Failed — forwarded / relayed',
      value: breakdown.benignRelayVolume,
      className: 'bg-sky-500',
    },
    {
      key: 'actionable',
      label: 'Failed — needs attention',
      value: breakdown.actionableFailureVolume,
      className: 'bg-red-500',
    },
  ];

  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-robin-gray-700">
        {segments.map((s) =>
          s.value > 0 ? (
            <div
              key={s.key}
              className={s.className}
              style={{ width: `${(s.value / total) * 100}%` }}
              title={`${s.label}: ${formatCount(s.value)}`}
            />
          ) : null
        )}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {segments.map((s) => (
          <div key={s.key} className="flex items-start gap-2">
            <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${s.className}`} />
            <div className="min-w-0">
              <div className="text-xs text-gray-500 dark:text-gray-400">{s.label}</div>
              <div className="text-sm font-semibold">
                {formatCount(s.value)}
                <span className="ml-1 text-xs font-normal text-gray-500 dark:text-gray-400">
                  ({((s.value / total) * 100).toFixed(2)}%)
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const BUCKET_CLASSES: Record<SourceBucket, string> = {
  capable: 'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300',
  non_compliant: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300',
  forwarder: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
  threat_unknown: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
};

export function BucketBadge({ bucket }: { bucket: SourceBucket }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${BUCKET_CLASSES[bucket]}`}
    >
      {SOURCE_BUCKET_LABELS[bucket]}
    </span>
  );
}

/**
 * States the window in plain language and warns when the data is old.
 */
export function TimeframeBanner({ timeframe }: { timeframe: TimeframeInfo }) {
  if (timeframe.empty) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-gray-300 bg-gray-50 p-4 text-sm dark:border-robin-gray-600 dark:bg-robin-gray-800">
        <Inbox className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
        <div>
          <div className="font-medium">No DMARC reports have been received yet</div>
          <div className="mt-0.5 text-gray-500 dark:text-gray-400">
            Nothing can be assessed until receivers start sending aggregate reports.
          </div>
        </div>
      </div>
    );
  }

  if (!timeframe.stale) return null;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-500/40 dark:bg-amber-500/10">
      <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div>
        <div className="font-medium text-amber-900 dark:text-amber-200">
          These figures describe {formatDate(timeframe.from)} to {formatDate(timeframe.to)}
        </div>
        <div className="mt-0.5 text-amber-800 dark:text-amber-300">
          The newest report received is {timeframe.dataAgeDays} days old
          {timeframe.dataTo ? ` (${formatDate(timeframe.dataTo)})` : ''}. Nothing here
          reflects current sending.
        </div>
      </div>
    </div>
  );
}

/**
 * Distinguishes "there was no data" from "there were no problems". Collapsing
 * these two cases would make a missing data feed look healthy.
 */
export function ReportingEmptyState({
  timeframe,
  noun,
  filtered,
}: {
  timeframe: TimeframeInfo;
  noun: string;
  filtered?: boolean;
}) {
  if (timeframe.empty) {
    return (
      <div className="py-10 text-center">
        <Inbox className="mx-auto h-6 w-6 text-gray-400" />
        <div className="mt-2 font-medium">No report data in {formatDate(timeframe.from)} – {formatDate(timeframe.to)}</div>
        <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          This is missing data, not a clean result. Widen the timeframe.
        </div>
      </div>
    );
  }

  return (
    <div className="py-10 text-center">
      <ShieldCheck className="mx-auto h-6 w-6 text-green-500" />
      <div className="mt-2 font-medium">
        No {noun} in {formatDate(timeframe.from)} – {formatDate(timeframe.to)}
      </div>
      <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        {filtered
          ? 'Reports were received and processed; none matched these filters.'
          : 'Reports were received and processed for this window.'}
      </div>
    </div>
  );
}

export function AttentionRow({
  title,
  detail,
  action,
}: {
  title: ReactNode;
  detail: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-gray-200 py-3 last:border-0 dark:border-robin-gray-700">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <div>
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{detail}</div>
        </div>
      </div>
      {action}
    </div>
  );
}
