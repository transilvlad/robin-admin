import { useEffect, useMemo } from 'react';
import type { MetricTab } from '../components/ui/MetricTabs';
import { useServiceCapabilities } from '../context/FeaturesContext';

/**
 * A page's tabs, less those the selected service's setup can't support.
 * `needs` (a module constant) maps a tab to the capability it requires; when
 * the open tab goes away, e.g. another service was picked, the page falls
 * back to the first tab.
 */
export function useCapableTabs<T extends string>(
  tabs: readonly MetricTab<T>[],
  needs: Partial<Record<T, string>>,
  serviceId: string | null | undefined,
  tab: T,
  setTab: (tab: T) => void,
): MetricTab<T>[] {
  const { can } = useServiceCapabilities(serviceId);
  const visible = useMemo(
    () => tabs.filter((entry) => {
      const capability = needs[entry.id];
      return !capability || can(capability);
    }),
    [can, needs, tabs],
  );
  useEffect(() => {
    if (visible.length > 0 && !visible.some((entry) => entry.id === tab)) setTab(visible[0].id);
  }, [setTab, tab, visible]);
  return visible;
}
