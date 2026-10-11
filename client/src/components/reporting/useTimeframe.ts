/**
 * URL-persisted reporting timeframe.
 *
 * Every reporting v2 screen reads its window from here so that two screens
 * opened side by side can never describe different periods — the defect that
 * produced "all clear" on the overview while the issue list claimed work was
 * outstanding.
 *
 * When `from`/`to` are absent the server picks the window from the actual
 * extent of the data (never `now()`), and reports back what it chose.
 */

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { TimeframeQuery } from '../../types/reporting';

export interface UseTimeframeResult {
  /** Query to hand to any reportingApi call. */
  query: TimeframeQuery;
  from: string;
  to: string;
  /** True when the user has not chosen a window and the server is deciding. */
  defaulted: boolean;
  setRange: (from: string, to: string) => void;
  clear: () => void;
}

export function useTimeframe(): UseTimeframeResult {
  const [searchParams, setSearchParams] = useSearchParams();
  const from = searchParams.get('from') ?? '';
  const to = searchParams.get('to') ?? '';

  const setRange = useCallback(
    (nextFrom: string, nextTo: string) => {
      const next = new URLSearchParams(searchParams);
      if (nextFrom) next.set('from', nextFrom);
      else next.delete('from');
      if (nextTo) next.set('to', nextTo);
      else next.delete('to');
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  const clear = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('from');
    next.delete('to');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const query = useMemo<TimeframeQuery>(
    () => ({ from: from || undefined, to: to || undefined }),
    [from, to]
  );

  return { query, from, to, defaulted: !from && !to, setRange, clear };
}
