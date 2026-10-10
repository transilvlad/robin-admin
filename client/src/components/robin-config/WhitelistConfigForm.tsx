/**
 * Whitelist configuration form (whitelist.json5).
 */

import { ConfigSection } from './ConfigSection';
import { ToggleField } from './ConfigField';
import { ArrayEditor } from './ArrayEditor';
import type { WhitelistConfig } from '../../types/robin-config';

interface WhitelistConfigFormProps {
  config: Partial<WhitelistConfig>;
  onChange: (config: Partial<WhitelistConfig>) => void;
  baseConfig?: Partial<WhitelistConfig>;
  disabled?: boolean;
}

export function WhitelistConfigForm({ config, onChange, disabled }: WhitelistConfigFormProps) {
  const update = <K extends keyof WhitelistConfig>(key: K, value: WhitelistConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  return (
    <div className="space-y-4">
      <ConfigSection title="IP Whitelist" description="Bypass security checks for trusted IP addresses">
        <ToggleField
          label="Enabled"
          value={config.enabled ?? false}
          onChange={(v) => update('enabled', v)}
          help="Enable IP whitelist functionality"
          disabled={disabled}
        />

        <ArrayEditor
          label="Whitelisted IPs"
          value={config.entries ?? []}
          onChange={(v) => update('entries', v)}
          help="IP addresses and CIDR blocks that bypass rate limits, DoS limits, and RBL checks"
          placeholder="192.168.1.0/24"
          disabled={disabled}
        />
      </ConfigSection>

      <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg space-y-2">
        <p className="text-sm font-medium text-blue-700 dark:text-blue-300">Whitelist Effects:</p>
        <ul className="text-sm text-blue-600 dark:text-blue-400 list-disc list-inside space-y-1">
          <li>Bypasses rate limiting checks</li>
          <li>Bypasses DoS connection limits</li>
          <li>Bypasses RBL (DNSBL) checks</li>
        </ul>
        <p className="text-xs text-blue-500 dark:text-blue-500 mt-2">
          Supports CIDR notation (e.g., 10.0.0.0/8) and IPv6 addresses.
        </p>
      </div>
    </div>
  );
}
