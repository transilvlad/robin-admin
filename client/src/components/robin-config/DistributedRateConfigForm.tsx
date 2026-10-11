/**
 * Distributed Rate Limiting configuration form (distributed-rate.json5).
 */

import { ConfigSection } from './ConfigSection';
import { TextField, NumberField, ToggleField } from './ConfigField';
import type { DistributedRateConfig } from '../../types/robin-config';

interface DistributedRateConfigFormProps {
  config: Partial<DistributedRateConfig>;
  onChange: (config: Partial<DistributedRateConfig>) => void;
  baseConfig?: Partial<DistributedRateConfig>;
  disabled?: boolean;
}

export function DistributedRateConfigForm({ config, onChange, disabled }: DistributedRateConfigFormProps) {
  const update = <K extends keyof DistributedRateConfig>(key: K, value: DistributedRateConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  return (
    <div className="space-y-4">
      <ConfigSection title="Distributed rate limiting" description="Redis-backed connection state sharing for multi-server deployments">
        <ToggleField
          label="Enabled"
          value={config.enabled ?? false}
          onChange={(v) => update('enabled', v)}
          help="Enable distributed rate limiting via Redis"
          disabled={disabled}
        />
      </ConfigSection>

      <ConfigSection title="Redis connection" description="Configure Redis server connection">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TextField
            label="Host"
            value={config.host ?? ''}
            onChange={(v) => update('host', v)}
            help="Redis server hostname"
            placeholder="localhost"
            disabled={disabled}
          />
          <NumberField
            label="Port"
            value={config.port ?? 6379}
            onChange={(v) => update('port', v)}
            help="Redis server port"
            min={1}
            max={65535}
            disabled={disabled}
          />
        </div>

        <TextField
          label="Password"
          value={config.password ?? ''}
          onChange={(v) => update('password', v)}
          help="Redis password (leave empty if authentication is not required)"
          type="password"
          disabled={disabled}
        />
      </ConfigSection>

      <ConfigSection title="Connection pool" description="Redis connection pool settings">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TextField
            label="Key prefix"
            value={config.keyPrefix ?? ''}
            onChange={(v) => update('keyPrefix', v)}
            help="Prefix applied to all Redis keys written by this store"
            placeholder="robin:conn:"
            disabled={disabled}
          />
          <NumberField
            label="Pool max total"
            value={config.poolMaxTotal ?? 10}
            onChange={(v) => update('poolMaxTotal', v)}
            help="Maximum connections in the Jedis connection pool"
            min={1}
            max={100}
            disabled={disabled}
          />
        </div>

        <NumberField
          label="Key TTL"
          value={config.keyTtlSeconds ?? 600}
          onChange={(v) => update('keyTtlSeconds', v)}
          help="TTL (seconds) applied to Redis keys to prevent unbounded memory growth"
          suffix="s"
          min={60}
          max={86400}
          disabled={disabled}
        />
      </ConfigSection>

      <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg space-y-2">
        <p className="text-sm font-medium text-blue-700 dark:text-blue-300">Distributed Rate Limiting:</p>
        <p className="text-sm text-blue-600 dark:text-blue-400">
          When enabled, connection state is shared across all Robin cluster nodes via Redis.
          Without this, each Robin instance maintains its own counters.
        </p>
        <p className="text-xs text-blue-500 dark:text-blue-500 mt-1">
          Compatible with Redis 5.0+. Recommended for production deployments with multiple Robin instances.
        </p>
      </div>
    </div>
  );
}
