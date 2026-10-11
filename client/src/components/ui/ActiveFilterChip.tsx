import { X } from 'lucide-react';

interface ActiveFilterChipProps {
  label: string;
  onClear: () => void;
}

export function ActiveFilterChip({ label, onClear }: ActiveFilterChipProps) {
  return (
    <button
      type="button"
      onClick={onClear}
      aria-label={`Clear ${label} filter`}
      className="rounded-full bg-gray-100 px-3 py-1 text-sm text-gray-700 transition-colors hover:bg-gray-200 dark:bg-robin-gray-800 dark:text-gray-200 dark:hover:bg-robin-gray-700"
    >
      <span>{label}</span>
      <X aria-hidden="true" className="ml-1 inline h-3.5 w-3.5 text-gray-400" />
    </button>
  );
}
