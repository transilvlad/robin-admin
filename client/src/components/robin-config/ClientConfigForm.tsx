import { ConfigSection } from './ConfigSection';
import {
  TextField,
  NumberField,
  ToggleField,
} from './ConfigField';
import { ArrayEditor } from './ArrayEditor';
import type { ClientConfig } from '../../types/robin-config';

interface ClientConfigFormProps {
  config: Partial<ClientConfig>;
  onChange: (config: Partial<ClientConfig>) => void;
  baseConfig?: Partial<ClientConfig>;
  disabled?: boolean;
}

const DEFAULT_PROTOCOLS = ['TLSv1.2', 'TLSv1.3'];
const DEFAULT_CIPHERS = [
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_128_CCM_8_SHA256',
  'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384',
  'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
  'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
  'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
];

export default function ClientConfigForm({
  config,
  onChange,
  baseConfig,
  disabled,
}: ClientConfigFormProps) {
  const updateField = <K extends keyof ClientConfig>(
    key: K,
    value: ClientConfig[K]
  ) => {
    onChange({ ...config, [key]: value });
  };

  const isOverridden = (key: keyof ClientConfig) =>
    baseConfig && config[key] !== undefined && baseConfig[key] !== config[key];

  return (
    <div className="space-y-6">
      <ConfigSection
        title="EHLO Configuration"
        description="Client identification for SMTP handshake"
      >
        <TextField
          label="EHLO Domain"
          value={config.ehlo || ''}
          onChange={(v) => updateField('ehlo', v)}
          placeholder="example.com"
          help="Domain name to use in EHLO command"
          disabled={disabled}
          isOverridden={isOverridden('ehlo')}
        />
      </ConfigSection>

      <ConfigSection
        title="TLS Configuration"
        description="Transport layer security settings for secure connections"
      >
        <ToggleField
          label="Enable TLS"
          value={config.tls ?? true}
          onChange={(v) => updateField('tls', v)}
          help="Allow the client to use STARTTLS when advertised"
          disabled={disabled}
          isOverridden={isOverridden('tls')}
        />
        <ArrayEditor
          label="Protocols"
          value={config.protocols || DEFAULT_PROTOCOLS}
          onChange={(v) => updateField('protocols', v)}
          placeholder="e.g., TLSv1.3"
          help="Supported TLS protocol versions"
          disabled={disabled}
          isOverridden={isOverridden('protocols')}
        />
        <ArrayEditor
          label="Ciphers"
          value={config.ciphers || DEFAULT_CIPHERS}
          onChange={(v) => updateField('ciphers', v)}
          placeholder="e.g., TLS_AES_256_GCM_SHA384"
          help="Supported TLS cipher suites (strong ciphers only)"
          disabled={disabled}
          isOverridden={isOverridden('ciphers')}
        />
      </ConfigSection>

      <ConfigSection
        title="Destination"
        description="Default MX servers and port for outbound email delivery"
        badge="E2E"
      >
        <ArrayEditor
          label="MX Servers"
          value={config.mx || []}
          onChange={(v) => updateField('mx', v)}
          placeholder="e.g., mail.example.com or 127.0.0.1"
          help="List of mail servers to attempt delivery to"
          disabled={disabled}
          isOverridden={isOverridden('mx')}
        />
        <NumberField
          label="Port"
          value={config.port ?? 25}
          onChange={(v) => updateField('port', v)}
          min={1}
          max={65535}
          help="Default SMTP port for connections"
          disabled={disabled}
          isOverridden={isOverridden('port')}
        />
      </ConfigSection>

      <ConfigSection
        title="Default envelope"
        description="Default sender and recipients for outbound email"
        badge="E2E"
      >
        <TextField
          label="Mail from"
          value={config.mail || ''}
          onChange={(v) => updateField('mail', v)}
          placeholder="sender@example.com"
          help="Default sender email address"
          disabled={disabled}
          isOverridden={isOverridden('mail')}
        />
        <ArrayEditor
          label="Recipients"
          value={config.rcpt || []}
          onChange={(v) => updateField('rcpt', v)}
          placeholder="recipient@example.com"
          help="Default recipient email addresses"
          disabled={disabled}
          isOverridden={isOverridden('rcpt')}
        />
      </ConfigSection>

      <ConfigSection
        title="Assertions"
        description="Client-side test/assertion behavior for SMTP and external verification"
        defaultExpanded={Boolean(config.assertions)}
        badge="E2E"
      >
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-200">
          These options are aimed at Robin&apos;s testing/e2e client workflows, not normal mail delivery production use.
        </div>
        <ToggleField
          label="Fail on protocol assertions"
          value={config.assertions?.protocolFails ?? true}
          onChange={(v) => updateField('assertions', { ...config.assertions, protocolFails: v })}
          help="If SMTP protocol assertions fail, stop the test/client flow with a failure."
          disabled={disabled}
        />
        <ToggleField
          label="Fail on verify assertions"
          value={config.assertions?.verifyFails ?? true}
          onChange={(v) => updateField('assertions', { ...config.assertions, verifyFails: v })}
          help="If external verification/assertion checks fail, fail the run instead of continuing."
          disabled={disabled}
        />
      </ConfigSection>
    </div>
  );
}
