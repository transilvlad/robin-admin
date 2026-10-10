/**
 * Blocklist configuration form (blocklist.json5).
 */

import { AlertTriangle } from 'lucide-react';
import { ConfigSection } from './ConfigSection';
import { ToggleField } from './ConfigField';
import { ArrayEditor } from './ArrayEditor';
import type { BlocklistConfig } from '../../types/robin-config';

interface BlocklistConfigFormProps {
  config: Partial<BlocklistConfig>;
  onChange: (config: Partial<BlocklistConfig>) => void;
  baseConfig?: Partial<BlocklistConfig>;
  disabled?: boolean;
}

export function BlocklistConfigForm({ config, onChange, disabled }: BlocklistConfigFormProps) {
  const update = <K extends keyof BlocklistConfig>(key: K, value: BlocklistConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  return (
    <div className="space-y-4">
      <ConfigSection title="IP Blocklist" description="Block connections from specific IP addresses">
        <ToggleField
          label="Enabled"
          value={config.enabled ?? false}
          onChange={(v) => update('enabled', v)}
          help="Enable IP blocklist functionality"
          disabled={disabled}
        />

        <ArrayEditor
          label="Blocked IPs"
          value={config.entries ?? []}
          onChange={(v) => update('entries', v)}
          help="IP addresses and CIDR blocks to block immediately on connection"
          placeholder="1.2.3.4"
          disabled={disabled}
        />
      </ConfigSection>

      <div className="p-4 bg-red-50 dark:bg-red-900/20 rounded-lg space-y-2">
        <p className="flex items-center gap-2 text-sm font-medium text-red-700 dark:text-red-300">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          Blocklist Behavior:
        </p>
        <p className="text-sm text-red-600 dark:text-red-400">
          Connections from blocked IPs are immediately rejected before any SMTP commands are processed.
        </p>
        <p className="text-xs text-red-500 dark:text-red-500 mt-2">
          Supports CIDR notation (e.g., 1.2.3.0/24) and IPv6 addresses.
        </p>
      </div>
    </div>
  );
}
