import { useCallback, useLayoutEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

export type SearchParamsUpdate = (change: (next: URLSearchParams) => void, replace?: boolean) => void;

/**
 * useSearchParams with an updater that edits the current URL. React Router
 * hands a functional setSearchParams the params of the render that created
 * it, so a load that finishes after the user picked something (a time range,
 * a new query editor) would write the old values back over their choice.
 */
export function useSearchParamsUpdater(): [URLSearchParams, SearchParamsUpdate] {
  const [params, setParams] = useSearchParams();
  const latest = useRef(params);
  useLayoutEffect(() => {
    latest.current = params;
  }, [params]);

  const update = useCallback<SearchParamsUpdate>((change, replace = false) => {
    const next = new URLSearchParams(latest.current);
    change(next);
    // Several updates before the next render build on each other.
    latest.current = next;
    setParams(next, { replace });
  }, [setParams]);

  return [params, update];
}
