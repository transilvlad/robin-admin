/** UI-managed application policy within fixed safety ceilings. */
export const OBSERVABILITY_SETTINGS = {
  telemetrySourceWindowDays: { default: 7, min: 1, max: 90 },
  telemetrySilentAfterSeconds: { default: 900, min: 60, max: 86400 },
  telemetrySourceRefreshSeconds: { default: 60, min: 15, max: 3600 },
  telemetrySourceLimit: { default: 2000, min: 100, max: 5000 },
  telemetryIngestBodyLimitBytes: { default: 8388608, min: 65536, max: 67108864, env: 'TELEMETRY_INGEST_BODY_LIMIT_BYTES' },
  telemetryRequestTimeoutMs: { default: 10000, min: 1000, max: 30000, env: 'TELEMETRY_REQUEST_TIMEOUT_MS' },
  telemetryQueryMaxPoints: { default: 1500, min: 100, max: 1500 },
  telemetryQueryMaxSeries: { default: 100, min: 1, max: 100 },
  telemetryQueryMaxRangeDays: { default: 400, min: 1, max: 400 },
  monitoringConcurrency: { default: 24, min: 4, max: 128, env: 'MONITORING_CONCURRENCY' },
  monitoringManualConcurrency: { default: 8, min: 1, max: 127 },
  monitoringManualQueueSize: { default: 20, min: 1, max: 1000 },
  monitoringQueueWaitMs: { default: 30000, min: 1000, max: 120000 },
  monitoringObservationRetentionDays: { default: 30, min: 1, max: 3650, env: 'MONITORING_OBSERVATION_RETENTION_DAYS' },
  monitoringHistoryRetentionDays: { default: 400, min: 1, max: 3650, env: 'MONITORING_HISTORY_RETENTION_DAYS' },
} as const;

export type ObservabilityKey = keyof typeof OBSERVABILITY_SETTINGS;
export type ObservabilitySettings = Record<ObservabilityKey, number>;

export function observabilityDefaults(): ObservabilitySettings {
  const settings = Object.fromEntries(Object.entries(OBSERVABILITY_SETTINGS).map(([key, rule]) => {
    const raw = 'env' in rule ? process.env[rule.env] : undefined;
    const value = raw === undefined ? rule.default : Number(raw);
    if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
      throw new Error(`Invalid observability default: ${key}`);
    }
    return [key, value];
  })) as ObservabilitySettings;
  settings.monitoringManualConcurrency = Math.min(settings.monitoringManualConcurrency, settings.monitoringConcurrency - 1);
  if (settings.monitoringHistoryRetentionDays < settings.monitoringObservationRetentionDays) {
    throw new Error('Daily monitoring history retention cannot be shorter than raw retention');
  }
  return settings;
}

export function validateObservabilitySettings(updates: Record<string, unknown>, current: ObservabilitySettings): string | null {
  for (const [key, rule] of Object.entries(OBSERVABILITY_SETTINGS)) {
    if (!(key in updates)) continue;
    const value = updates[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < rule.min || value > rule.max) {
      return `${key} must be an integer between ${rule.min} and ${rule.max}`;
    }
  }
  const settings = { ...current, ...updates };
  if (settings.monitoringManualConcurrency >= settings.monitoringConcurrency) {
    return 'Manual probe concurrency must leave at least one scheduled probe slot';
  }
  if (settings.monitoringHistoryRetentionDays < settings.monitoringObservationRetentionDays) {
    return 'Daily history retention cannot be shorter than raw observation retention';
  }
  return null;
}
