import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

interface MultiSelectProps {
  label: string;
  options: string[];
  /** Selected values; empty means all. */
  value: string[];
  onChange: (value: string[]) => void;
}

/** A compact checkbox dropdown where no selection means "All". */
export function MultiSelect({ label, options, value, onChange }: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const summary = value.length === 0 ? 'All' : value.length === 1 ? value[0] : `${value.length} selected`;
  const visible = options.filter((option) => option.toLowerCase().includes(filter.toLowerCase()));
  const toggle = (option: string) => {
    onChange(value.includes(option) ? value.filter((item) => item !== option) : [...value, option]);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className="input flex w-auto min-w-36 items-center justify-between gap-2 py-1.5 text-left text-sm"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${summary}`}
      >
        <span className="truncate">{summary}</span>
        <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-gray-500" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-64 rounded-lg border border-gray-200 bg-white p-2 shadow-lg dark:border-robin-gray-700 dark:bg-robin-gray-800">
          {options.length > 8 && (
            <input
              className="input mb-2 py-1 text-sm"
              placeholder="Filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              aria-label={`Filter ${label}`}
            />
          )}
          <button
            type="button"
            className="mb-1 w-full rounded-sm px-2 py-1 text-left text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-robin-gray-700"
            onClick={() => onChange([])}
          >
            All
          </button>
          <ul role="listbox" aria-multiselectable="true" aria-label={label} className="max-h-60 overflow-y-auto">
            {visible.map((option) => (
              <li key={option}>
                <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm hover:bg-gray-100 dark:hover:bg-robin-gray-700">
                  <input type="checkbox" checked={value.includes(option)} onChange={() => toggle(option)} />
                  <span className="truncate">{option}</span>
                </label>
              </li>
            ))}
            {visible.length === 0 && <li className="px-2 py-1 text-sm text-gray-500">No matches</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
