/**
 * Global reporting timeframe control.
 *
 * Presets are anchored to the *data*, not to `now()`. On a fleet whose newest
 * report is months old, a "Last 30 days" preset relative to today silently
 * selects nothing — so "Last 7 / 30 / 90 days" here mean "the last N days of
 * data we actually hold", and "All data" is always available.
 */

import { useEffect, useState } from 'react';
import { CalendarRange } from 'lucide-react';
import type { TimeframeInfo } from '../../types/reporting';

interface Props {
  timeframe: TimeframeInfo | null;
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  onClear: () => void;
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function TimeframeControl({ timeframe, from, to, onChange, onClear }: Props) {
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);

  useEffect(() => {
    setDraftFrom(from || (timeframe?.from ?? '').slice(0, 10));
    setDraftTo(to || (timeframe?.to ?? '').slice(0, 10));
  }, [from, to, timeframe?.from, timeframe?.to]);

  const anchor = (timeframe?.dataTo ?? '').slice(0, 10);
  const earliest = (timeframe?.dataFrom ?? '').slice(0, 10);

  const applyPreset = (days: number) => {
    if (!anchor) return;
    onChange(shiftDays(anchor, -(days - 1)), anchor);
  };

  return (
    <div className="card flex flex-wrap items-end gap-3 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300">
        <CalendarRange className="h-4 w-4 text-robin-orange" />
        Timeframe
      </div>

      <div className="flex items-end gap-2">
        <label className="text-xs text-gray-500 dark:text-gray-400">
          From
          <input
            type="date"
            className="input mt-1 py-1 text-sm"
            value={draftFrom}
            min={earliest || undefined}
            max={anchor || undefined}
            onChange={(e) => setDraftFrom(e.target.value)}
          />
        </label>
        <label className="text-xs text-gray-500 dark:text-gray-400">
          To
          <input
            type="date"
            className="input mt-1 py-1 text-sm"
            value={draftTo}
            min={earliest || undefined}
            max={anchor || undefined}
            onChange={(e) => setDraftTo(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn btn-secondary py-1.5 text-sm"
          disabled={!draftFrom || !draftTo}
          onClick={() => onChange(draftFrom, draftTo)}
        >
          Apply
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {[7, 30, 90].map((days) => (
          <button
            key={days}
            type="button"
            className="btn btn-secondary px-2 py-1 text-xs"
            disabled={!anchor}
            onClick={() => applyPreset(days)}
            title={anchor ? `Last ${days} days of available data (to ${anchor})` : 'No data'}
          >
            Last {days}d of data
          </button>
        ))}
        {earliest && anchor && (
          <button
            type="button"
            className="btn btn-secondary px-2 py-1 text-xs"
            onClick={() => onChange(earliest, anchor)}
          >
            All data
          </button>
        )}
        {(from || to) && (
          <button type="button" className="btn btn-secondary px-2 py-1 text-xs" onClick={onClear}>
            Reset
          </button>
        )}
      </div>

      {timeframe && !timeframe.empty && (
        <div className="ml-auto text-xs text-gray-500 dark:text-gray-400">
          Data available {(timeframe.dataFrom ?? '').slice(0, 10)} –{' '}
          {(timeframe.dataTo ?? '').slice(0, 10)}
        </div>
      )}
    </div>
  );
}
