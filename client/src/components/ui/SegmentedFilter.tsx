export interface SegmentedFilterOption<T extends string> {
  value: T;
  label: string;
  /** Shown after the label when present and non-zero. */
  count?: number;
}

/**
 * A row of toggle buttons for picking one filter value — easier to scan and
 * click than a select when there are only a handful of options.
 */
export function SegmentedFilter<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly SegmentedFilterOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex rounded-lg border border-gray-200 p-1 dark:border-robin-gray-700">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${value === option.value ? 'bg-robin-orange text-white' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-robin-gray-800'}`}
        >
          {option.label}
          {option.count ? ` (${option.count})` : ''}
        </button>
      ))}
    </div>
  );
}
