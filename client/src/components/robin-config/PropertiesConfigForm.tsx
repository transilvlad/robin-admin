import { ConfigSection } from './ConfigSection';
import {
  TextField,
  NumberField,
  ToggleField,
} from './ConfigField';
import type { PropertiesConfig } from '../../types/robin-config';

interface PropertiesConfigFormProps {
  config: Partial<PropertiesConfig>;
  onChange: (config: Partial<PropertiesConfig>) => void;
  baseConfig?: Partial<PropertiesConfig>;
  disabled?: boolean;
}

export default function PropertiesConfigForm({
  config,
  onChange,
  baseConfig,
  disabled,
}: PropertiesConfigFormProps) {
  const updateField = <K extends keyof PropertiesConfig>(
    key: K,
    value: PropertiesConfig[K]
  ) => {
    onChange({ ...config, [key]: value });
  };

  const isOverridden = (key: keyof PropertiesConfig) =>
    baseConfig && config[key] !== undefined && baseConfig[key] !== config[key];

  return (
    <div className="space-y-6">
      <ConfigSection
        title="Client settings"
        description="SMTP client behavior options"
      >
        <ToggleField
          label="RSET Between Envelopes"
          value={config.rsetBetweenEnvelopes ?? false}
          onChange={(v) => updateField('rsetBetweenEnvelopes', v)}
          help="Send RSET command before additional envelopes"
          disabled={disabled}
          isOverridden={isOverridden('rsetBetweenEnvelopes')}
        />
      </ConfigSection>

      <ConfigSection
        title="Properties auto-reload"
        description="Automatic reload of properties configuration file"
      >
        <ToggleField
          label="Enabled"
          value={config.propertiesAutoReload?.enabled ?? true}
          onChange={(v) =>
            updateField('propertiesAutoReload', {
              ...config.propertiesAutoReload,
              enabled: v,
            })
          }
          help="Enable automatic properties file reload"
          disabled={disabled}
          isOverridden={isOverridden('propertiesAutoReload')}
        />
        <NumberField
          label="Delay (seconds)"
          value={config.propertiesAutoReload?.delaySeconds ?? 300}
          onChange={(v) =>
            updateField('propertiesAutoReload', {
              ...config.propertiesAutoReload,
              delaySeconds: v,
            })
          }
          min={0}
          help="Initial delay before first reload check"
          disabled={disabled}
          isOverridden={isOverridden('propertiesAutoReload')}
        />
        <NumberField
          label="Interval (seconds)"
          value={config.propertiesAutoReload?.intervalSeconds ?? 300}
          onChange={(v) =>
            updateField('propertiesAutoReload', {
              ...config.propertiesAutoReload,
              intervalSeconds: v,
            })
          }
          min={1}
          help="Interval between reload checks"
          disabled={disabled}
          isOverridden={isOverridden('propertiesAutoReload')}
        />
      </ConfigSection>

      <ConfigSection
        title="Server auto-reload"
        description="Automatic reload of server configuration"
      >
        <ToggleField
          label="Enabled"
          value={config.serverAutoReload?.enabled ?? true}
          onChange={(v) =>
            updateField('serverAutoReload', {
              ...config.serverAutoReload,
              enabled: v,
            })
          }
          help="Enable automatic server config reload"
          disabled={disabled}
          isOverridden={isOverridden('serverAutoReload')}
        />
        <NumberField
          label="Delay (seconds)"
          value={config.serverAutoReload?.delaySeconds ?? 300}
          onChange={(v) =>
            updateField('serverAutoReload', {
              ...config.serverAutoReload,
              delaySeconds: v,
            })
          }
          min={0}
          help="Initial delay before first reload check"
          disabled={disabled}
          isOverridden={isOverridden('serverAutoReload')}
        />
        <NumberField
          label="Interval (seconds)"
          value={config.serverAutoReload?.intervalSeconds ?? 300}
          onChange={(v) =>
            updateField('serverAutoReload', {
              ...config.serverAutoReload,
              intervalSeconds: v,
            })
          }
          min={1}
          help="Interval between reload checks"
          disabled={disabled}
          isOverridden={isOverridden('serverAutoReload')}
        />
      </ConfigSection>

      <ConfigSection
        title="Logging"
        description="MTA log path and debug settings, including local test/assertion helpers"
        badge="E2E"
      >
        <TextField
          label="Local logs directory"
          value={config.localLogsDir || ''}
          onChange={(v) => updateField('localLogsDir', v)}
          placeholder="/usr/local/robin/log/"
          help="Path to Robin logs for local-host runs and log-based assertions. Useful for e2e/dev workflows, not a production-facing operator feature."
          disabled={disabled}
          isOverridden={isOverridden('localLogsDir')}
        />
        <TextField
          label="UID Pattern"
          value={config.uidPattern || ''}
          onChange={(v) => updateField('uidPattern', v)}
          placeholder="\\s\\[([a-z0-9\\-_]+)]"
          help="Regex pattern to match UID out of SMTP responses"
          disabled={disabled}
          isOverridden={isOverridden('uidPattern')}
        />
        <ToggleField
          label="Log email data"
          value={config.logging?.data ?? false}
          onChange={(v) =>
            updateField('logging', { ...config.logging, data: v })
          }
          help="Log email DATA sent and received"
          disabled={disabled}
          isOverridden={isOverridden('logging')}
        />
        <ToggleField
          label="Log text part body"
          value={config.logging?.textPartBody ?? false}
          onChange={(v) =>
            updateField('logging', { ...config.logging, textPartBody: v })
          }
          help="Log MIME build case text/* type part contents"
          disabled={disabled}
          isOverridden={isOverridden('logging')}
        />
      </ConfigSection>

      <ConfigSection
        title="IMAP Assertion Debug"
        description="Debug logging for IMAP-based verification and assertion flows"
        badge="E2E"
      >
        <ToggleField
          label="Enable IMAP client debug"
          value={(config.imapClientDebug ?? 'false') === 'true'}
          onChange={(v) => updateField('imapClientDebug', v ? 'true' : 'false')}
          help="Turns on Robin IMAP client debug logging while still persisting the underlying value as the string 'true' or 'false'."
          disabled={disabled}
          isOverridden={isOverridden('imapClientDebug')}
        />
      </ConfigSection>

      <ConfigSection
        title="HTTP Request Settings"
        description="Default timeouts for Robin HTTP client and HTTP-based assertion/test flows"
        badge="E2E"
      >
        <NumberField
          label="Connect Timeout (seconds)"
          value={config.request?.connectTimeout ?? 20}
          onChange={(v) =>
            updateField('request', { ...config.request, connectTimeout: v })
          }
          min={1}
          help="Connection establishment timeout for outbound HTTP clients, including request-driven verification flows."
          disabled={disabled}
          isOverridden={isOverridden('request')}
        />
        <NumberField
          label="Write Timeout (seconds)"
          value={config.request?.writeTimeout ?? 20}
          onChange={(v) =>
            updateField('request', { ...config.request, writeTimeout: v })
          }
          min={1}
          help="Write timeout for HTTP payload uploads such as webhook, request, or assertion traffic."
          disabled={disabled}
          isOverridden={isOverridden('request')}
        />
        <NumberField
          label="Read Timeout (seconds)"
          value={config.request?.readTimeout ?? 90}
          onChange={(v) =>
            updateField('request', { ...config.request, readTimeout: v })
          }
          min={1}
          help="Response read timeout for external HTTP integrations and API/assertion use cases."
          disabled={disabled}
          isOverridden={isOverridden('request')}
        />
      </ConfigSection>

      <ConfigSection
        title="Humio configuration"
        description="Humio integration for querying logs during diagnostics and test verification"
        badge="E2E"
      >
        <TextField
          label="API URL"
          value={config.humio?.url || ''}
          onChange={(v) =>
            updateField('humio', { ...config.humio, url: v })
          }
          placeholder="https://humio.example.com/"
          help="Humio ingestion API URL"
          disabled={disabled}
          isOverridden={isOverridden('humio')}
        />
        <TextField
          label="API Key"
          value={config.humio?.auth || ''}
          onChange={(v) =>
            updateField('humio', { ...config.humio, auth: v })
          }
          type="password"
          placeholder="YOUR_API_KEY"
          help="Humio API authentication key"
          disabled={disabled}
          isOverridden={isOverridden('humio')}
        />
        <NumberField
          label="Connect Timeout (seconds)"
          value={config.humio?.connectTimeout ?? 20}
          onChange={(v) =>
            updateField('humio', { ...config.humio, connectTimeout: v })
          }
          min={1}
          help="Humio connection timeout"
          disabled={disabled}
          isOverridden={isOverridden('humio')}
        />
        <NumberField
          label="Write Timeout (seconds)"
          value={config.humio?.writeTimeout ?? 20}
          onChange={(v) =>
            updateField('humio', { ...config.humio, writeTimeout: v })
          }
          min={1}
          help="Humio write timeout"
          disabled={disabled}
          isOverridden={isOverridden('humio')}
        />
        <NumberField
          label="Read Timeout (seconds)"
          value={config.humio?.readTimeout ?? 90}
          onChange={(v) =>
            updateField('humio', { ...config.humio, readTimeout: v })
          }
          min={1}
          help="Humio read timeout"
          disabled={disabled}
          isOverridden={isOverridden('humio')}
        />
      </ConfigSection>
    </div>
  );
}
