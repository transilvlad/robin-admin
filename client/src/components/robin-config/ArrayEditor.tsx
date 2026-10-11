/**
 * Array editor for string arrays (IPs, patterns, etc.).
 */

import { Plus, Trash2 } from 'lucide-react';
import { ConfigField } from './ConfigField';

interface ArrayEditorProps {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
  help?: string;
  placeholder?: string;
  isOverridden?: boolean;
  disabled?: boolean;
}

export function ArrayEditor({
  label,
  value,
  onChange,
  help,
  placeholder = 'Enter value...',
  isOverridden,
  disabled,
}: ArrayEditorProps) {
  const addItem = () => {
    onChange([...value, '']);
  };

  const updateItem = (index: number, newValue: string) => {
    const updated = [...value];
    updated[index] = newValue;
    onChange(updated);
  };

  const removeItem = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  return (
    <ConfigField label={label} help={help} isOverridden={isOverridden}>
      <div className="space-y-2">
        {value.map((item, index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              type="text"
              value={item}
              onChange={(e) => updateItem(index, e.target.value)}
              placeholder={placeholder}
              disabled={disabled}
              className="input flex-1"
            />
            <button
              type="button"
              onClick={() => removeItem(index)}
              disabled={disabled}
              className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-sm"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addItem}
          disabled={disabled}
          className="flex items-center gap-1 text-sm text-robin-orange hover:text-robin-orange/80"
        >
          <Plus className="w-4 h-4" />
          Add entry
        </button>
      </div>
    </ConfigField>
  );
}

interface KeyValueEditorProps {
  label: string;
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  help?: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  isOverridden?: boolean;
  disabled?: boolean;
}

export function KeyValueEditor({
  label,
  value,
  onChange,
  help,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  isOverridden,
  disabled,
}: KeyValueEditorProps) {
  const entries = Object.entries(value);

  const addEntry = () => {
    const newKey = `key${entries.length + 1}`;
    onChange({ ...value, [newKey]: '' });
  };

  const updateKey = (oldKey: string, newKey: string) => {
    if (oldKey === newKey) return;
    const newValue: Record<string, string> = {};
    for (const [k, v] of entries) {
      newValue[k === oldKey ? newKey : k] = v;
    }
    onChange(newValue);
  };

  const updateValue = (key: string, newVal: string) => {
    onChange({ ...value, [key]: newVal });
  };

  const removeEntry = (key: string) => {
    const newValue = { ...value };
    delete newValue[key];
    onChange(newValue);
  };

  return (
    <ConfigField label={label} help={help} isOverridden={isOverridden}>
      <div className="space-y-2">
        {entries.map(([key, val]) => (
          <div key={key} className="flex items-center gap-2">
            <input
              type="text"
              value={key}
              onChange={(e) => updateKey(key, e.target.value)}
              placeholder={keyPlaceholder}
              disabled={disabled}
              className="input w-1/3"
            />
            <input
              type="text"
              value={val}
              onChange={(e) => updateValue(key, e.target.value)}
              placeholder={valuePlaceholder}
              disabled={disabled}
              className="input flex-1"
            />
            <button
              type="button"
              onClick={() => removeEntry(key)}
              disabled={disabled}
              className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-sm"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addEntry}
          disabled={disabled}
          className="flex items-center gap-1 text-sm text-robin-orange hover:text-robin-orange/80"
        >
          <Plus className="w-4 h-4" />
          Add entry
        </button>
      </div>
    </ConfigField>
  );
}
