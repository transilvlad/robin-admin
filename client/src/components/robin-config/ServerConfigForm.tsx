/**
 * Server configuration form (server.json5).
 */

import { AlertTriangle } from 'lucide-react';
import { ConfigSection } from './ConfigSection';
import { TextField, NumberField, ToggleField, SelectField } from './ConfigField';
import { ArrayEditor } from './ArrayEditor';
import type { ServerConfig, PortConfig } from '../../types/robin-config';

interface ServerConfigFormProps {
  config: Partial<ServerConfig>;
  onChange: (config: Partial<ServerConfig>) => void;
  baseConfig?: Partial<ServerConfig>;
  disabled?: boolean;
}

function PortConfigSection({
  title,
  description,
  config,
  onChange,
  baseConfig,
  disabled,
}: {
  title: string;
  description: string;
  config: Partial<PortConfig>;
  onChange: (config: Partial<PortConfig>) => void;
  baseConfig?: Partial<PortConfig>;
  disabled?: boolean;
}) {
  const update = <K extends keyof PortConfig>(key: K, value: PortConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  const isOverridden = (key: keyof PortConfig) => baseConfig && config[key] !== undefined && config[key] !== baseConfig[key];

  return (
    <ConfigSection title={title} description={description} defaultExpanded={false}>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <NumberField
          label="Backlog"
          value={config.backlog ?? 25}
          onChange={(v) => update('backlog', v)}
          help="Number of connections allowed in the backlog"
          min={1}
          max={1000}
          disabled={disabled}
          isOverridden={isOverridden('backlog')}
        />
        <NumberField
          label="Min pool size"
          value={config.minimumPoolSize ?? 1}
          onChange={(v) => update('minimumPoolSize', v)}
          help="Minimum number of threads in the pool"
          min={1}
          max={100}
          disabled={disabled}
          isOverridden={isOverridden('minimumPoolSize')}
        />
        <NumberField
          label="Max pool size"
          value={config.maximumPoolSize ?? 10}
          onChange={(v) => update('maximumPoolSize', v)}
          help="Maximum number of threads in the pool"
          min={1}
          max={1000}
          disabled={disabled}
          isOverridden={isOverridden('maximumPoolSize')}
        />
        <NumberField
          label="Thread keep alive"
          value={config.threadKeepAliveTime ?? 60}
          onChange={(v) => update('threadKeepAliveTime', v)}
          help="Time (seconds) to keep idle threads alive"
          suffix="sec"
          min={1}
          disabled={disabled}
          isOverridden={isOverridden('threadKeepAliveTime')}
        />
        <NumberField
          label="Transactions limit"
          value={config.transactionsLimit ?? 305}
          onChange={(v) => update('transactionsLimit', v)}
          help="Max SMTP transactions per connection"
          min={1}
          disabled={disabled}
          isOverridden={isOverridden('transactionsLimit')}
        />
        <NumberField
          label="Recipients limit"
          value={config.recipientsLimit ?? 100}
          onChange={(v) => update('recipientsLimit', v)}
          help="Max recipients per envelope"
          min={1}
          disabled={disabled}
          isOverridden={isOverridden('recipientsLimit')}
        />
        <NumberField
          label="Envelope limit"
          value={config.envelopeLimit ?? 100}
          onChange={(v) => update('envelopeLimit', v)}
          help="Max envelopes per connection"
          min={1}
          disabled={disabled}
          isOverridden={isOverridden('envelopeLimit')}
        />
        <NumberField
          label="Message size limit"
          value={config.messageSizeLimit ?? 10242400}
          onChange={(v) => update('messageSizeLimit', v)}
          help="Maximum message size in bytes"
          suffix="bytes"
          min={0}
          disabled={disabled}
          isOverridden={isOverridden('messageSizeLimit')}
        />
        <NumberField
          label="Error limit"
          value={config.errorLimit ?? 3}
          onChange={(v) => update('errorLimit', v)}
          help="SMTP errors before terminating connection"
          min={1}
          disabled={disabled}
          isOverridden={isOverridden('errorLimit')}
        />
      </div>

      <h4 className="font-medium mt-4 mb-2">DoS Protection</h4>
      <div className="space-y-3">
        <ToggleField
          label="DoS Protection Enabled"
          value={config.dosProtectionEnabled ?? true}
          onChange={(v) => update('dosProtectionEnabled', v)}
          help="Enable denial-of-service protections"
          disabled={disabled}
          isOverridden={isOverridden('dosProtectionEnabled')}
        />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-3">
        <NumberField
          label="Max connections/IP"
          value={config.maxConnectionsPerIp ?? 10}
          onChange={(v) => update('maxConnectionsPerIp', v)}
          help="Max concurrent connections per IP (0 to disable)"
          min={0}
          disabled={disabled}
          isOverridden={isOverridden('maxConnectionsPerIp')}
        />
        <NumberField
          label="Max total connections"
          value={config.maxTotalConnections ?? 100}
          onChange={(v) => update('maxTotalConnections', v)}
          help="Max total concurrent connections (0 to disable)"
          min={0}
          disabled={disabled}
          isOverridden={isOverridden('maxTotalConnections')}
        />
        <NumberField
          label="Rate limit window"
          value={config.rateLimitWindowSeconds ?? 60}
          onChange={(v) => update('rateLimitWindowSeconds', v)}
          help="Rate limit window in seconds"
          suffix="sec"
          min={1}
          disabled={disabled}
          isOverridden={isOverridden('rateLimitWindowSeconds')}
        />
        <NumberField
          label="Max connections/window"
          value={config.maxConnectionsPerWindow ?? 30}
          onChange={(v) => update('maxConnectionsPerWindow', v)}
          help="Max new connections per IP within window (0 to disable)"
          min={0}
          disabled={disabled}
          isOverridden={isOverridden('maxConnectionsPerWindow')}
        />
        <NumberField
          label="Max commands/minute"
          value={config.maxCommandsPerMinute ?? 100}
          onChange={(v) => update('maxCommandsPerMinute', v)}
          help="Max commands per minute per connection (0 to disable)"
          min={0}
          disabled={disabled}
          isOverridden={isOverridden('maxCommandsPerMinute')}
        />
        <NumberField
          label="Min data rate"
          value={config.minDataRateBytesPerSecond ?? 10240}
          onChange={(v) => update('minDataRateBytesPerSecond', v)}
          help="Minimum data transfer rate (0 to disable)"
          suffix="B/s"
          min={0}
          disabled={disabled}
          isOverridden={isOverridden('minDataRateBytesPerSecond')}
        />
        <NumberField
          label="Max data timeout"
          value={config.maxDataTimeoutSeconds ?? 300}
          onChange={(v) => update('maxDataTimeoutSeconds', v)}
          help="Maximum data transfer timeout"
          suffix="sec"
          min={1}
          disabled={disabled}
          isOverridden={isOverridden('maxDataTimeoutSeconds')}
        />
        <NumberField
          label="Tarpit delay"
          value={config.tarpitDelayMillis ?? 1000}
          onChange={(v) => update('tarpitDelayMillis', v)}
          help="Delay for suspicious behavior (0 to disable)"
          suffix="ms"
          min={0}
          disabled={disabled}
          isOverridden={isOverridden('tarpitDelayMillis')}
        />
      </div>
    </ConfigSection>
  );
}

export function ServerConfigForm({ config, onChange, baseConfig, disabled }: ServerConfigFormProps) {
  const update = <K extends keyof ServerConfig>(key: K, value: ServerConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  const isOverridden = (key: keyof ServerConfig) => baseConfig && config[key] !== undefined && config[key] !== baseConfig[key];

  return (
    <div className="space-y-4">
      <ConfigSection title="General settings" description="Basic server configuration">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TextField
            label="Hostname"
            value={config.hostname ?? ''}
            onChange={(v) => update('hostname', v)}
            help="Hostname to declare in welcome message"
            placeholder="example.com"
            disabled={disabled}
            isOverridden={isOverridden('hostname')}
          />
          <TextField
            label="Bind address"
            value={config.bind ?? '::'}
            onChange={(v) => update('bind', v)}
            help="Interface the server will bind to (default: ::)"
            placeholder="::"
            disabled={disabled}
            isOverridden={isOverridden('bind')}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="Ports" description="SMTP port configuration">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <NumberField
            label="SMTP Port"
            value={config.smtpPort ?? 25}
            onChange={(v) => update('smtpPort', v)}
            help="Standard SMTP port (0 to disable)"
            min={0}
            max={65535}
            disabled={disabled}
            isOverridden={isOverridden('smtpPort')}
          />
          <NumberField
            label="Secure Port (SMTPS)"
            value={config.securePort ?? 465}
            onChange={(v) => update('securePort', v)}
            help="SSL/TLS SMTP port (0 to disable)"
            min={0}
            max={65535}
            disabled={disabled}
            isOverridden={isOverridden('securePort')}
          />
          <NumberField
            label="Submission port"
            value={config.submissionPort ?? 587}
            onChange={(v) => update('submissionPort', v)}
            help="Mail submission port (0 to disable)"
            min={0}
            max={65535}
            disabled={disabled}
            isOverridden={isOverridden('submissionPort')}
          />
        </div>
      </ConfigSection>

      <PortConfigSection
        title="SMTP Port Configuration"
        description="Settings for port 25"
        config={config.smtpConfig ?? {}}
        onChange={(v) => update('smtpConfig', v as PortConfig)}
        baseConfig={baseConfig?.smtpConfig}
        disabled={disabled}
      />

      <PortConfigSection
        title="Secure port configuration"
        description="Settings for port 465 (SMTPS)"
        config={config.secureConfig ?? {}}
        onChange={(v) => update('secureConfig', v as PortConfig)}
        baseConfig={baseConfig?.secureConfig}
        disabled={disabled}
      />

      <PortConfigSection
        title="Submission port configuration"
        description="Settings for port 587"
        config={config.submissionConfig ?? {}}
        onChange={(v) => update('submissionConfig', v as PortConfig)}
        baseConfig={baseConfig?.submissionConfig}
        disabled={disabled}
      />

      <ConfigSection title="Protocol features" description="SMTP extension support">
        <div className="space-y-3">
          <ToggleField
            label="AUTH Support"
            value={config.auth ?? true}
            onChange={(v) => update('auth', v)}
            help="Advertise AUTH extension"
            disabled={disabled}
            isOverridden={isOverridden('auth')}
          />
          <ToggleField
            label="STARTTLS Support"
            value={config.starttls ?? true}
            onChange={(v) => update('starttls', v)}
            help="Advertise STARTTLS extension"
            disabled={disabled}
            isOverridden={isOverridden('starttls')}
          />
          <ToggleField
            label="CHUNKING Support"
            value={config.chunking ?? true}
            onChange={(v) => update('chunking', v)}
            help="Advertise CHUNKING (BDAT) extension"
            disabled={disabled}
            isOverridden={isOverridden('chunking')}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="TLS Certificates" description="SSL/TLS certificate configuration">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TextField
            label="PEM Certificate"
            value={config.pemCert ?? ''}
            onChange={(v) => update('pemCert', v)}
            help="Path to PEM certificate file (takes precedence over JKS)"
            placeholder="/path/to/cert.pem"
            disabled={disabled}
            isOverridden={isOverridden('pemCert')}
          />
          <TextField
            label="PEM Private Key"
            value={config.pemKey ?? ''}
            onChange={(v) => update('pemKey', v)}
            help="Path to PEM private key (PKCS8 format)"
            placeholder="/path/to/key.pem"
            disabled={disabled}
            isOverridden={isOverridden('pemKey')}
          />
          <TextField
            label="Keystore path"
            value={config.keystore ?? ''}
            onChange={(v) => update('keystore', v)}
            help="Path to Java keystore (JKS)"
            placeholder="/usr/local/robin/keystore.jks"
            disabled={disabled}
            isOverridden={isOverridden('keystore')}
          />
          <TextField
            label="Keystore password"
            value={config.keystorepassword ?? ''}
            onChange={(v) => update('keystorepassword', v)}
            help="Keystore password or path to password file"
            type="password"
            disabled={disabled}
            isOverridden={isOverridden('keystorepassword')}
          />
          <TextField
            label="Truststore path"
            value={config.truststore ?? ''}
            onChange={(v) => update('truststore', v)}
            help="Path to Java truststore"
            placeholder="/opt/java/openjdk/lib/security/cacerts"
            disabled={disabled}
            isOverridden={isOverridden('truststore')}
          />
          <TextField
            label="Truststore password"
            value={config.truststorepassword ?? ''}
            onChange={(v) => update('truststorepassword', v)}
            help="Truststore password or path to password file"
            type="password"
            disabled={disabled}
            isOverridden={isOverridden('truststorepassword')}
          />
        </div>
        <div className="mt-3">
          <ToggleField
            label="Allow self-signed certificates"
            value={config.allowSelfSigned ?? false}
            onChange={(v) => update('allowSelfSigned', v)}
            help="Accept self-signed certificates from clients"
            disabled={disabled}
            isOverridden={isOverridden('allowSelfSigned')}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="Service endpoint" description="Internal service API configuration">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <NumberField
            label="Port"
            value={config.service?.port ?? 8080}
            onChange={(v) => update('service', { ...config.service, port: v } as any)}
            help="Service endpoint port"
            min={0}
            max={65535}
            disabled={disabled}
          />
          <SelectField
            label="Auth type"
            value={config.service?.authType ?? 'none'}
            onChange={(v) => update('service', { ...config.service, authType: v } as any)}
            options={[
              { value: 'none', label: 'None' },
              { value: 'basic', label: 'Basic' },
              { value: 'bearer', label: 'Bearer' },
            ]}
            help="Authentication type"
            disabled={disabled}
          />
          <TextField
            label="Auth value"
            value={config.service?.authValue ?? ''}
            onChange={(v) => update('service', { ...config.service, authValue: v } as any)}
            help="username:password for basic, token for bearer"
            type="password"
            disabled={disabled}
          />
        </div>
        <div className="mt-4">
          <ArrayEditor
            label="Allow list"
            value={config.service?.allowList ?? []}
            onChange={(v) => update('service', { ...config.service, allowList: v } as any)}
            help="IP addresses or CIDR blocks allowed without authentication"
            placeholder="192.168.1.0/24"
            disabled={disabled}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="API Endpoint" description="External API configuration">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <NumberField
            label="Port"
            value={config.api?.port ?? 8090}
            onChange={(v) => update('api', { ...config.api, port: v } as any)}
            help="API endpoint port"
            min={0}
            max={65535}
            disabled={disabled}
          />
          <SelectField
            label="Auth type"
            value={config.api?.authType ?? 'none'}
            onChange={(v) => update('api', { ...config.api, authType: v } as any)}
            options={[
              { value: 'none', label: 'None' },
              { value: 'basic', label: 'Basic' },
              { value: 'bearer', label: 'Bearer' },
            ]}
            help="Authentication type"
            disabled={disabled}
          />
          <TextField
            label="Auth value"
            value={config.api?.authValue ?? ''}
            onChange={(v) => update('api', { ...config.api, authValue: v } as any)}
            help="username:password for basic, token for bearer"
            type="password"
            disabled={disabled}
          />
        </div>
        <div className="mt-4">
          <ArrayEditor
            label="Allow list"
            value={config.api?.allowList ?? []}
            onChange={(v) => update('api', { ...config.api, allowList: v } as any)}
            help="IP addresses or CIDR blocks allowed without authentication"
            placeholder="192.168.1.0/24"
            disabled={disabled}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="RBL (Realtime Blackhole List)" description="DNS-based blocklist checking">
        <div className="space-y-3">
          <ToggleField
            label="RBL Enabled"
            value={config.rbl?.enabled ?? false}
            onChange={(v) => update('rbl', { ...config.rbl, enabled: v } as any)}
            help="Enable RBL checking"
            disabled={disabled}
          />
          <ToggleField
            label="Reject enabled"
            value={config.rbl?.rejectEnabled ?? false}
            onChange={(v) => update('rbl', { ...config.rbl, rejectEnabled: v } as any)}
            help="Reject messages from blacklisted IPs"
            disabled={disabled}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <NumberField
            label="Timeout"
            value={config.rbl?.timeoutSeconds ?? 5}
            onChange={(v) => update('rbl', { ...config.rbl, timeoutSeconds: v } as any)}
            help="Max time to wait for RBL responses"
            suffix="sec"
            min={1}
            disabled={disabled}
          />
        </div>
        <div className="mt-4">
          <ArrayEditor
            label="RBL Providers"
            value={config.rbl?.providers ?? []}
            onChange={(v) => update('rbl', { ...config.rbl, providers: v } as any)}
            help="List of RBL providers to check against"
            placeholder="zen.spamhaus.org"
            disabled={disabled}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="Limits" description="Message and connection limits">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <NumberField
            label="Email size limit"
            value={config.emailSizeLimit ?? 10242400}
            onChange={(v) => update('emailSizeLimit', v)}
            help="Maximum email message size (0 = unlimited)"
            suffix="bytes"
            min={0}
            disabled={disabled}
            isOverridden={isOverridden('emailSizeLimit')}
          />
          <NumberField
            label="Envelopes limit"
            value={config.envelopesLimit ?? 100}
            onChange={(v) => update('envelopesLimit', v)}
            help="Maximum recipients per message (0 = unlimited)"
            min={0}
            disabled={disabled}
            isOverridden={isOverridden('envelopesLimit')}
          />
          <NumberField
            label="DNS Negative TTL"
            value={config.dnsNegativeTtl ?? 300}
            onChange={(v) => update('dnsNegativeTtl', v)}
            help="Cache time for NXDOMAIN/NODATA responses"
            suffix="sec"
            min={0}
            disabled={disabled}
            isOverridden={isOverridden('dnsNegativeTtl')}
          />
        </div>
      </ConfigSection>

      <ConfigSection
        title="Development options"
        description={(
          <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
            <AlertTriangle aria-hidden="true" className="h-4 w-4" />
            Do NOT enable in production
          </span>
        )}
        defaultExpanded={false}
        badge="E2E"
      >
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3 mb-4">
          <p className="text-sm text-yellow-800 dark:text-yellow-200">
            These options are for development and testing only. Enabling them in production may compromise security.
          </p>
        </div>
        <div className="space-y-3">
          <ToggleField
            label="Chaos headers"
            value={config.chaosHeaders ?? false}
            onChange={(v) => update('chaosHeaders', v)}
            help="Adds intentionally disruptive headers for exception-path and resilience testing. Dev/e2e only."
            disabled={disabled}
            isOverridden={isOverridden('chaosHeaders')}
          />
          <ToggleField
            label="XCLIENT Enabled"
            value={config.xclientEnabled ?? false}
            onChange={(v) => update('xclientEnabled', v)}
            help="Allow XCLIENT so test clients can forge sender/session metadata. Never enable on an untrusted production edge."
            disabled={disabled}
            isOverridden={isOverridden('xclientEnabled')}
          />
        </div>
      </ConfigSection>
    </div>
  );
}
