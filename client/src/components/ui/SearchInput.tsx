import { Search } from 'lucide-react';

/** A text input with a leading search icon; filtering happens as you type. */
export function SearchInput({
  value,
  onChange,
  placeholder,
  className = 'w-72',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <div className="relative">
      <Search aria-hidden="true" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className={`input pl-10 ${className}`}
      />
    </div>
  );
}
