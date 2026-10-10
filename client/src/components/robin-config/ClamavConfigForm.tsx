/**
 * ClamAV configuration form (clamav.json5).
 */

import { ConfigSection } from './ConfigSection';
import { TextField, NumberField, ToggleField, SelectField } from './ConfigField';
import type { ClamavConfig } from '../../types/robin-config';
import type { FleetService } from '../../types';

interface ClamavConfigFormProps {
  config: Partial<ClamavConfig>;
  onChange: (config: Partial<ClamavConfig>) => void;
  baseConfig?: Partial<ClamavConfig>;
  disabled?: boolean;
  clamavServices?: FleetService[];
  linkedServiceId?: string | null;
  onLinkedServiceChange?: (serviceId: string | null) => void;
  linkedEndpoint?: { host: string; port: number } | null;
  linkInherited?: boolean;
}

export function ClamavConfigForm({
  config,
  onChange,
  baseConfig,
  disabled,
  clamavServices = [],
  linkedServiceId,
  onLinkedServiceChange,
  linkedEndpoint,
  linkInherited = false,
}: ClamavConfigFormProps) {
  const update = <K extends keyof ClamavConfig>(key: K, value: ClamavConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  const isOverridden = (key: keyof ClamavConfig) => 
    baseConfig && config[key] !== undefined && JSON.stringify(config[key]) !== JSON.stringify(baseConfig[key]);
  const endpointDrift = linkedEndpoint
    ? config.host !== linkedEndpoint.host || config.port !== linkedEndpoint.port
    : false;

  return (
    <div className="space-y-4">
      <ConfigSection title="Fleet service link" description="Optional link to a managed ClamAV fleet service">
        <div className="space-y-3">
          <label className="block space-y-1 text-sm">
            <span className="block font-medium text-gray-700 dark:text-gray-300">Linked ClamAV service</span>
            <select
              value={linkedServiceId ?? ''}
              onChange={(event) => onLinkedServiceChange?.(event.target.value || null)}
              className="input"
              disabled={disabled || clamavServices.length === 0 || !onLinkedServiceChange}
            >
              <option value="">Manual endpoint only</option>
              {clamavServices.map((service) => (
                <option key={service.serviceId} value={service.serviceId}>
                  {service.name} ({service.serviceId})
                </option>
              ))}
            </select>
          </label>

          {clamavServices.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 p-3 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
              No enabled ClamAV fleet services are available yet.
            </div>
          ) : linkedServiceId && linkedEndpoint ? (
            <div className="rounded-lg bg-gray-50 p-3 text-sm text-gray-600 dark:bg-robin-gray-900 dark:text-gray-300">
              Linked endpoint: <span className="font-mono">{linkedEndpoint.host}:{linkedEndpoint.port}</span>
              {linkInherited && <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">(inherited from default)</span>}
            </div>
          ) : linkedServiceId ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-200">
              This linked ClamAV service has no managed ClamD endpoint yet, so host and port cannot be auto-filled.
            </div>
          ) : null}

          {linkedEndpoint && endpointDrift && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-200">
              The Robin-side host/port currently differ from the linked ClamAV service. Keep the override, or re-select the service to apply its managed endpoint again.
            </div>
          )}
        </div>
      </ConfigSection>

      <ConfigSection title="ClamAV Settings" description="Virus scanning configuration">
        <div className="space-y-3">
          <ToggleField
            label="ClamAV Enabled"
            value={config.enabled ?? false}
            onChange={(v) => update('enabled', v)}
            help="Enable ClamAV virus scanning"
            disabled={disabled}
            isOverridden={isOverridden('enabled')}
          />
          <ToggleField
            label="Scan attachments"
            value={config.scanAttachments ?? false}
            onChange={(v) => update('scanAttachments', v)}
            help="Scan email attachments individually for better detection"
            disabled={disabled}
            isOverridden={isOverridden('scanAttachments')}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="Connection" description="ClamAV server connection">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <TextField
            label="Host"
            value={config.host ?? 'localhost'}
            onChange={(v) => update('host', v)}
            help="ClamAV server hostname or IP"
            placeholder="localhost"
            disabled={disabled}
            isOverridden={isOverridden('host')}
          />
          <NumberField
            label="Port"
            value={config.port ?? 3310}
            onChange={(v) => update('port', v)}
            help="ClamAV server port"
            min={1}
            max={65535}
            disabled={disabled}
            isOverridden={isOverridden('port')}
          />
          <NumberField
            label="Timeout"
            value={config.timeout ?? 5}
            onChange={(v) => update('timeout', v)}
            help="Connection timeout in seconds"
            suffix="sec"
            min={1}
            disabled={disabled}
            isOverridden={isOverridden('timeout')}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="Actions" description="What to do when a virus is found">
        <SelectField
          label="On virus detection"
          value={config.onVirus ?? 'reject'}
          onChange={(v) => update('onVirus', v as 'reject' | 'discard')}
          options={[
            { value: 'reject', label: 'Reject - Return 5xx error to sender' },
            { value: 'discard', label: 'Discard - Accept and silently delete' },
          ]}
          help="Action to take when a virus is detected"
          disabled={disabled}
          isOverridden={isOverridden('onVirus')}
        />
      </ConfigSection>
    </div>
  );
}
