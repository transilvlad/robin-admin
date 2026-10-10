/**
 * Rspamd configuration form (rspamd.json5).
 */

import { ConfigSection } from './ConfigSection';
import { TextField, NumberField, ToggleField, SelectField, TextAreaField } from './ConfigField';
import type { RspamdConfig } from '../../types/robin-config';

interface RspamdConfigFormProps {
  config: Partial<RspamdConfig>;
  onChange: (config: Partial<RspamdConfig>) => void;
  baseConfig?: Partial<RspamdConfig>;
  disabled?: boolean;
}

export function RspamdConfigForm({ config, onChange, baseConfig, disabled }: RspamdConfigFormProps) {
  const update = <K extends keyof RspamdConfig>(key: K, value: RspamdConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  const isOverridden = (key: keyof RspamdConfig) => 
    baseConfig && config[key] !== undefined && JSON.stringify(config[key]) !== JSON.stringify(baseConfig[key]);

  return (
    <div className="space-y-4">
      <ConfigSection title="Rspamd settings" description="Spam and phishing detection">
        <div className="space-y-3">
          <ToggleField
            label="Rspamd enabled"
            value={config.enabled ?? false}
            onChange={(v) => update('enabled', v)}
            help="Enable Rspamd scanning"
            disabled={disabled}
            isOverridden={isOverridden('enabled')}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
          <TextField
            label="Host"
            value={config.host ?? 'localhost'}
            onChange={(v) => update('host', v)}
            help="Rspamd server hostname or IP"
            placeholder="localhost"
            disabled={disabled}
            isOverridden={isOverridden('host')}
          />
          <NumberField
            label="Port"
            value={config.port ?? 11333}
            onChange={(v) => update('port', v)}
            help="Rspamd server port"
            min={1}
            max={65535}
            disabled={disabled}
            isOverridden={isOverridden('port')}
          />
          <NumberField
            label="Timeout"
            value={config.timeout ?? 30}
            onChange={(v) => update('timeout', v)}
            help="Connection timeout in seconds"
            suffix="sec"
            min={1}
            disabled={disabled}
            isOverridden={isOverridden('timeout')}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="Scanning options" description="Email authentication checks">
        <div className="space-y-3">
          <ToggleField
            label="SPF Scanning"
            value={config.spfScanEnabled ?? true}
            onChange={(v) => update('spfScanEnabled', v)}
            help="Enable SPF (Sender Policy Framework) checking"
            disabled={disabled}
            isOverridden={isOverridden('spfScanEnabled')}
          />
          <ToggleField
            label="DKIM Scanning"
            value={config.dkimScanEnabled ?? true}
            onChange={(v) => update('dkimScanEnabled', v)}
            help="Enable DKIM (DomainKeys Identified Mail) verification"
            disabled={disabled}
            isOverridden={isOverridden('dkimScanEnabled')}
          />
          <ToggleField
            label="DMARC Scanning"
            value={config.dmarcScanEnabled ?? true}
            onChange={(v) => update('dmarcScanEnabled', v)}
            help="Enable DMARC (Domain-based Message Authentication) checking"
            disabled={disabled}
            isOverridden={isOverridden('dmarcScanEnabled')}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="Spam thresholds" description="Score thresholds for spam actions">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <NumberField
            label="Reject threshold"
            value={config.rejectThreshold ?? 7.0}
            onChange={(v) => update('rejectThreshold', v)}
            help="Reject emails with score >= this value (5xx error)"
            step={0.1}
            min={0}
            disabled={disabled}
            isOverridden={isOverridden('rejectThreshold')}
          />
          <NumberField
            label="Discard threshold"
            value={config.discardThreshold ?? 15.0}
            onChange={(v) => update('discardThreshold', v)}
            help="Silently discard emails with score >= this value"
            step={0.1}
            min={0}
            disabled={disabled}
            isOverridden={isOverridden('discardThreshold')}
          />
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
          Reject threshold should be lower than discard threshold. Typical values: reject at 7-10, discard at 15+.
        </p>
      </ConfigSection>

      <ConfigSection title="DKIM Signing" description="Outbound email signing">
        <ToggleField
          label="DKIM Signing Enabled"
          value={config.dkimSigning?.enabled ?? false}
          onChange={(v) => update('dkimSigning', { ...config.dkimSigning, enabled: v })}
          help="Sign outbound emails with DKIM"
          disabled={disabled}
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <SelectField
            label="Signing backend"
            value={config.dkimSigning?.backend ?? 'rspamd'}
            onChange={(v) => update('dkimSigning', { ...config.dkimSigning, backend: v as 'rspamd' | 'native' })}
            options={[
              { value: 'rspamd', label: 'Rspamd (external service)' },
              { value: 'native', label: 'Native (Apache jDKIM, no external service)' },
            ]}
            help="DKIM signing implementation"
            disabled={disabled}
          />
          <TextField
            label="Key path template"
            value={config.dkimSigning?.keyPath ?? '/var/lib/rspamd/dkim/$domain.$selector.key'}
            onChange={(v) => update('dkimSigning', { ...config.dkimSigning, keyPath: v })}
            help="Path template for DKIM private keys ($domain, $selector replaced)"
            placeholder="/var/lib/rspamd/dkim/$domain.$selector.key"
            disabled={disabled}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <TextField
            label="JDBC URL"
            value={config.dkimSigning?.jdbcUrl ?? ''}
            onChange={(v) => update('dkimSigning', { ...config.dkimSigning, jdbcUrl: v })}
            help="Database for signing domain lookup"
            placeholder="jdbc:postgresql://localhost:5432/robin"
            disabled={disabled}
          />
          <TextField
            label="Username"
            value={config.dkimSigning?.user ?? ''}
            onChange={(v) => update('dkimSigning', { ...config.dkimSigning, user: v })}
            placeholder="robin"
            disabled={disabled}
          />
          <TextField
            label="Password"
            value={config.dkimSigning?.password ?? ''}
            onChange={(v) => update('dkimSigning', { ...config.dkimSigning, password: v })}
            type="password"
            disabled={disabled}
          />
        </div>
        <div className="mt-4">
          <TextAreaField
            label="Signing query"
            value={config.dkimSigning?.signingQuery ?? ''}
            onChange={(v) => update('dkimSigning', { ...config.dkimSigning, signingQuery: v })}
            help="Query to find signing domain and selector pairs for a sender domain"
            placeholder="SELECT s.sign_domain AS domain, s.selector FROM dkim_signing_domains d JOIN dkim_signing_selectors s ON s.domain_id = d.id WHERE d.domain = ?"
            rows={3}
            disabled={disabled}
          />
        </div>
      </ConfigSection>
    </div>
  );
}
