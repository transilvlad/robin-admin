/**
 * Table component with pagination.
 *
 * Optionally selectable: pass `selectable`, `selectedIds`,
 * `onSelectionChange`, and `getRowId` and a leading checkbox column is
 * rendered with select-all in the header. Click on the checkbox toggles
 * just that row; click on the row body still fires `onRowClick`.
 */

import { type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Spinner } from './Spinner';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render?: (item: T) => ReactNode;
  className?: string;
}

interface TableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyField: keyof T;
  pagination?: {
    page: number;
    totalPages: number;
    total: number;
    onPageChange: (page: number) => void;
  };
  isLoading?: boolean;
  emptyMessage?: string;
  onRowClick?: (item: T) => void;
  scrollLabel?: string;
  // Selection mode — opt-in. When `selectable` is true the table renders
  // a leading checkbox column. The parent owns the Set of selected ids
  // (controlled component) so it can render bulk-action bars and so the
  // selection survives paging / filter changes.
  selectable?: boolean;
  selectedIds?: Set<number>;
  onSelectionChange?: (ids: Set<number>) => void;
  getRowId?: (row: T) => number;
}

export function Table<T extends object>({
  columns,
  data,
  keyField,
  pagination,
  isLoading,
  emptyMessage = 'No data found',
  onRowClick,
  scrollLabel = 'Data table',
  selectable,
  selectedIds,
  onSelectionChange,
  getRowId,
}: TableProps<T>) {
  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner className="text-robin-orange" />
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500 dark:text-gray-400">
        {emptyMessage}
      </div>
    );
  }

  const showCheckboxes = selectable && selectedIds && onSelectionChange && getRowId;
  const visibleIds = showCheckboxes ? data.map(getRowId) : [];
  const allVisibleSelected =
    showCheckboxes && visibleIds.length > 0 && visibleIds.every((id) => selectedIds!.has(id));
  const someVisibleSelected =
    showCheckboxes && visibleIds.some((id) => selectedIds!.has(id)) && !allVisibleSelected;

  const toggleAll = () => {
    if (!showCheckboxes) return;
    const next = new Set(selectedIds);
    if (allVisibleSelected) {
      visibleIds.forEach((id) => next.delete(id));
    } else {
      visibleIds.forEach((id) => next.add(id));
    }
    onSelectionChange!(next);
  };

  const toggleRow = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!showCheckboxes) return;
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange!(next);
  };

  return (
    <div>
      <div className="table-container" role="region" aria-label={scrollLabel} tabIndex={0}>
        <table className="table">
          <thead>
            <tr>
              {showCheckboxes && (
                <th className="w-10">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !!someVisibleSelected;
                    }}
                    onChange={toggleAll}
                    onClick={(e) => e.stopPropagation()}
                    className="h-4 w-4 cursor-pointer accent-robin-orange"
                    aria-label="Select all"
                  />
                </th>
              )}
              {columns.map((col) => (
                <th key={col.key} className={col.className}>
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((item) => {
              const rowId = showCheckboxes ? getRowId!(item) : undefined;
              const isSelected = rowId !== undefined && selectedIds!.has(rowId);
              return (
                <tr
                  key={String(item[keyField])}
                  onClick={() => onRowClick?.(item)}
                  className={
                    (onRowClick ? 'cursor-pointer ' : '') +
                    (isSelected
                      ? 'bg-orange-50 dark:bg-robin-orange/10 '
                      : 'hover:bg-gray-50 dark:hover:bg-robin-gray-700/50')
                  }
                >
                  {showCheckboxes && (
                    <td className="w-10">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onClick={(e) => toggleRow(rowId!, e)}
                        onChange={() => { /* handled by onClick */ }}
                        className="h-4 w-4 cursor-pointer accent-robin-orange"
                        aria-label="Select row"
                      />
                    </td>
                  )}
                  {columns.map((col) => (
                    <td key={col.key} className={col.className}>
                      {col.render
                        ? col.render(item)
                        : String(item[col.key as keyof T] ?? '')}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 px-2">
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Showing page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => pagination.onPageChange(pagination.page - 1)}
              disabled={pagination.page <= 1}
              className="btn btn-secondary p-2 disabled:opacity-50"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="px-3 py-1 text-sm">
              {pagination.page} / {pagination.totalPages}
            </span>
            <button
              onClick={() => pagination.onPageChange(pagination.page + 1)}
              disabled={pagination.page >= pagination.totalPages}
              className="btn btn-secondary p-2 disabled:opacity-50"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
