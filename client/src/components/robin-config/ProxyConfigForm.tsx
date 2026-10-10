import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { ConfigSection } from './ConfigSection';
import { ArrayEditor } from './ArrayEditor';
import { NumberField, SelectField, TextField, ToggleField } from './ConfigField';
import type { ProxyConfig, ProxyRuleConfig } from '../../types/robin-config';

interface ProxyConfigFormProps {
  config: Partial<ProxyConfig>;
  onChange: (config: Partial<ProxyConfig>) => void;
  baseConfig?: Partial<ProxyConfig>;
  disabled?: boolean;
}

const EMPTY_RULE: ProxyRuleConfig = {
  hosts: ['relay.example.com'],
  port: 25,
  protocol: 'esmtp',
  tls: false,
  direction: 'both',
  action: 'none',
  authMechanism: 'PLAIN',
};

function ProxyRuleEditor({
  rule,
  onChange,
  onDelete,
  disabled,
}: {
  rule: ProxyRuleConfig;
  onChange: (rule: ProxyRuleConfig) => void;
  onDelete: () => void;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);

  const update = <K extends keyof ProxyRuleConfig>(key: K, value: ProxyRuleConfig[K]) => {
    onChange({ ...rule, [key]: value });
  };

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-robin-gray-700">
      <div className="flex items-center gap-2 bg-gray-50 p-3 dark:bg-robin-gray-900">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-gray-900 dark:text-white">
            {rule.rcpt || rule.mail || rule.ehlo || rule.ip || 'New proxy rule'}
          </div>
          <div className="truncate text-xs text-gray-500 dark:text-gray-400">
            {(rule.hosts ?? []).join(', ') || 'No destination hosts configured'}
          </div>
        </div>
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled}
          className="rounded-sm p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {expanded && (
        <div className="space-y-4 p-4">
          <div className="grid gap-4 md:grid-cols-2">
            <TextField
              label="IP Pattern"
              value={rule.ip ?? ''}
              onChange={(value) => update('ip', value)}
              help="Regex for source IP match. Leave blank to match any IP."
              placeholder="192\\.168\\.1\\..*"
              disabled={disabled}
            />
            <TextField
              label="EHLO Pattern"
              value={rule.ehlo ?? ''}
              onChange={(value) => update('ehlo', value)}
              help="Regex for EHLO/HELO hostname."
              placeholder=".*\\.internal\\.com"
              disabled={disabled}
            />
            <TextField
              label="MAIL FROM Pattern"
              value={rule.mail ?? ''}
              onChange={(value) => update('mail', value)}
              help="Regex for sender match."
              placeholder=".*@source\\.example\\.com"
              disabled={disabled}
            />
            <TextField
              label="RCPT TO Pattern"
              value={rule.rcpt ?? ''}
              onChange={(value) => update('rcpt', value)}
              help="Regex for recipient match."
              placeholder=".*@destination\\.example\\.com"
              disabled={disabled}
            />
          </div>

          <ArrayEditor
            label="Destination hosts"
            value={rule.hosts ?? []}
            onChange={(value) => update('hosts', value)}
            help="SMTP/ESMTP/LMTP destination hosts. The first reachable host wins."
            placeholder="relay.example.com"
            disabled={disabled}
          />

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <NumberField
              label="Port"
              value={rule.port ?? 25}
              onChange={(value) => update('port', value)}
              min={1}
              max={65535}
              disabled={disabled}
            />
            <SelectField
              label="Protocol"
              value={rule.protocol ?? 'esmtp'}
              onChange={(value) => update('protocol', value as ProxyRuleConfig['protocol'])}
              options={[
                { value: 'smtp', label: 'SMTP' },
                { value: 'esmtp', label: 'ESMTP' },
                { value: 'lmtp', label: 'LMTP' },
              ]}
              disabled={disabled}
            />
            <SelectField
              label="Direction"
              value={rule.direction ?? 'both'}
              onChange={(value) => update('direction', value as ProxyRuleConfig['direction'])}
              options={[
                { value: 'both', label: 'Both' },
                { value: 'inbound', label: 'Inbound only' },
                { value: 'outbound', label: 'Outbound only' },
              ]}
              disabled={disabled}
            />
            <SelectField
              label="Non-matching Recipient Action"
              value={rule.action ?? 'none'}
              onChange={(value) => update('action', value as ProxyRuleConfig['action'])}
              options={[
                { value: 'none', label: 'Continue normal processing' },
                { value: 'accept', label: 'Accept locally' },
                { value: 'reject', label: 'Reject recipient' },
              ]}
              disabled={disabled}
            />
          </div>

          <ToggleField
            label="Use TLS"
            value={rule.tls ?? false}
            onChange={(value) => update('tls', value)}
            help="Enable TLS when proxying to the destination host."
            disabled={disabled}
          />

          <div className="grid gap-4 md:grid-cols-3">
            <TextField
              label="Auth username"
              value={rule.authUsername ?? ''}
              onChange={(value) => update('authUsername', value)}
              help="Optional SMTP AUTH username."
              disabled={disabled}
            />
            <TextField
              label="Auth password"
              type="password"
              value={rule.authPassword ?? ''}
              onChange={(value) => update('authPassword', value)}
              help="Optional SMTP AUTH password."
              disabled={disabled}
            />
            <TextField
              label="Auth mechanism"
              value={rule.authMechanism ?? 'PLAIN'}
              onChange={(value) => update('authMechanism', value)}
              help="Authentication mechanism. Robin docs currently describe PLAIN."
              disabled={disabled}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export function ProxyConfigForm({ config, onChange, disabled }: ProxyConfigFormProps) {
  const rules = config.rules ?? [];
  const enabled = config.enabled ?? false;

  const update = <K extends keyof ProxyConfig>(key: K, value: ProxyConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  const updateRule = (index: number, rule: ProxyRuleConfig) => {
    const next = [...rules];
    next[index] = rule;
    update('rules', next);
  };

  const addRule = () => {
    update('rules', [...rules, EMPTY_RULE]);
  };

  const removeRule = (index: number) => {
    update('rules', rules.filter((_, currentIndex) => currentIndex !== index));
  };

  return (
    <div className="space-y-4">
      <ConfigSection
        title="Proxy mode"
        description="Forward matching mail to another SMTP/ESMTP/LMTP destination instead of handling it locally"
        defaultExpanded={enabled}
      >
        <ToggleField
          label="Enable proxy mode"
          value={enabled}
          onChange={(value) => update('enabled', value)}
          help="Turns on rule-based proxying. Robin uses only the first matching rule."
          disabled={disabled}
        />
      </ConfigSection>

      <ConfigSection
        title="Proxy rules"
        description="Ordered rule list. Only the first matching rule is applied."
        defaultExpanded={enabled}
      >
        <div className="space-y-4">
          {rules.map((rule, index) => (
            <ProxyRuleEditor
              key={`${rule.rcpt ?? 'rule'}-${index}`}
              rule={rule}
              onChange={(value) => updateRule(index, value)}
              onDelete={() => removeRule(index)}
              disabled={disabled}
            />
          ))}

          <button
            type="button"
            onClick={addRule}
            disabled={disabled}
            className="flex items-center gap-2 rounded-lg px-4 py-2 text-robin-orange hover:bg-robin-orange/10"
          >
            <Plus className="h-4 w-4" />
            Add proxy rule
          </button>
        </div>
      </ConfigSection>

      <div className="rounded-lg bg-blue-50 p-4 text-sm text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
        Proxy rules are regex-based, evaluated in order, and reuse connections within the SMTP session for performance. Use TLS whenever proxy authentication is configured.
      </div>
    </div>
  );
}
