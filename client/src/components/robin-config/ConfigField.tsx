/**
 * Configuration field wrapper with label, help text, and override indicator.
 */

import { HelpCircle, AlertCircle } from 'lucide-react';
import { useState } from 'react';

interface ConfigFieldProps {
  label: string;
  help?: string;
  required?: boolean;
  isOverridden?: boolean;
  error?: string;
  children: React.ReactNode;
}

export function ConfigField({ label, help, required, isOverridden, error, children }: ConfigFieldProps) {
  const [showHelp, setShowHelp] = useState(false);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
        {isOverridden && (
          <span className="text-xs bg-robin-orange/20 text-robin-orange px-2 py-0.5 rounded-sm">
            Override
          </span>
        )}
        {help && (
          <button
            type="button"
            onClick={() => setShowHelp(!showHelp)}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <HelpCircle className="w-4 h-4" />
          </button>
        )}
      </div>
      {showHelp && help && (
        <p className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-robin-gray-900 p-2 rounded-sm">
          {help}
        </p>
      )}
      {children}
      {error && (
        <p className="text-xs text-red-500 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" />
          {error}
        </p>
      )}
    </div>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  help?: string;
  placeholder?: string;
  required?: boolean;
  isOverridden?: boolean;
  disabled?: boolean;
  type?: 'text' | 'password' | 'url';
}

export function TextField({
  label,
  value,
  onChange,
  help,
  placeholder,
  required,
  isOverridden,
  disabled,
  type = 'text',
}: TextFieldProps) {
  return (
    <ConfigField label={label} help={help} required={required} isOverridden={isOverridden}>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="input w-full"
      />
    </ConfigField>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  isOverridden?: boolean;
  disabled?: boolean;
  suffix?: string;
}

export function NumberField({
  label,
  value,
  onChange,
  help,
  min,
  max,
  step = 1,
  required,
  isOverridden,
  disabled,
  suffix,
}: NumberFieldProps) {
  return (
    <ConfigField label={label} help={help} required={required} isOverridden={isOverridden}>
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          className="input w-full"
        />
        {suffix && (
          <span className="text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">{suffix}</span>
        )}
      </div>
    </ConfigField>
  );
}

interface ToggleFieldProps {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  help?: string;
  isOverridden?: boolean;
  disabled?: boolean;
}

export function ToggleField({
  label,
  value,
  onChange,
  help,
  isOverridden,
  disabled,
}: ToggleFieldProps) {
  return (
    <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-robin-gray-900 rounded-lg">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{label}</span>
        {isOverridden && (
          <span className="text-xs bg-robin-orange/20 text-robin-orange px-2 py-0.5 rounded-sm">
            Override
          </span>
        )}
        {help && (
          <span className="text-xs text-gray-500 dark:text-gray-400">— {help}</span>
        )}
      </div>
      <button
        type="button"
        onClick={() => !disabled && onChange(!value)}
        disabled={disabled}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          value ? 'bg-robin-orange' : 'bg-gray-300 dark:bg-robin-gray-600'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            value ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
}

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  help?: string;
  required?: boolean;
  isOverridden?: boolean;
  disabled?: boolean;
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  help,
  required,
  isOverridden,
  disabled,
}: SelectFieldProps) {
  return (
    <ConfigField label={label} help={help} required={required} isOverridden={isOverridden}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="input w-full"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </ConfigField>
  );
}

interface TextAreaFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  help?: string;
  placeholder?: string;
  rows?: number;
  required?: boolean;
  isOverridden?: boolean;
  disabled?: boolean;
}

export function TextAreaField({
  label,
  value,
  onChange,
  help,
  placeholder,
  rows = 3,
  required,
  isOverridden,
  disabled,
}: TextAreaFieldProps) {
  return (
    <ConfigField label={label} help={help} required={required} isOverridden={isOverridden}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        className="input w-full font-mono text-sm"
      />
    </ConfigField>
  );
}
