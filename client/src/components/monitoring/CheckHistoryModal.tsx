/**
 * A Monitoring check's daily history: availability per day as a bar strip and
 * average and slowest response time as a chart, from the daily rollups.
 */

import { useEffect, useMemo, useState } from 'react';
import { ApiError, monitoringApi } from '../../api/client';
import { Modal } from '../ui/Modal';
import { Spinner } from '../ui/Spinner';
import { SegmentedFilter } from '../ui/SegmentedFilter';
import { TimeSeriesChart } from '../telemetry/TimeSeriesChart';
import type { MonitoringCheck, MonitoringCheckDay, MonitoringLocationDay, MonitoringObservation } from '../../types/monitoring';
import type { TelemetryRangeData } from '../../types/telemetry';

const RANGES = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '365 days' },
] as const;

type RangeValue = typeof RANGES[number]['value'];

function dayColor(availability: number | null): string {
  if (availability === null) return 'bg-gray-200 dark:bg-robin-gray-700';
  if (availability >= 0.999) return 'bg-green-500';
  if (availability >= 0.99) return 'bg-amber-400';
  return 'bg-red-500';
}

function percent(value: number): string {
  return `${(Math.floor(value * 100000) / 1000).toFixed(3).replace(/\.?0+$/, '')}%`;
}

/** Availability over the whole period, weighted by observations rather than days. */
export function overallAvailability(days: MonitoringCheckDay[]): number | null {
  let reachable = 0;
  let total = 0;
  for (const day of days) {
    reachable += day.up + day.warning;
    total += day.up + day.warning + day.down;
  }
  return total > 0 ? reachable / total : null;
}

export function responseChartData(days: MonitoringCheckDay[]): TelemetryRangeData {
  const observed = days.map((day) => Date.parse(`${day.day}T00:00:00Z`) / 1000);
  // uPlot's numeric single-point padding is years wide for epoch timestamps.
  const single = observed.length === 1;
  const timestamps = single ? [observed[0]! - 43200, observed[0]!, observed[0]! + 43200] : observed;
  const values = (read: (day: MonitoringCheckDay) => number | null) => single ? [null, read(days[0]), null] : days.map(read);
  return {
    start: timestamps[0] ?? 0,
    end: timestamps[timestamps.length - 1] ?? 0,
    step: 86400,
    timestamps,
    truncated: false,
    series: [
      { name: 'Average', labels: {}, values: values(day => day.averageResponseTimeMs) },
      { name: 'Slowest', labels: {}, values: values(day => day.maxResponseTimeMs) },
    ],
  };
}

export function CheckHistoryModal({ check, onClose }: { check: MonitoringCheck; onClose: () => void }) {
  const [range, setRange] = useState<RangeValue>('90');
  const [days, setDays] = useState<MonitoringCheckDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [observations, setObservations] = useState<MonitoringObservation[]>([]);
  const [observationError, setObservationError] = useState('');
  const [locationDays, setLocationDays] = useState<MonitoringLocationDay[] | null>(null);
  const [locationHistoryError, setLocationHistoryError] = useState('');

  useEffect(() => {
    let active = true;
    setObservations([]); setObservationError('');
    monitoringApi.checkObservations(check.id).then(response => { if (active) setObservations(response.data ?? []); })
      .catch(() => { if (active) setObservationError('Failed to load recent observations'); });
    return () => { active = false; };
  }, [check.id]);

  useEffect(() => {
    setDays(null);
    monitoringApi.checkHistory(check.id, Number(range))
      .then((response) => {
        setDays(response.data ?? []);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Failed to load the history'));
  }, [check.id, range]);

  useEffect(() => {
    let active = true;
    setLocationDays(null);
    setLocationHistoryError('');
    monitoringApi.checkLocationHistory(check.id, Number(range))
      .then(response => { if (active) setLocationDays(response.data ?? []); })
      .catch(() => { if (active) setLocationHistoryError('Failed to load per-location history'); });
    return () => { active = false; };
  }, [check.id, range]);

  const overall = useMemo(() => (days ? overallAvailability(days) : null), [days]);
  const outageDays = days?.filter((day) => day.down > 0).length ?? 0;

  return (
    <Modal isOpen size="xl" onClose={onClose} title={`History of ${check.name}`}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {check.targetName} · {check.endpoint}{check.port ? `:${check.port}` : ''}
          </p>
          <SegmentedFilter<RangeValue> ariaLabel="Period" options={RANGES} value={range} onChange={setRange} />
        </div>
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {!days ? (
          !error && <div className="flex justify-center py-10"><Spinner label="Loading history" /></div>
        ) : days.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">No observations in this period yet.</p>
        ) : (
          <>
            <dl className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <dt className="text-xs text-gray-500 dark:text-gray-400">Availability</dt>
                <dd className="text-xl font-semibold tabular-nums">{overall === null ? '—' : percent(overall)}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500 dark:text-gray-400">Days with downtime</dt>
                <dd className="text-xl font-semibold tabular-nums">{outageDays}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500 dark:text-gray-400">Days with data</dt>
                <dd className="text-xl font-semibold tabular-nums">{days.length}</dd>
              </div>
            </dl>
            <div>
              <h3 className="mb-1 text-sm font-medium">Availability per day</h3>
              <ul className="flex h-8 gap-px" aria-label="Availability per day">
                {days.map((day) => (
                  <li
                    key={day.day}
                    className={`min-w-[2px] flex-1 rounded-xs ${dayColor(day.availability)}`}
                    title={`${day.day}: ${day.availability === null ? 'no data' : percent(day.availability)} · ${day.down} down, ${day.warning} warning of ${day.up + day.warning + day.down}`}
                    aria-label={`${day.day}: ${day.availability === null ? 'no data' : percent(day.availability)}`}
                  />
                ))}
              </ul>
              <div className="mt-1 flex justify-between text-xs text-gray-500 dark:text-gray-400">
                <span>{days[0].day}</span>
                <span>Green 99.9% or more · amber 99% or more · red below</span>
                <span>{days[days.length - 1].day}</span>
              </div>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-medium">Response time per day</h3>
              <TimeSeriesChart data={responseChartData(days)} unit="milliseconds" height={220} />
            </div>
          </>
        )}
        <section className="border-t border-gray-200 pt-4 dark:border-robin-gray-700">
          <h3 className="mb-2 text-sm font-medium">Per-location history</h3>
          {locationHistoryError ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{locationHistoryError}</p>
            : locationDays === null ? <Spinner label="Loading location history" /> : locationDays.length === 0
            ? <p className="text-sm text-gray-500 dark:text-gray-400">No per-location history in this period yet.</p>
            : <div className="max-h-64 overflow-auto"><table className="min-w-full text-left text-sm">
              <thead><tr>{['Location', 'Day', 'Availability', 'Average', 'Slowest'].map(label => <th className="px-2 py-2 font-medium" key={label}>{label}</th>)}</tr></thead>
              <tbody>{locationDays.map(row => <tr className="border-t border-gray-200 dark:border-robin-gray-700" key={`${row.locationId}-${row.day}`}>
                <td className="whitespace-nowrap px-2 py-2">{row.locationName}{row.region ? ` · ${row.region}` : ''}</td>
                <td className="whitespace-nowrap px-2 py-2">{row.day}</td>
                <td className="px-2 py-2">{row.availability === null ? '—' : percent(row.availability)}</td>
                <td className="px-2 py-2">{row.averageResponseTimeMs === null ? '—' : `${row.averageResponseTimeMs} ms`}</td>
                <td className="px-2 py-2">{row.maxResponseTimeMs === null ? '—' : `${row.maxResponseTimeMs} ms`}</td>
              </tr>)}</tbody>
            </table></div>}
        </section>
        <section className="border-t border-gray-200 pt-4 dark:border-robin-gray-700">
          <h3 className="mb-2 text-sm font-medium">Latest 50 observations</h3>
          {observationError && <p role="alert" className="text-sm text-red-600">{observationError}</p>}
          <div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead><tr>{['Observed', 'Status', 'Response', 'Result'].map(label => <th className="px-2 py-2 font-medium" key={label}>{label}</th>)}</tr></thead><tbody>{observations.map(observation => <tr className="border-t border-gray-200 dark:border-robin-gray-700" key={observation.id}><td className="whitespace-nowrap px-2 py-2">{new Date(observation.observedAt).toLocaleString()}</td><td className="px-2 py-2">{observation.status}</td><td className="px-2 py-2">{observation.responseTimeMs === null ? '-' : `${observation.responseTimeMs} ms`}</td><td className="max-w-sm wrap-break-word px-2 py-2">{observation.error ?? 'Passed'}</td></tr>)}</tbody></table></div>
        </section>
      </div>
    </Modal>
  );
}
