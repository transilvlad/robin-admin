/**
 * Generic JSON config editor for configs without specific forms.
 */

import { useState, useEffect, useRef } from 'react';
import { AlertCircle } from 'lucide-react';

interface JsonConfigFormProps {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  disabled?: boolean;
}

export function JsonConfigForm({ config, onChange, disabled }: JsonConfigFormProps) {
  const [jsonText, setJsonText] = useState(() => JSON.stringify(config, null, 2));
  const [error, setError] = useState('');
  // The last config we emitted via onChange. Lets the sync effect tell our own
  // edit's echo (skip — keeps the caret where the user is typing) from an
  // external change like switching files or reloading (reformat the textarea).
  const lastEmittedRef = useRef<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (config === lastEmittedRef.current) return;
    const next = JSON.stringify(config, null, 2);
    // Value-equal to what we emitted (a parent that clones) is still our echo.
    if (lastEmittedRef.current && next === JSON.stringify(lastEmittedRef.current, null, 2)) return;
    setJsonText(next);
    setError('');
  }, [config]);

  const handleChange = (text: string) => {
    setJsonText(text);
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      setError('');
      lastEmittedRef.current = parsed;
      onChange(parsed);
    } catch (e) {
      setError('Invalid JSON');
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Edit the raw JSON configuration below. Changes are validated in real-time.
        </p>
        {error && (
          <p className="text-sm text-red-500 flex items-center gap-1">
            <AlertCircle className="w-4 h-4" />
            {error}
          </p>
        )}
      </div>
      <textarea
        value={jsonText}
        onChange={(e) => handleChange(e.target.value)}
        disabled={disabled}
        rows={25}
        className={`input w-full font-mono text-sm ${error ? 'border-red-500' : ''}`}
        spellCheck={false}
      />
    </div>
  );
}
