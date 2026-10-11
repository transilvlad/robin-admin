export const REPORTING_SETTINGS = {
  reportingCacheMiB: { default: 128, min: 16, max: 1024 },
  reportingCacheEntries: { default: 200, min: 10, max: 1000 },
  reportingCacheTtlSeconds: { default: 300, min: 5, max: 900 },
  reportingSourceConcurrency: { default: 2, min: 1, max: 8 },
  reportingSourceQueueSize: { default: 8, min: 0, max: 128 },
  reportingSourceQueueWaitMs: { default: 30000, min: 1000, max: 120000 },
} as const;
export type ReportingSettings = Record<keyof typeof REPORTING_SETTINGS, number>;
export function reportingDefaults(): ReportingSettings {
  return Object.fromEntries(Object.entries(REPORTING_SETTINGS).map(([key, rule]) => [key, rule.default])) as ReportingSettings;
}
let policy = reportingDefaults();
const listeners = new Set<() => void>();
export function reportingPolicy(): Readonly<ReportingSettings> { return policy; }
export function reportingCacheBudgetBytes(): number { return policy.reportingCacheMiB * 1024 * 1024; }
export function validateReportingSettings(updates: Record<string, unknown>): string | null {
  for (const [key, rule] of Object.entries(REPORTING_SETTINGS)) {
    if (!(key in updates)) continue;
    const value = updates[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < rule.min || value > rule.max) {
      return `${key} must be an integer between ${rule.min} and ${rule.max}`;
    }
  }
  return null;
}
export function applyReportingSettings(settings: ReportingSettings): void {
  const error = validateReportingSettings(settings);
  if (error) throw new Error(error);
  const next = { ...reportingDefaults() };
  for (const key of Object.keys(REPORTING_SETTINGS) as Array<keyof ReportingSettings>) next[key] = settings[key];
  if (Object.keys(next).every(key => next[key as keyof ReportingSettings] === policy[key as keyof ReportingSettings])) return;
  policy = next;
  for (const listener of listeners) listener();
}
export function onReportingSettingsChanged(listener: () => void): void { listeners.add(listener); }
