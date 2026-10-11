/**
 * Reusable configuration section wrapper.
 */

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';

interface ConfigSectionProps {
  title: string;
  description?: React.ReactNode;
  defaultExpanded?: boolean;
  badge?: string;
  children: React.ReactNode;
}

export function ConfigSection({ title, description, defaultExpanded = true, badge, children }: ConfigSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  useEffect(() => {
    setExpanded(defaultExpanded);
  }, [defaultExpanded]);

  return (
    <div className="border border-gray-200 dark:border-robin-gray-700 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-3 p-4 bg-gray-50 dark:bg-robin-gray-900 hover:bg-gray-100 dark:hover:bg-robin-gray-800 transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown className="w-5 h-5 text-gray-400" />
        ) : (
          <ChevronRight className="w-5 h-5 text-gray-400" />
        )}
        <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-medium">{title}</h3>
            {description && (
              <p className="text-sm text-gray-500 dark:text-gray-400">{description}</p>
            )}
          </div>
          {badge && (
            <span className="ml-auto shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-300">
              {badge}
            </span>
          )}
        </div>
      </button>
      {expanded && (
        <div className="p-4 space-y-4">
          {children}
        </div>
      )}
    </div>
  );
}
