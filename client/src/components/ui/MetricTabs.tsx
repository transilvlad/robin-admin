import type { LucideIcon } from 'lucide-react';

export interface MetricTab<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
}

interface MetricTabsProps<T extends string> {
  tabs: readonly MetricTab<T>[];
  activeTab: T;
  onChange: (tab: T) => void;
}

export function MetricTabs<T extends string>({ tabs, activeTab, onChange }: MetricTabsProps<T>) {
  return (
    <div className="mb-6 flex flex-wrap gap-1 border-b border-gray-200 dark:border-robin-gray-700">
      {tabs.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
            activeTab === id
              ? 'border-robin-orange text-robin-orange'
              : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
          }`}
        >
          <Icon aria-hidden="true" className="h-4 w-4" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
