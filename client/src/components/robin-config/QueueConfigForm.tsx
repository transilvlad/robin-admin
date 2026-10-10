/**
 * Queue configuration form (queue.json5).
 */

import { ConfigSection } from './ConfigSection';
import { TextField, NumberField, ToggleField } from './ConfigField';
import type { QueueConfig } from '../../types/robin-config';

interface QueueConfigFormProps {
  config: Partial<QueueConfig>;
  onChange: (config: Partial<QueueConfig>) => void;
  baseConfig?: Partial<QueueConfig>;
  disabled?: boolean;
}

export function QueueConfigForm({ config, onChange, baseConfig, disabled }: QueueConfigFormProps) {
  const update = <K extends keyof QueueConfig>(key: K, value: QueueConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  const isOverridden = (key: keyof QueueConfig) => 
    baseConfig && config[key] !== undefined && JSON.stringify(config[key]) !== JSON.stringify(baseConfig[key]);

  return (
    <div className="space-y-4">
      <ConfigSection title="Queue processing" description="Cron job settings for queue processing">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <NumberField
            label="Initial delay"
            value={config.queueInitialDelay ?? 10}
            onChange={(v) => update('queueInitialDelay', v)}
            help="Queue cron initial run delay in seconds"
            suffix="sec"
            min={0}
            disabled={disabled}
            isOverridden={isOverridden('queueInitialDelay')}
          />
          <NumberField
            label="Processing interval"
            value={config.queueInterval ?? 30}
            onChange={(v) => update('queueInterval', v)}
            help="Queue cron processing interval in seconds"
            suffix="sec"
            min={1}
            disabled={disabled}
            isOverridden={isOverridden('queueInterval')}
          />
          <NumberField
            label="Max dequeue per tick"
            value={config.maxDequeuePerTick ?? 10}
            onChange={(v) => update('maxDequeuePerTick', v)}
            help="Maximum messages to attempt to relay per cron tick"
            min={1}
            disabled={disabled}
            isOverridden={isOverridden('maxDequeuePerTick')}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="MapDB Backend" description="File-based queue persistence (default)" defaultExpanded={config.queueMapDB?.enabled ?? true}>
        <ToggleField
          label="MapDB Enabled"
          value={config.queueMapDB?.enabled ?? true}
          onChange={(v) => update('queueMapDB', { ...config.queueMapDB, enabled: v })}
          help="Enable MapDB for file-based queue persistence"
          disabled={disabled}
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <TextField
            label="Queue file"
            value={config.queueMapDB?.queueFile ?? '/usr/local/robin/relayQueue.db'}
            onChange={(v) => update('queueMapDB', { ...config.queueMapDB, queueFile: v })}
            help="Path to queue file for persisting undelivered messages"
            placeholder="/usr/local/robin/relayQueue.db"
            disabled={disabled}
          />
          <NumberField
            label="Concurrency scale"
            value={config.queueMapDB?.concurrencyScale ?? 32}
            onChange={(v) => update('queueMapDB', { ...config.queueMapDB, concurrencyScale: v })}
            help="MapDB concurrency scale (defaults to 32)"
            min={1}
            max={128}
            disabled={disabled}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="Redis backend" description="Redis-based queue (AWS Elasticache compatible)" defaultExpanded={config.queueRedis?.enabled ?? false}>
        <ToggleField
          label="Redis enabled"
          value={config.queueRedis?.enabled ?? false}
          onChange={(v) => update('queueRedis', { ...config.queueRedis, enabled: v })}
          help="Enable Redis for distributed queue persistence"
          disabled={disabled}
        />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
          <TextField
            label="Host"
            value={config.queueRedis?.host ?? 'localhost'}
            onChange={(v) => update('queueRedis', { ...config.queueRedis, host: v })}
            help="Redis server hostname or IP"
            placeholder="localhost"
            disabled={disabled}
          />
          <NumberField
            label="Port"
            value={config.queueRedis?.port ?? 6379}
            onChange={(v) => update('queueRedis', { ...config.queueRedis, port: v })}
            help="Redis server port"
            min={1}
            max={65535}
            disabled={disabled}
          />
          <TextField
            label="Queue key"
            value={config.queueRedis?.queueKey ?? 'robin:queue'}
            onChange={(v) => update('queueRedis', { ...config.queueRedis, queueKey: v })}
            help="Redis key name for the queue LIST"
            placeholder="robin:queue"
            disabled={disabled}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="MariaDB Backend" description="MariaDB-based queue persistence" defaultExpanded={config.queueMariaDB?.enabled ?? false}>
        <ToggleField
          label="MariaDB Enabled"
          value={config.queueMariaDB?.enabled ?? false}
          onChange={(v) => update('queueMariaDB', { ...config.queueMariaDB, enabled: v })}
          help="Enable MariaDB for queue persistence"
          disabled={disabled}
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <TextField
            label="JDBC URL"
            value={config.queueMariaDB?.jdbcUrl ?? ''}
            onChange={(v) => update('queueMariaDB', { ...config.queueMariaDB, jdbcUrl: v })}
            help="MariaDB JDBC connection URL"
            placeholder="jdbc:mariadb://localhost:3306/robin"
            disabled={disabled}
          />
          <TextField
            label="Table name"
            value={config.queueMariaDB?.tableName ?? 'queue'}
            onChange={(v) => update('queueMariaDB', { ...config.queueMariaDB, tableName: v })}
            help="Queue table name"
            placeholder="queue"
            disabled={disabled}
          />
          <TextField
            label="Username"
            value={config.queueMariaDB?.username ?? ''}
            onChange={(v) => update('queueMariaDB', { ...config.queueMariaDB, username: v })}
            placeholder="robin"
            disabled={disabled}
          />
          <TextField
            label="Password"
            value={config.queueMariaDB?.password ?? ''}
            onChange={(v) => update('queueMariaDB', { ...config.queueMariaDB, password: v })}
            type="password"
            disabled={disabled}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="PostgreSQL Backend" description="PostgreSQL-based queue persistence" defaultExpanded={config.queuePgSQL?.enabled ?? false}>
        <ToggleField
          label="PostgreSQL Enabled"
          value={config.queuePgSQL?.enabled ?? false}
          onChange={(v) => update('queuePgSQL', { ...config.queuePgSQL, enabled: v })}
          help="Enable PostgreSQL for queue persistence"
          disabled={disabled}
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <TextField
            label="JDBC URL"
            value={config.queuePgSQL?.jdbcUrl ?? ''}
            onChange={(v) => update('queuePgSQL', { ...config.queuePgSQL, jdbcUrl: v })}
            help="PostgreSQL JDBC connection URL"
            placeholder="jdbc:postgresql://localhost:5432/robin"
            disabled={disabled}
          />
          <TextField
            label="Table name"
            value={config.queuePgSQL?.tableName ?? 'queue'}
            onChange={(v) => update('queuePgSQL', { ...config.queuePgSQL, tableName: v })}
            help="Queue table name"
            placeholder="queue"
            disabled={disabled}
          />
          <TextField
            label="Username"
            value={config.queuePgSQL?.username ?? ''}
            onChange={(v) => update('queuePgSQL', { ...config.queuePgSQL, username: v })}
            placeholder="robin"
            disabled={disabled}
          />
          <TextField
            label="Password"
            value={config.queuePgSQL?.password ?? ''}
            onChange={(v) => update('queuePgSQL', { ...config.queuePgSQL, password: v })}
            type="password"
            disabled={disabled}
          />
        </div>
      </ConfigSection>

      <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
        <p className="text-sm text-blue-700 dark:text-blue-300">
          <strong>Note:</strong> Only one backend should be enabled at a time. Priority order: MapDB → Redis → MariaDB → PostgreSQL.
        </p>
      </div>
    </div>
  );
}
