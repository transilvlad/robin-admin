/**
 * Webhooks configuration form (webhooks.json5).
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { ConfigSection } from './ConfigSection';
import { TextField, NumberField, ToggleField, SelectField } from './ConfigField';
import { KeyValueEditor } from './ArrayEditor';
import type { WebhooksConfig, WebhookConfig } from '../../types/robin-config';

interface WebhooksConfigFormProps {
  config: Partial<WebhooksConfig>;
  onChange: (config: Partial<WebhooksConfig>) => void;
  baseConfig?: Partial<WebhooksConfig>;
  disabled?: boolean;
}

const WEBHOOK_EVENTS = [
  { key: 'ehlo', label: 'EHLO/HELO', description: 'Initial connection command' },
  { key: 'starttls', label: 'STARTTLS', description: 'TLS negotiation command' },
  { key: 'auth', label: 'AUTH', description: 'Authentication command' },
  { key: 'mail', label: 'MAIL FROM', description: 'Sender command' },
  { key: 'rcpt', label: 'RCPT TO', description: 'Recipient command' },
  { key: 'data', label: 'DATA', description: 'Message data command' },
  { key: 'bdat', label: 'BDAT', description: 'Binary data command (CHUNKING)' },
  { key: 'raw', label: 'RAW', description: 'Raw message content (after DATA/BDAT)' },
  { key: 'rset', label: 'RSET', description: 'Reset transaction command' },
  { key: 'help', label: 'HELP', description: 'Help command' },
  { key: 'quit', label: 'QUIT', description: 'Connection close command' },
  { key: 'lhlo', label: 'LHLO', description: 'LMTP hello command' },
] as const;

type WebhookKey = keyof WebhooksConfig;

function WebhookEditor({
  eventKey,
  label,
  description,
  webhook,
  onChange,
  disabled,
}: {
  eventKey: string;
  label: string;
  description: string;
  webhook: Partial<WebhookConfig>;
  onChange: (webhook: Partial<WebhookConfig>) => void;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(webhook.enabled ?? false);

  const update = <K extends keyof WebhookConfig>(key: K, value: WebhookConfig[K]) => {
    onChange({ ...webhook, [key]: value });
  };

  return (
    <div className="border border-gray-200 dark:border-robin-gray-700 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 p-3 bg-gray-50 dark:bg-robin-gray-900 hover:bg-gray-100 dark:hover:bg-robin-gray-800 text-left"
      >
        {expanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
        <div className="flex-1">
          <span className="font-medium">{label}</span>
          <span className="text-sm text-gray-500 ml-2">— {description}</span>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-sm ${webhook.enabled ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-500 dark:bg-robin-gray-700 dark:text-gray-400'}`}>
          {webhook.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </button>
      {expanded && (
        <div className="p-4 space-y-4">
          <ToggleField
            label="Enabled"
            value={webhook.enabled ?? false}
            onChange={(v) => update('enabled', v)}
            help={`Enable webhook for ${label}`}
            disabled={disabled}
          />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <TextField
              label="URL"
              value={webhook.url ?? ''}
              onChange={(v) => update('url', v)}
              help="Webhook endpoint URL"
              placeholder={`http://localhost:8000/webhooks/${eventKey}`}
              type="url"
              disabled={disabled}
            />
            <SelectField
              label="Method"
              value={webhook.method ?? 'POST'}
              onChange={(v) => update('method', v as WebhookConfig['method'])}
              options={[
                { value: 'GET', label: 'GET' },
                { value: 'POST', label: 'POST' },
                { value: 'PUT', label: 'PUT' },
                { value: 'PATCH', label: 'PATCH' },
                { value: 'DELETE', label: 'DELETE' },
              ]}
              disabled={disabled}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <NumberField
              label="Timeout"
              value={webhook.timeout ?? 5000}
              onChange={(v) => update('timeout', v)}
              help="Timeout in milliseconds"
              suffix="ms"
              min={100}
              disabled={disabled}
            />
            <SelectField
              label="Direction"
              value={webhook.direction ?? 'both'}
              onChange={(v) => update('direction', v as WebhookConfig['direction'])}
              options={[
                { value: 'both', label: 'Both' },
                { value: 'inbound', label: 'Inbound only' },
                { value: 'outbound', label: 'Outbound only' },
              ]}
              help="Filter by message direction"
              disabled={disabled}
            />
          </div>

          <div className="space-y-3">
            <ToggleField
              label="Wait for response"
              value={webhook.waitForResponse ?? true}
              onChange={(v) => update('waitForResponse', v)}
              help="Wait for webhook response before processing (fire-and-forget if false)"
              disabled={disabled}
            />
            <ToggleField
              label="Ignore errors"
              value={webhook.ignoreErrors ?? false}
              onChange={(v) => update('ignoreErrors', v)}
              help="Continue processing if webhook fails"
              disabled={disabled}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SelectField
              label="Auth type"
              value={webhook.authType ?? 'none'}
              onChange={(v) => update('authType', v as WebhookConfig['authType'])}
              options={[
                { value: 'none', label: 'None' },
                { value: 'basic', label: 'Basic' },
                { value: 'bearer', label: 'Bearer token' },
              ]}
              disabled={disabled}
            />
            <TextField
              label="Auth value"
              value={webhook.authValue ?? ''}
              onChange={(v) => update('authValue', v)}
              help="username:password for basic, token for bearer"
              type="password"
              disabled={disabled}
            />
          </div>

          <div className="space-y-3">
            <ToggleField
              label="Include session"
              value={webhook.includeSession ?? true}
              onChange={(v) => update('includeSession', v)}
              help="Include session data in payload"
              disabled={disabled}
            />
            <ToggleField
              label="Include envelope"
              value={webhook.includeEnvelope ?? true}
              onChange={(v) => update('includeEnvelope', v)}
              help="Include envelope data in payload"
              disabled={disabled}
            />
            <ToggleField
              label="Include verb"
              value={webhook.includeVerb ?? true}
              onChange={(v) => update('includeVerb', v)}
              help="Include SMTP command/verb data in payload"
              disabled={disabled}
            />
            {eventKey === 'raw' && (
              <ToggleField
                label="Base64 Encode"
                value={webhook.base64 ?? false}
                onChange={(v) => update('base64', v)}
                help="Base64 encode the raw email content"
                disabled={disabled}
              />
            )}
          </div>

          <KeyValueEditor
            label="Custom headers"
            value={webhook.headers ?? {}}
            onChange={(v) => update('headers', v)}
            help="Additional HTTP headers to include"
            keyPlaceholder="Header-Name"
            valuePlaceholder="Header-Value"
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}

export function WebhooksConfigForm({ config, onChange, disabled }: WebhooksConfigFormProps) {
  const updateWebhook = (key: WebhookKey, webhook: Partial<WebhookConfig>) => {
    onChange({ ...config, [key]: webhook });
  };

  return (
    <div className="space-y-4">
      <ConfigSection title="SMTP Event Webhooks" description="HTTP callbacks for SMTP protocol events">
        <div className="space-y-2">
          {WEBHOOK_EVENTS.map(({ key, label, description }) => (
            <WebhookEditor
              key={key}
              eventKey={key}
              label={label}
              description={description}
              webhook={(config[key as WebhookKey] as Partial<WebhookConfig>) ?? {}}
              onChange={(w) => updateWebhook(key as WebhookKey, w)}
              disabled={disabled}
            />
          ))}
        </div>
      </ConfigSection>

      <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg space-y-2">
        <p className="text-sm font-medium text-blue-700 dark:text-blue-300">Webhook Response Format:</p>
        <p className="text-sm text-blue-600 dark:text-blue-400">
          Return <code className="bg-blue-100 dark:bg-blue-900/40 px-1 rounded-sm">{`{"smtpResponse": "250 OK"}`}</code> to override the SMTP response.
          HTTP 200 without smtpResponse continues normally. HTTP 4xx/5xx returns "451 4.3.2 Internal server error".
        </p>
      </div>
    </div>
  );
}
