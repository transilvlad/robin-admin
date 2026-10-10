import { useState } from 'react';
import { CalendarRange, RefreshCw, X } from 'lucide-react';
import { SegmentedFilter } from '../ui/SegmentedFilter';
import {
  describeRange,
  fromLocalInput,
  RANGE_PRESETS,
  REFRESH_OPTIONS,
  resolveRange,
  toLocalInput,
  type RangePreset,
  type TimeRange,
} from '../../utils/telemetry';

interface TimeRangePickerProps {
  range: TimeRange;
  onRangeChange: (range: TimeRange) => void;
  refreshSeconds: number;
  onRefreshSecondsChange: (seconds: number) => void;
  onRefresh: () => void;
}

/** Presets, a custom window, auto refresh and a manual refresh button. */
export function TimeRangePicker({ range, onRangeChange, refreshSeconds, onRefreshSecondsChange, onRefresh }: TimeRangePickerProps) {
  const [editing, setEditing] = useState(false);
  const current = resolveRange(range);
  const [from, setFrom] = useState(toLocalInput(current.start));
  const [to, setTo] = useState(toLocalInput(current.end));
  const fromSeconds = fromLocalInput(from);
  const toSeconds = fromLocalInput(to);
  const valid = fromSeconds !== null && toSeconds !== null && toSeconds > fromSeconds;

  const openCustom = () => {
    const resolved = resolveRange(range);
    setFrom(toLocalInput(resolved.start));
    setTo(toLocalInput(resolved.end));
    setEditing(true);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {range.kind === 'absolute' ? (
        <span className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-1.5 text-sm dark:border-robin-gray-700">
          <CalendarRange aria-hidden="true" className="h-4 w-4 text-gray-500" />
          {describeRange(range)}
          <button
            type="button"
            onClick={() => onRangeChange({ kind: 'relative', preset: '6h' })}
            className="rounded-sm p-0.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-robin-gray-700"
            aria-label="Back to last 6h"
            title="Back to last 6h"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      ) : (
        <SegmentedFilter<RangePreset>
          ariaLabel="Time range"
          options={RANGE_PRESETS.map((preset) => ({ value: preset.value, label: preset.label }))}
          value={range.preset}
          onChange={(preset) => onRangeChange({ kind: 'relative', preset })}
        />
      )}
      <button type="button" className="btn btn-secondary px-3 py-1.5 text-sm" onClick={openCustom} aria-expanded={editing}>
        <CalendarRange aria-hidden="true" className="h-4 w-4" />
        Custom
      </button>
      <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
        <span className="sr-only">Auto refresh</span>
        <select
          className="input w-auto py-1.5 text-sm"
          value={refreshSeconds}
          onChange={(event) => onRefreshSecondsChange(Number(event.target.value))}
          disabled={range.kind === 'absolute'}
          aria-label="Auto refresh"
          title={range.kind === 'absolute' ? 'Auto refresh applies to relative ranges' : 'Auto refresh'}
        >
          {REFRESH_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.value ? `Every ${option.label}` : 'Refresh off'}</option>
          ))}
        </select>
      </label>
      <button type="button" className="btn btn-secondary px-3 py-1.5 text-sm" onClick={onRefresh} aria-label="Refresh now" title="Refresh now">
        <RefreshCw aria-hidden="true" className="h-4 w-4" />
      </button>
      {editing && (
        <form
          className="flex w-full flex-wrap items-end gap-2 rounded-lg border border-gray-200 p-3 dark:border-robin-gray-700"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) return;
            onRangeChange({ kind: 'absolute', from: fromSeconds!, to: toSeconds! });
            setEditing(false);
          }}
        >
          <label className="text-sm">
            <span className="form-label">From</span>
            <input type="datetime-local" className="input py-1.5" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="text-sm">
            <span className="form-label">To</span>
            <input type="datetime-local" className="input py-1.5" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <button type="submit" className="btn btn-primary px-3 py-1.5 text-sm" disabled={!valid}>Apply</button>
          <button type="button" className="btn btn-secondary px-3 py-1.5 text-sm" onClick={() => setEditing(false)}>Cancel</button>
          {!valid && <span className="text-xs text-red-600 dark:text-red-400">The end must be after the start.</span>}
        </form>
      )}
    </div>
  );
}
