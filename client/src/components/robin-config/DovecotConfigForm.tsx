/**
 * Dovecot configuration form (dovecot.json5).
 */

import { ConfigSection } from './ConfigSection';
import { TextField, NumberField, ToggleField, SelectField, TextAreaField } from './ConfigField';
import { ArrayEditor } from './ArrayEditor';
import type { DovecotConfig } from '../../types/robin-config';

interface DovecotConfigFormProps {
  config: Partial<DovecotConfig>;
  onChange: (config: Partial<DovecotConfig>) => void;
  baseConfig?: Partial<DovecotConfig>;
  disabled?: boolean;
}

export function DovecotConfigForm({ config, onChange, baseConfig, disabled }: DovecotConfigFormProps) {
  const update = <K extends keyof DovecotConfig>(key: K, value: DovecotConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  const isOverridden = (key: keyof DovecotConfig) => 
    baseConfig && config[key] !== undefined && JSON.stringify(config[key]) !== JSON.stringify(baseConfig[key]);

  return (
    <div className="space-y-4">
      <ConfigSection title="Dovecot integration" description="Authentication and mailbox settings">
        <div className="space-y-3">
          <ToggleField
            label="Dovecot auth enabled"
            value={config.auth ?? false}
            onChange={(v) => update('auth', v)}
            help="Enable Dovecot authentication and mailbox integration"
            disabled={disabled}
            isOverridden={isOverridden('auth')}
          />
          <ToggleField
            label="User lookup"
            value={config.userLookup ?? true}
            onChange={(v) => update('userLookup', v)}
            help="Validate RCPT TO recipients (when false, accepts without checking)"
            disabled={disabled}
            isOverridden={isOverridden('userLookup')}
          />
        </div>
      </ConfigSection>

      <ConfigSection
        title="Mail proxy authentication"
        description="Let an IMAP/POP3 proxy (nginx mail auth_http) authenticate users and resolve aliases through Robin's API."
        defaultExpanded={config.proxyAuth?.enabled ?? false}
      >
        <ToggleField
          label="Proxy authentication enabled"
          value={config.proxyAuth?.enabled ?? false}
          onChange={(v) => update('proxyAuth', { ...config.proxyAuth, enabled: v })}
          disabled={disabled}
          isOverridden={isOverridden('proxyAuth')}
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TextField
            label="IMAP backend"
            value={config.proxyAuth?.imap ?? ''}
            onChange={(v) => update('proxyAuth', { ...config.proxyAuth, imap: v })}
            help="Backend host:port; empty disables IMAP proxy authentication"
            placeholder="mailbox-backend:143"
            disabled={disabled}
          />
          <TextField
            label="POP3 backend"
            value={config.proxyAuth?.pop3 ?? ''}
            onChange={(v) => update('proxyAuth', { ...config.proxyAuth, pop3: v })}
            help="Backend host:port; empty disables POP3 proxy authentication"
            placeholder="mailbox-backend:110"
            disabled={disabled}
          />
          <NumberField
            label="Failure wait (seconds)"
            value={config.proxyAuth?.failureWait ?? 3}
            onChange={(v) => update('proxyAuth', { ...config.proxyAuth, failureWait: v })}
            min={0}
            disabled={disabled}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="Socket authentication" description="Dovecot UNIX socket backend" defaultExpanded={config.authSocket?.enabled ?? false}>
        <ToggleField
          label="Socket auth enabled"
          value={config.authSocket?.enabled ?? false}
          onChange={(v) => update('authSocket', { ...config.authSocket, enabled: v })}
          help="Enable Dovecot socket authentication backend"
          disabled={disabled}
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <TextField
            label="Auth client socket"
            value={config.authSocket?.client ?? '/run/dovecot/auth-client'}
            onChange={(v) => update('authSocket', { ...config.authSocket, client: v })}
            help="Path to Dovecot authentication client socket (SASL)"
            placeholder="/run/dovecot/auth-client"
            disabled={disabled}
          />
          <TextField
            label="Userdb socket"
            value={config.authSocket?.userdb ?? '/run/dovecot/auth-userdb'}
            onChange={(v) => update('authSocket', { ...config.authSocket, userdb: v })}
            help="Path to Dovecot userdb lookup socket"
            placeholder="/run/dovecot/auth-userdb"
            disabled={disabled}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="SQL Authentication" description="Database authentication backend">
        <ToggleField
          label="SQL Auth Enabled"
          value={config.authSql?.enabled ?? false}
          onChange={(v) => update('authSql', { ...config.authSql, enabled: v })}
          help="Enable SQL authentication backend"
          disabled={disabled}
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <TextField
            label="JDBC URL"
            value={config.authSql?.jdbcUrl ?? ''}
            onChange={(v) => update('authSql', { ...config.authSql, jdbcUrl: v })}
            help="Database connection URL"
            placeholder="jdbc:postgresql://localhost:5432/robin"
            disabled={disabled}
          />
          <TextField
            label="Username"
            value={config.authSql?.user ?? ''}
            onChange={(v) => update('authSql', { ...config.authSql, user: v })}
            placeholder="robin"
            disabled={disabled}
          />
          <TextField
            label="Password"
            value={config.authSql?.password ?? ''}
            onChange={(v) => update('authSql', { ...config.authSql, password: v })}
            type="password"
            disabled={disabled}
          />
        </div>
        <div className="space-y-4 mt-4">
          <TextAreaField
            label="Password query"
            value={config.authSql?.passwordQuery ?? ''}
            onChange={(v) => update('authSql', { ...config.authSql, passwordQuery: v })}
            help="Query to verify password. Leave blank for default pgcrypto-based verification."
            placeholder="SELECT password FROM users WHERE email = ?"
            rows={2}
            disabled={disabled}
          />
          <TextAreaField
            label="User query"
            value={config.authSql?.userQuery ?? ''}
            onChange={(v) => update('authSql', { ...config.authSql, userQuery: v })}
            help="Query for user lookup (returns home, uid, gid, mail)"
            placeholder="SELECT home, uid, gid, maildir AS mail FROM users WHERE email = ?"
            rows={2}
            disabled={disabled}
          />
          <TextAreaField
            label="Users query"
            value={config.authSql?.usersQuery ?? ''}
            onChange={(v) => update('authSql', { ...config.authSql, usersQuery: v })}
            help="Query to list users for integration API"
            placeholder="SELECT email FROM users"
            rows={2}
            disabled={disabled}
          />
          <TextAreaField
            label="Domain query"
            value={config.authSql?.domainQuery ?? ''}
            onChange={(v) => update('authSql', { ...config.authSql, domainQuery: v })}
            help="Query to check if a domain is served"
            placeholder="SELECT 1 FROM users WHERE email LIKE '%@' || ?"
            rows={2}
            disabled={disabled}
          />
          <TextAreaField
            label="Alias query"
            value={config.authSql?.aliasQuery ?? ''}
            onChange={(v) => update('authSql', { ...config.authSql, aliasQuery: v })}
            help="Query to resolve aliases to real destination addresses"
            placeholder="SELECT destination FROM aliases WHERE source = ?"
            rows={2}
            disabled={disabled}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="LMTP Delivery" description="LMTP backend for distributed setups">
        <ToggleField
          label="LMTP Enabled"
          value={config.saveLmtp?.enabled ?? false}
          onChange={(v) => update('saveLmtp', { ...config.saveLmtp, enabled: v })}
          help="Enable LMTP delivery backend (recommended for distributed setups)"
          disabled={disabled}
        />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
          <NumberField
            label="Port"
            value={config.saveLmtp?.port ?? 24}
            onChange={(v) => update('saveLmtp', { ...config.saveLmtp, port: v })}
            help="LMTP server port"
            min={1}
            max={65535}
            disabled={disabled}
          />
          <ToggleField
            label="TLS"
            value={config.saveLmtp?.tls ?? false}
            onChange={(v) => update('saveLmtp', { ...config.saveLmtp, tls: v })}
            help="Enable TLS for LMTP connections"
            disabled={disabled}
          />
          <NumberField
            label="Pool size"
            value={config.saveLmtp?.connectionPoolSize ?? 50}
            onChange={(v) => update('saveLmtp', { ...config.saveLmtp, connectionPoolSize: v })}
            help="Maximum pooled connections"
            min={1}
            disabled={disabled}
          />
          <NumberField
            label="Pool timeout"
            value={config.saveLmtp?.connectionPoolTimeoutSeconds ?? 60}
            onChange={(v) => update('saveLmtp', { ...config.saveLmtp, connectionPoolTimeoutSeconds: v })}
            help="Max wait time for connection from pool"
            suffix="sec"
            min={1}
            disabled={disabled}
          />
          <NumberField
            label="Idle timeout"
            value={config.saveLmtp?.connectionIdleTimeoutSeconds ?? 270}
            onChange={(v) => update('saveLmtp', { ...config.saveLmtp, connectionIdleTimeoutSeconds: v })}
            help="Close idle connections after (< Dovecot's 5 min timeout)"
            suffix="sec"
            min={1}
            disabled={disabled}
          />
          <NumberField
            label="Max lifetime"
            value={config.saveLmtp?.connectionMaxLifetimeSeconds ?? 1800}
            onChange={(v) => update('saveLmtp', { ...config.saveLmtp, connectionMaxLifetimeSeconds: v })}
            help="Close connections after (regardless of activity)"
            suffix="sec"
            min={1}
            disabled={disabled}
          />
          <NumberField
            label="Max messages/connection"
            value={config.saveLmtp?.connectionMaxMessagesPerConnection ?? 100}
            onChange={(v) => update('saveLmtp', { ...config.saveLmtp, connectionMaxMessagesPerConnection: v })}
            help="Recycle connection after N messages"
            min={1}
            disabled={disabled}
          />
        </div>
        <div className="mt-4">
          <ArrayEditor
            label="LMTP Servers"
            value={config.saveLmtp?.servers ?? ['127.0.0.1']}
            onChange={(v) => update('saveLmtp', { ...config.saveLmtp, servers: v })}
            help="List of LMTP server addresses"
            placeholder="127.0.0.1"
            disabled={disabled}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="LDA Delivery" description="Local Delivery Agent (same container/host)" defaultExpanded={config.saveLda?.enabled ?? false}>
        <ToggleField
          label="LDA Enabled"
          value={config.saveLda?.enabled ?? false}
          onChange={(v) => update('saveLda', { ...config.saveLda, enabled: v })}
          help="Enable Dovecot LDA delivery (requires Robin and Dovecot on same host)"
          disabled={disabled}
        />
        <div className="space-y-3 mt-4">
          <ToggleField
            label="Inline delivery"
            value={config.saveLda?.inline ?? false}
            onChange={(v) => update('saveLda', { ...config.saveLda, inline: v })}
            help="Deliver during SMTP receipt (vs queue for async relay)"
            disabled={disabled}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
          <TextField
            label="LDA Binary"
            value={config.saveLda?.ldaBinary ?? '/usr/libexec/dovecot/dovecot-lda'}
            onChange={(v) => update('saveLda', { ...config.saveLda, ldaBinary: v })}
            help="Path to Dovecot LDA binary"
            placeholder="/usr/libexec/dovecot/dovecot-lda"
            disabled={disabled}
          />
          <TextField
            label="Inbox folder"
            value={config.saveLda?.inboxFolder ?? 'INBOX'}
            onChange={(v) => update('saveLda', { ...config.saveLda, inboxFolder: v })}
            help="Folder for inbound email delivery"
            placeholder="INBOX"
            disabled={disabled}
          />
          <TextField
            label="Sent folder"
            value={config.saveLda?.sentFolder ?? 'Sent'}
            onChange={(v) => update('saveLda', { ...config.saveLda, sentFolder: v })}
            help="Folder for outbound email delivery"
            placeholder="Sent"
            disabled={disabled}
          />
          <NumberField
            label="Max concurrency"
            value={config.saveLda?.maxConcurrency ?? 50}
            onChange={(v) => update('saveLda', { ...config.saveLda, maxConcurrency: v })}
            help="Limit concurrent LDA subprocesses"
            min={1}
            disabled={disabled}
          />
          <NumberField
            label="Timeout"
            value={config.saveLda?.ldaTimeoutSeconds ?? 30}
            onChange={(v) => update('saveLda', { ...config.saveLda, ldaTimeoutSeconds: v })}
            help="LDA subprocess execution timeout"
            suffix="sec"
            min={1}
            disabled={disabled}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="Delivery options" description="Shared delivery settings">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <NumberField
            label="Max save attempts"
            value={config.inlineSaveMaxAttempts ?? 2}
            onChange={(v) => update('inlineSaveMaxAttempts', v)}
            help="Maximum attempts to save an email"
            min={1}
            disabled={disabled}
            isOverridden={isOverridden('inlineSaveMaxAttempts')}
          />
          <NumberField
            label="Retry delay"
            value={config.inlineSaveRetryDelay ?? 3}
            onChange={(v) => update('inlineSaveRetryDelay', v)}
            help="Delay between save attempts"
            suffix="sec"
            min={1}
            disabled={disabled}
            isOverridden={isOverridden('inlineSaveRetryDelay')}
          />
          <SelectField
            label="Failure behaviour"
            value={config.failureBehaviour ?? 'retry'}
            onChange={(v) => update('failureBehaviour', v as 'retry' | 'bounce')}
            options={[
              { value: 'retry', label: 'Retry later' },
              { value: 'bounce', label: 'Bounce immediately' },
            ]}
            help="Action on delivery failure"
            disabled={disabled}
            isOverridden={isOverridden('failureBehaviour')}
          />
          <NumberField
            label="Max retry count"
            value={config.maxRetryCount ?? 10}
            onChange={(v) => update('maxRetryCount', v)}
            help="Maximum retry attempts before bounce"
            min={1}
            disabled={disabled}
            isOverridden={isOverridden('maxRetryCount')}
          />
        </div>
      </ConfigSection>
    </div>
  );
}
