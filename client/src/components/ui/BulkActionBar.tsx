import type { ReactNode } from 'react';

/** The strip of actions shown above a table while rows are selected. */
export function BulkActionBar({ count, children }: { count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-sm bg-gray-100 p-3 dark:bg-robin-gray-700">
      <span className="text-sm">{count} selected</span>
      {children}
    </div>
  );
}
