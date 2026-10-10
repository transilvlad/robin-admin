export const OPERATIONS_SETTINGS = {
  alertEvaluationIntervalMs: { default: 30000, min: 5000, max: 300000 },
  alertDeliveryIntervalMs: { default: 5000, min: 1000, max: 30000 },
  alertDeliveryConcurrency: { default: 4, min: 1, max: 16 },
  alertDeliveryExpiryMs: { default: 3600000, min: 60000, max: 2592000000 },
  alertDeliveryMaxAttempts: { default: 5, min: 1, max: 10 },
  alertRetryBaseMs: { default: 30000, min: 1000, max: 300000 },
  alertRetryMaxMs: { default: 900000, min: 1000, max: 3600000 },
  fleetAgentOnlineThresholdMs: { default: 90000, min: 30000, max: 600000 },
  fleetCommandTimeoutMs: { default: 20000, min: 1000, max: 120000 },
  fleetCommandLeaseMs: { default: 30000, min: 5000, max: 120000 },
  fleetCommandPollWaitMs: { default: 25000, min: 1000, max: 25000 },
  fleetCommandBatchSize: { default: 20, min: 1, max: 20 },
  reportingIngestMaxMiB: { default: 5, min: 1, max: 20 },
} as const;
export type OperationsSettings = Record<keyof typeof OPERATIONS_SETTINGS, number> & {
  alertsEnabled: boolean;
  alertInstanceName: string;
};
export const OPERATIONS_KEYS = [...Object.keys(OPERATIONS_SETTINGS), 'alertsEnabled', 'alertInstanceName'];
export function operationsDefaults(): OperationsSettings {
  return { ...Object.fromEntries(Object.entries(OPERATIONS_SETTINGS).map(([key, rule]) => [key, rule.default])),
    alertsEnabled: false, alertInstanceName: 'Robin Admin' } as OperationsSettings;
}
let policy = operationsDefaults();
export function operationsPolicy(): Readonly<OperationsSettings> { return policy; }
export function validateOperationsSettings(updates: Record<string, unknown>, current = policy): string | null {
  for (const [key, rule] of Object.entries(OPERATIONS_SETTINGS)) {
    if (!(key in updates)) continue;
    const value = updates[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < rule.min || value > rule.max) {
      return `${key} must be an integer between ${rule.min} and ${rule.max}`;
    }
  }
  if ('alertsEnabled' in updates && typeof updates.alertsEnabled !== 'boolean') return 'alertsEnabled must be boolean';
  if ('alertInstanceName' in updates && (typeof updates.alertInstanceName !== 'string' || !updates.alertInstanceName.trim()
    || updates.alertInstanceName.length > 100 || /[\r\n\x00]/.test(updates.alertInstanceName))) return 'alertInstanceName must be a single-line name of 1 to 100 characters';
  const next = { ...current, ...updates };
  if (next.alertRetryMaxMs < next.alertRetryBaseMs) return 'Maximum retry delay must be at least the base retry delay';
  if (next.fleetCommandLeaseMs < next.fleetCommandPollWaitMs + 1000) return 'Command lease must exceed the poll wait by at least 1000 ms';
  if (next.fleetAgentOnlineThresholdMs < next.fleetCommandPollWaitMs + 5000) return 'Agent online window must exceed the poll wait by at least 5000 ms';
  return null;
}
export function applyOperationsSettings(settings: OperationsSettings): void {
  const error = validateOperationsSettings(settings);
  if (error) throw new Error(error);
  const next = operationsDefaults();
  for (const key of Object.keys(OPERATIONS_SETTINGS) as Array<keyof typeof OPERATIONS_SETTINGS>) next[key] = settings[key];
  next.alertsEnabled = settings.alertsEnabled;
  next.alertInstanceName = settings.alertInstanceName.trim();
  policy = next;
}
