export const MODULE_ALERT_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MODULE_ALERT_CATEGORY = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MODULE_ALERT_LEVELS = { info: 0, warning: 1, critical: 2 } as const;
export type ModuleAlertSeverity = keyof typeof MODULE_ALERT_LEVELS;

export interface ModuleAlertPublisher {
  apiKeyId: number;
  requirePaid: boolean;
  link: { path: string; parameter: string };
  categories: Record<string, { label: string; maxSeverity: ModuleAlertSeverity }>;
}

export function isModuleAlertSeverity(value: unknown): value is ModuleAlertSeverity {
  return typeof value === 'string' && Object.hasOwn(MODULE_ALERT_LEVELS, value);
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseModuleAlertPublishers(raw: string): Record<string, ModuleAlertPublisher> {
  if (!raw.trim()) return {};
  const error = new Error('Invalid MODULE_ALERT_PUBLISHERS_JSON');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw error;
  }
  if (!object(data) || Object.keys(data).length > 32) throw error;
  const keys = new Set<number>();
  const publishers: Record<string, ModuleAlertPublisher> = Object.create(null);
  for (const [slug, publisher] of Object.entries(data)) {
    if (!MODULE_ALERT_SLUG.test(slug) || !object(publisher)) throw error;
    const { apiKeyId, requirePaid = true, link, categories } = publisher;
    if (
      typeof apiKeyId !== 'number' || !Number.isSafeInteger(apiKeyId) || apiKeyId < 1 || keys.has(apiKeyId)
      || typeof requirePaid !== 'boolean'
      || !object(link) || typeof link.path !== 'string' || link.path.length > 120
      || !/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(link.path)
      || typeof link.parameter !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(link.parameter)
      || !object(categories) || !Object.keys(categories).length || Object.keys(categories).length > 16
    ) throw error;
    const allowed: ModuleAlertPublisher['categories'] = Object.create(null);
    for (const [category, definition] of Object.entries(categories)) {
      if (
        !MODULE_ALERT_CATEGORY.test(category) || !object(definition)
        || typeof definition.label !== 'string' || !/^[\p{L}\p{N} ._-]{1,100}$/u.test(definition.label)
        || !isModuleAlertSeverity(definition.maxSeverity)
      ) throw error;
      allowed[category] = { label: definition.label, maxSeverity: definition.maxSeverity };
    }
    publishers[slug] = { apiKeyId, requirePaid, link: { path: link.path, parameter: link.parameter }, categories: allowed };
    keys.add(apiKeyId);
  }
  return publishers;
}
