import { ConfigSection } from './ConfigSection';
import { NumberField, TextField, ToggleField } from './ConfigField';
import type { VaultConfig } from '../../types/robin-config';

interface VaultConfigFormProps {
  config: Partial<VaultConfig>;
  onChange: (config: Partial<VaultConfig>) => void;
  baseConfig?: Partial<VaultConfig>;
  disabled?: boolean;
}

export function VaultConfigForm({ config, onChange, disabled }: VaultConfigFormProps) {
  const update = <K extends keyof VaultConfig>(key: K, value: VaultConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  const enabled = config.enabled ?? false;

  return (
    <div className="space-y-4">
      <ConfigSection
        title="Vault integration"
        description="HashiCorp Vault secret resolution for Robin runtime configuration"
        defaultExpanded={enabled}
      >
        <div className="space-y-3">
          <ToggleField
            label="Enable Vault integration"
            value={enabled}
            onChange={(value) => update('enabled', value)}
            help="Enables Robin's Vault client and the {$vault.*} magic-variable secret lookup path."
            disabled={disabled}
          />
        </div>
      </ConfigSection>

      <ConfigSection
        title="Connection"
        description="Vault endpoint, auth token source, and enterprise namespace settings"
        defaultExpanded={enabled}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            label="Vault address"
            type="url"
            value={config.address ?? 'https://vault.example.com:8200'}
            onChange={(value) => update('address', value)}
            placeholder="https://vault.example.com:8200"
            help="Vault server URL including protocol and port."
            disabled={disabled}
          />
          <TextField
            label="Namespace"
            value={config.namespace ?? ''}
            onChange={(value) => update('namespace', value)}
            placeholder="team-a"
            help="Optional Vault Enterprise namespace."
            disabled={disabled}
          />
        </div>

        <TextField
          label="Token or token file"
          type="password"
          value={config.token ?? ''}
          onChange={(value) => update('token', value)}
          placeholder="/usr/local/robin/secrets/vault-token"
          help="Either the Vault token itself or, preferably, a path to a file containing the token."
          disabled={disabled}
        />

        <ToggleField
          label="Skip TLS verification"
          value={config.skipTlsVerification ?? false}
          onChange={(value) => update('skipTlsVerification', value)}
          help="Development-only escape hatch for self-signed or invalid certificates. Keep disabled in production."
          disabled={disabled}
        />

        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-200">
          <strong>Prefer token files:</strong> Robin's Vault docs recommend storing the token in a protected file and pointing this field at that path instead of embedding the token directly in config.
        </div>
      </ConfigSection>

      <ConfigSection
        title="Timeouts"
        description="Vault client connect, read, and write timeouts in seconds"
        defaultExpanded={enabled}
      >
        <div className="grid gap-4 md:grid-cols-3">
          <NumberField
            label="Connect timeout"
            value={config.connectTimeout ?? 30}
            onChange={(value) => update('connectTimeout', value)}
            min={1}
            suffix="sec"
            disabled={disabled}
          />
          <NumberField
            label="Read timeout"
            value={config.readTimeout ?? 30}
            onChange={(value) => update('readTimeout', value)}
            min={1}
            suffix="sec"
            disabled={disabled}
          />
          <NumberField
            label="Write timeout"
            value={config.writeTimeout ?? 30}
            onChange={(value) => update('writeTimeout', value)}
            min={1}
            suffix="sec"
            disabled={disabled}
          />
        </div>
      </ConfigSection>
    </div>
  );
}
