/**
 * Browse metrics, their labels and label values, and insert a selector such as
 * `up{instance="node-a.example.test"}` into a query.
 */

import { useEffect, useState } from 'react';
import { ApiError, telemetryApi } from '../../api/client';
import { Spinner } from '../ui/Spinner';

interface LabelBrowserProps {
  metricNames: string[];
  start: number;
  end: number;
  onInsert: (selector: string) => void;
}

export function LabelBrowser({ metricNames, start, end, onInsert }: LabelBrowserProps) {
  const [filter, setFilter] = useState('');
  const [metric, setMetric] = useState<string | null>(null);
  const [labels, setLabels] = useState<string[] | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [values, setValues] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLabels(null);
    setLabel(null);
    setError(null);
    if (!metric) return;
    let cancelled = false;
    telemetryApi.labelNames({ match: metric, start, end })
      .then((response) => { if (!cancelled) setLabels(response.data ?? []); })
      .catch((err: unknown) => { if (!cancelled) { setLabels([]); setError(err instanceof ApiError ? err.message : 'Failed to load labels'); } });
    return () => { cancelled = true; };
  }, [metric, start, end]);

  useEffect(() => {
    setValues(null);
    if (!metric || !label) return;
    setError(null);
    let cancelled = false;
    telemetryApi.labelValues(label, { match: metric, start, end })
      .then((response) => { if (!cancelled) setValues(response.data ?? []); })
      .catch((err: unknown) => { if (!cancelled) { setValues([]); setError(err instanceof ApiError ? err.message : 'Failed to load values'); } });
    return () => { cancelled = true; };
  }, [metric, label, start, end]);

  const shown = metricNames.filter((name) => name.toLowerCase().includes(filter.toLowerCase())).slice(0, 200);
  const list = 'max-h-56 overflow-y-auto rounded-sm border border-gray-200 dark:border-robin-gray-700';
  const item = (active: boolean) => `block w-full truncate px-2 py-1 text-left font-mono text-xs hover:bg-gray-100 dark:hover:bg-robin-gray-700 ${active ? 'bg-orange-50 text-robin-orange dark:bg-robin-orange/10' : ''}`;

  return (
    <div className="grid gap-3 md:grid-cols-3">
      <div>
        <input className="input mb-2 py-1 text-sm" placeholder="Filter metrics" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter metrics" />
        <div className={list} role="listbox" aria-label="Metrics">
          {shown.map((name) => (
            <button key={name} type="button" role="option" aria-selected={metric === name} className={item(metric === name)} onClick={() => setMetric(name)} onDoubleClick={() => onInsert(name)}>
              {name}
            </button>
          ))}
          {shown.length === 0 && <p className="px-2 py-1 text-xs text-gray-500">No metrics</p>}
        </div>
      </div>
      <div>
        <p className="mb-2 py-1 text-xs text-gray-500 dark:text-gray-400">{metric ? `Labels of ${metric}` : 'Pick a metric'}</p>
        <div className={list} role="listbox" aria-label="Labels">
          {metric && !labels && <div className="flex justify-center p-2"><Spinner size="sm" label="Loading labels" /></div>}
          {labels?.map((name) => (
            <button key={name} type="button" role="option" aria-selected={label === name} className={item(label === name)} onClick={() => setLabel(name)}>
              {name}
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="mb-2 py-1 text-xs text-gray-500 dark:text-gray-400">{label ? `Values of ${label}` : 'Pick a label'}</p>
        <div className={list} role="listbox" aria-label="Values">
          {label && !values && <div className="flex justify-center p-2"><Spinner size="sm" label="Loading values" /></div>}
          {values?.map((value) => (
            <button key={value} type="button" role="option" aria-selected={false} className={item(false)} onClick={() => onInsert(`${metric}{${label}=${JSON.stringify(value)}}`)}>
              {value}
            </button>
          ))}
        </div>
      </div>
      {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400 md:col-span-3">{error}</p>}
    </div>
  );
}
