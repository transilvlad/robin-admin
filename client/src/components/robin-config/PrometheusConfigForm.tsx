/**
 * Prometheus configuration form (prometheus.json5).
 */

import { ConfigSection } from './ConfigSection';
import { TextField, NumberField, ToggleField } from './ConfigField';
import { ArrayEditor, KeyValueEditor } from './ArrayEditor';
import type { PrometheusConfig } from '../../types/robin-config';

interface PrometheusConfigFormProps {
  config: Partial<PrometheusConfig>;
  onChange: (config: Partial<PrometheusConfig>) => void;
  baseConfig?: Partial<PrometheusConfig>;
  disabled?: boolean;
}

export function PrometheusConfigForm({ config, onChange, disabled }: PrometheusConfigFormProps) {
  const update = <K extends keyof PrometheusConfig>(key: K, value: PrometheusConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  return (
    <div className="space-y-4">
      <ConfigSection title="Prometheus remote write" description="Push metrics to Prometheus-compatible endpoints">
        <ToggleField
          label="Enabled"
          value={config.enabled ?? false}
          onChange={(v) => update('enabled', v)}
          help="Enable Prometheus remote write push"
          disabled={disabled}
        />

        <TextField
          label="Remote write URL"
          value={config.remoteWriteUrl ?? ''}
          onChange={(v) => update('remoteWriteUrl', v)}
          help="Prometheus remote write endpoint (Agent, VictoriaMetrics, Mimir, etc.)"
          placeholder="http://localhost:9090/api/v1/write"
          type="url"
          disabled={disabled}
        />
      </ConfigSection>

      <ConfigSection title="Push settings" description="Control how often and with what settings metrics are pushed">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <NumberField
            label="Push interval"
            value={config.intervalSeconds ?? 5}
            onChange={(v) => update('intervalSeconds', v)}
            help="Seconds between pushes"
            suffix="s"
            min={1}
            max={300}
            disabled={disabled}
          />
          <NumberField
            label="Timeout"
            value={config.timeoutSeconds ?? 10}
            onChange={(v) => update('timeoutSeconds', v)}
            help="HTTP request timeout"
            suffix="s"
            min={1}
            max={120}
            disabled={disabled}
          />
        </div>

        <ToggleField
          label="Compress"
          value={config.compress ?? true}
          onChange={(v) => update('compress', v)}
          help="Compress payload with Snappy framed (recommended by most receivers)"
          disabled={disabled}
        />
      </ConfigSection>

      <ConfigSection title="Metric filters" description="Filter which metrics are pushed">
        <ArrayEditor
          label="Include patterns"
          value={config.include ?? []}
          onChange={(v) => update('include', v)}
          help="Regex patterns for metrics to include (metric names use '_' instead of '.')"
          placeholder="^robin_.*"
          disabled={disabled}
        />
        <ArrayEditor
          label="Exclude patterns"
          value={config.exclude ?? []}
          onChange={(v) => update('exclude', v)}
          help="Regex patterns for metrics to exclude"
          placeholder="^debug_.*"
          disabled={disabled}
        />
      </ConfigSection>

      <ConfigSection title="Authentication" description="Configure authentication for the remote write endpoint">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TextField
            label="Basic auth username"
            value={config.basicAuthUser ?? ''}
            onChange={(v) => update('basicAuthUser', v)}
            help="HTTP basic auth username (optional)"
            disabled={disabled}
          />
          <TextField
            label="Basic auth password"
            value={config.basicAuthPassword ?? ''}
            onChange={(v) => update('basicAuthPassword', v)}
            help="HTTP basic auth password (optional)"
            type="password"
            disabled={disabled}
          />
        </div>
        <TextField
          label="Bearer token"
          value={config.bearerToken ?? ''}
          onChange={(v) => update('bearerToken', v)}
          help="Bearer token for Authorization header (alternative to basic auth)"
          type="password"
          disabled={disabled}
        />
      </ConfigSection>

      <ConfigSection title="Multi-Tenancy" description="Optional tenant header for multi-tenant backends">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TextField
            label="Tenant header name"
            value={config.tenantHeaderName ?? ''}
            onChange={(v) => update('tenantHeaderName', v)}
            help="Header name for tenant identification"
            placeholder="X-Scope-OrgID"
            disabled={disabled}
          />
          <TextField
            label="Tenant header value"
            value={config.tenantHeaderValue ?? ''}
            onChange={(v) => update('tenantHeaderValue', v)}
            help="Value for the tenant header"
            placeholder="robin-metrics"
            disabled={disabled}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="Labels & Headers" description="Custom labels and headers for metrics">
        <KeyValueEditor
          label="Labels"
          value={config.labels ?? {}}
          onChange={(v) => update('labels', v)}
          help="Static labels added to every metric series. Use {$hostname} for magic replacement."
          keyPlaceholder="label_name"
          valuePlaceholder="label_value"
          disabled={disabled}
        />
        <KeyValueEditor
          label="Extra headers"
          value={config.headers ?? {}}
          onChange={(v) => update('headers', v)}
          help="Additional HTTP headers to include with requests"
          keyPlaceholder="Header-Name"
          valuePlaceholder="Header-Value"
          disabled={disabled}
        />
      </ConfigSection>

      <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg space-y-2">
        <p className="text-sm font-medium text-blue-700 dark:text-blue-300">Available Metrics:</p>
        <ul className="text-sm text-blue-600 dark:text-blue-400 list-disc list-inside space-y-1">
          <li><code className="bg-blue-100 dark:bg-blue-900/40 px-1 rounded-sm">robin_*</code> - Robin-specific metrics</li>
          <li><code className="bg-blue-100 dark:bg-blue-900/40 px-1 rounded-sm">jvm_*</code> - JVM memory, GC, threads</li>
          <li><code className="bg-blue-100 dark:bg-blue-900/40 px-1 rounded-sm">process_*</code> - Process CPU, file descriptors</li>
          <li><code className="bg-blue-100 dark:bg-blue-900/40 px-1 rounded-sm">system_*</code> - System metrics</li>
        </ul>
      </div>
    </div>
  );
}
