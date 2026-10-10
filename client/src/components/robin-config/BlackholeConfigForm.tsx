/**
 * Blackhole configuration form (blackhole.json5).
 */

import { useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { ConfigSection } from './ConfigSection';
import { TextField, ToggleField } from './ConfigField';
import type { BlackholeConfig, BlackholeRule } from '../../types/robin-config';

interface BlackholeConfigFormProps {
  config: Partial<BlackholeConfig>;
  onChange: (config: Partial<BlackholeConfig>) => void;
  baseConfig?: Partial<BlackholeConfig>;
  disabled?: boolean;
}

function BlackholeRuleEditor({
  rule,
  onChange,
  onDelete,
  disabled,
}: {
  rule: BlackholeRule;
  onChange: (rule: BlackholeRule) => void;
  onDelete: () => void;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);

  const update = <K extends keyof BlackholeRule>(key: K, value: BlackholeRule[K]) => {
    onChange({ ...rule, [key]: value });
  };

  // Summary of rule conditions
  const summary = [
    rule.ip && `IP: ${rule.ip}`,
    rule.ehlo && `EHLO: ${rule.ehlo}`,
    rule.mail && `FROM: ${rule.mail}`,
    rule.rcpt && `TO: ${rule.rcpt}`,
  ].filter(Boolean).join(', ') || 'Empty rule';

  return (
    <div className="border border-gray-200 dark:border-robin-gray-700 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 p-3 bg-gray-50 dark:bg-robin-gray-900">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-gray-400 hover:text-gray-600"
        >
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <span className="flex-1 text-sm font-mono truncate text-gray-600 dark:text-gray-300">
          {summary}
        </span>
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled}
          className="p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-sm"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
      {expanded && (
        <div className="p-4 space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            All specified conditions must match (AND logic). Leave blank to match any value.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <TextField
              label="IP Pattern"
              value={rule.ip ?? ''}
              onChange={(v) => update('ip', v || undefined)}
              help="Regex pattern to match client IP"
              placeholder="192\.168\.1\..*"
              disabled={disabled}
            />
            <TextField
              label="EHLO Pattern"
              value={rule.ehlo ?? ''}
              onChange={(v) => update('ehlo', v || undefined)}
              help="Regex pattern to match EHLO domain"
              placeholder=".*\.suspicious\.com"
              disabled={disabled}
            />
            <TextField
              label="MAIL FROM Pattern"
              value={rule.mail ?? ''}
              onChange={(v) => update('mail', v || undefined)}
              help="Regex pattern to match sender address"
              placeholder="spammer@.*"
              disabled={disabled}
            />
            <TextField
              label="RCPT TO Pattern"
              value={rule.rcpt ?? ''}
              onChange={(v) => update('rcpt', v || undefined)}
              help="Regex pattern to match recipient address"
              placeholder=".*@spam-trap\.example\.com"
              disabled={disabled}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export function BlackholeConfigForm({ config, onChange, disabled }: BlackholeConfigFormProps) {
  const rules = config.rules ?? [];

  const update = <K extends keyof BlackholeConfig>(key: K, value: BlackholeConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  const addRule = () => {
    update('rules', [
      ...rules,
      {
        rcpt: '.*@spam-trap\\.example\\.com',
      },
    ]);
  };

  const updateRule = (index: number, rule: BlackholeRule) => {
    const newRules = [...rules];
    newRules[index] = rule;
    update('rules', newRules);
  };

  const deleteRule = (index: number) => {
    update('rules', rules.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-4">
      <ConfigSection title="Email blackhole" description="Accept but discard emails matching patterns">
        <ToggleField
          label="Enabled"
          value={config.enabled ?? false}
          onChange={(v) => update('enabled', v)}
          help="Enable blackhole functionality"
          disabled={disabled}
        />

        <div className="space-y-2 mt-4">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium">Rules</label>
            <button
              type="button"
              onClick={addRule}
              disabled={disabled}
              className="flex items-center gap-1 text-sm text-robin-orange hover:bg-robin-orange/10 px-2 py-1 rounded-sm"
            >
              <Plus className="w-4 h-4" />
              Add rule
            </button>
          </div>
          {rules.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center border border-dashed border-gray-300 dark:border-robin-gray-600 rounded-lg">
              No rules configured. Add a rule to start blackholing emails.
            </p>
          ) : (
            <div className="space-y-2">
              {rules.map((rule, index) => (
                <BlackholeRuleEditor
                  key={index}
                  rule={rule}
                  onChange={(r) => updateRule(index, r)}
                  onDelete={() => deleteRule(index)}
                  disabled={disabled}
                />
              ))}
            </div>
          )}
        </div>
      </ConfigSection>

      <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg space-y-2">
        <p className="text-sm font-medium text-yellow-700 dark:text-yellow-300">ℹ️ Blackhole Behavior:</p>
        <ul className="text-sm text-yellow-600 dark:text-yellow-400 list-disc list-inside space-y-1">
          <li>Emails are accepted with 250 OK but not saved to disk</li>
          <li>Webhooks are not triggered for blackholed emails</li>
          <li>All conditions within a rule must match (AND logic)</li>
          <li>Any matching rule triggers blackhole (OR logic between rules)</li>
          <li>All patterns are regular expressions</li>
        </ul>
      </div>
    </div>
  );
}
