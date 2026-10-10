import { ConfigSection } from './ConfigSection';
import { NumberField, SelectField, TextField, ToggleField } from './ConfigField';
import type { StalwartConfig } from '../../types/robin-config';

interface StalwartConfigFormProps {
  config: Partial<StalwartConfig>;
  onChange: (config: Partial<StalwartConfig>) => void;
  baseConfig?: Partial<StalwartConfig>;
  disabled?: boolean;
}

export function StalwartConfigForm({ config, onChange, disabled }: StalwartConfigFormProps) {
  const update = <K extends keyof StalwartConfig>(key: K, value: StalwartConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  const enabled = config.enabled ?? false;

  return (
    <div className="space-y-4">
      <ConfigSection
        title="Stalwart backend"
        description="Robin integration with a Stalwart-managed mailbox backend"
        defaultExpanded={enabled}
      >
        <div className="space-y-3">
          <ToggleField
            label="Enable Stalwart backend"
            value={enabled}
            onChange={(value) => update('enabled', value)}
            help="Turns on Robin's Stalwart integration path."
            disabled={disabled}
          />
          <ToggleField
            label="Inline delivery"
            value={config.inline ?? true}
            onChange={(value) => update('inline', value)}
            help="Deliver inline instead of deferring to later retry processing."
            disabled={disabled}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="Endpoints" description="Stalwart base URLs and credentials" defaultExpanded={enabled}>
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            label="Base URL"
            type="url"
            value={config.baseUrl ?? ''}
            onChange={(value) => update('baseUrl', value)}
            placeholder="http://127.0.0.1:8080"
            help="Primary Stalwart API base URL."
            disabled={disabled}
          />
          <TextField
            label="Management base URL"
            type="url"
            value={config.managementBaseUrl ?? ''}
            onChange={(value) => update('managementBaseUrl', value)}
            placeholder="http://127.0.0.1:8080"
            help="Optional separate management URL when admin access is routed differently."
            disabled={disabled}
          />
          <TextField
            label="Username"
            value={config.username ?? ''}
            onChange={(value) => update('username', value)}
            disabled={disabled}
          />
          <TextField
            label="Password"
            type="password"
            value={config.password ?? ''}
            onChange={(value) => update('password', value)}
            disabled={disabled}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="Timeouts and cache" description="HTTP, cache, and concurrency tuning" defaultExpanded={enabled}>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <NumberField
            label="Connect timeout"
            value={config.connectTimeoutSeconds ?? 10}
            onChange={(value) => update('connectTimeoutSeconds', value)}
            suffix="sec"
            min={1}
            disabled={disabled}
          />
          <NumberField
            label="Read timeout"
            value={config.readTimeoutSeconds ?? 30}
            onChange={(value) => update('readTimeoutSeconds', value)}
            suffix="sec"
            min={1}
            disabled={disabled}
          />
          <NumberField
            label="Write timeout"
            value={config.writeTimeoutSeconds ?? 30}
            onChange={(value) => update('writeTimeoutSeconds', value)}
            suffix="sec"
            min={1}
            disabled={disabled}
          />
          <NumberField
            label="Lookup cache TTL"
            value={config.lookupCacheTtlSeconds ?? 300}
            onChange={(value) => update('lookupCacheTtlSeconds', value)}
            suffix="sec"
            min={0}
            disabled={disabled}
          />
          <NumberField
            label="Lookup cache max entries"
            value={config.lookupCacheMaxEntries ?? 4096}
            onChange={(value) => update('lookupCacheMaxEntries', value)}
            min={1}
            disabled={disabled}
          />
          <NumberField
            label="Max concurrent requests"
            value={config.maxConcurrentRequests ?? 32}
            onChange={(value) => update('maxConcurrentRequests', value)}
            min={1}
            disabled={disabled}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="Failure handling" description="Retry behavior when Stalwart requests fail" defaultExpanded={enabled}>
        <div className="grid gap-4 md:grid-cols-2">
          <SelectField
            label="Failure behaviour"
            value={config.failureBehaviour ?? 'retry'}
            onChange={(value) => update('failureBehaviour', value as StalwartConfig['failureBehaviour'])}
            options={[
              { value: 'retry', label: 'Retry later' },
              { value: 'bounce', label: 'Bounce immediately' },
            ]}
            disabled={disabled}
          />
          <NumberField
            label="Max retry count"
            value={config.maxRetryCount ?? 10}
            onChange={(value) => update('maxRetryCount', value)}
            min={0}
            disabled={disabled}
          />
          <TextField
            label="Inbox mailbox ID"
            value={config.inboxMailboxId ?? '0'}
            onChange={(value) => update('inboxMailboxId', value)}
            help="Stalwart uses inbox mailbox id 0 internally by default."
            disabled={disabled}
          />
        </div>
      </ConfigSection>
    </div>
  );
}
