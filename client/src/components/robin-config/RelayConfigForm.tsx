/**
 * Relay configuration form (relay.json5).
 */

import { ConfigSection } from './ConfigSection';
import { TextField, NumberField, ToggleField, SelectField } from './ConfigField';
import type { RelayConfig } from '../../types/robin-config';

interface RelayConfigFormProps {
  config: Partial<RelayConfig>;
  onChange: (config: Partial<RelayConfig>) => void;
  baseConfig?: Partial<RelayConfig>;
  disabled?: boolean;
}

export function RelayConfigForm({ config, onChange, baseConfig, disabled }: RelayConfigFormProps) {
  const update = <K extends keyof RelayConfig>(key: K, value: RelayConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  const isOverridden = (key: keyof RelayConfig) => 
    baseConfig && config[key] !== undefined && JSON.stringify(config[key]) !== JSON.stringify(baseConfig[key]);

  return (
    <div className="space-y-4">
      <ConfigSection title="Relay settings" description="Email relay configuration">
        <div className="space-y-3">
          <ToggleField
            label="Inbound relay enabled"
            value={config.enabled ?? false}
            onChange={(v) => update('enabled', v)}
            help="Enable inbound relay to forward incoming mail"
            disabled={disabled}
            isOverridden={isOverridden('enabled')}
          />
          <ToggleField
            label="Outbound relay enabled"
            value={config.outboundEnabled ?? true}
            onChange={(v) => update('outboundEnabled', v)}
            help="Enable outbound relay for sending mail"
            disabled={disabled}
            isOverridden={isOverridden('outboundEnabled')}
          />
          <ToggleField
            label="Outbound MX enabled"
            value={config.outboundMxEnabled ?? true}
            onChange={(v) => update('outboundMxEnabled', v)}
            help="Perform MX lookups for recipient domains instead of using relay host"
            disabled={disabled}
            isOverridden={isOverridden('outboundMxEnabled')}
          />
          <ToggleField
            label="Disable relay header"
            value={config.disableRelayHeader ?? true}
            onChange={(v) => update('disableRelayHeader', v)}
            help="Disable relay by magic header feature"
            disabled={disabled}
            isOverridden={isOverridden('disableRelayHeader')}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="Relay host" description="Server to forward mail to (when not using MX)">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <TextField
            label="Host"
            value={config.host ?? 'localhost'}
            onChange={(v) => update('host', v)}
            help="Relay server hostname or IP"
            placeholder="localhost"
            disabled={disabled}
            isOverridden={isOverridden('host')}
          />
          <NumberField
            label="Port"
            value={config.port ?? 24}
            onChange={(v) => update('port', v)}
            help="SMTP port on relay server"
            min={1}
            max={65535}
            disabled={disabled}
            isOverridden={isOverridden('port')}
          />
          <SelectField
            label="Protocol"
            value={config.protocol ?? 'LMTP'}
            onChange={(v) => update('protocol', v as RelayConfig['protocol'])}
            options={[
              { value: 'SMTP', label: 'SMTP' },
              { value: 'ESMTP', label: 'ESMTP' },
              { value: 'LMTP', label: 'LMTP' },
              { value: 'DOVECOT-LDA', label: 'Dovecot LDA' },
            ]}
            help="Protocol to use for relay"
            disabled={disabled}
            isOverridden={isOverridden('protocol')}
          />
          <div className="flex items-end">
            <ToggleField
              label="TLS"
              value={config.tls ?? false}
              onChange={(v) => update('tls', v)}
              help="Use secure TLS connection"
              disabled={disabled}
              isOverridden={isOverridden('tls')}
            />
          </div>
        </div>
      </ConfigSection>

      <ConfigSection title="Delivery options" description="Bounce and retry settings">
        <div className="space-y-3">
          <ToggleField
            label="Bounce on failure"
            value={config.bounce ?? true}
            onChange={(v) => update('bounce', v)}
            help="Send bounce notification if relay fails"
            disabled={disabled}
            isOverridden={isOverridden('bounce')}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <NumberField
            label="Max retry count"
            value={config.maxRetryCount ?? 30}
            onChange={(v) => update('maxRetryCount', v)}
            help="Maximum retry attempts for outbound relay"
            min={1}
            max={100}
            disabled={disabled}
            isOverridden={isOverridden('maxRetryCount')}
          />
        </div>
      </ConfigSection>

      <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
        <p className="text-sm text-blue-700 dark:text-blue-300">
          <strong>IP Pools:</strong> For weighted outbound bind address selection, configure IP pools in the raw JSON editor.
          IP pools allow you to specify multiple outbound IPs with weighted selection.
        </p>
      </div>
    </div>
  );
}
