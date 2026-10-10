/**
 * Canonical registry of fleet service types.
 *
 * This is the SINGLE source of truth for the set of service types robin-admin
 * manages. The union type, DB CHECK constraints, DSN protocols,
 * and request validation all derive from `FLEET_SERVICE_TYPES` so
 * a new service type is added in exactly one place here plus its own service
 * module — never by editing a copy-pasted union.
 */

export const FLEET_SERVICE_TYPES = ['robin', 'rspamd', 'clamav', 'dovecot', 'postfix', 'redis', 'postgres', 'mariadb'] as const;

export type FleetServiceType = (typeof FLEET_SERVICE_TYPES)[number];

const FLEET_SERVICE_TYPE_SET = new Set<string>(FLEET_SERVICE_TYPES);

export function isFleetServiceType(value: unknown): value is FleetServiceType {
  return typeof value === 'string' && FLEET_SERVICE_TYPE_SET.has(value);
}

/**
 * Validate an optional `serviceType` query/body value. Returns undefined for an
 * absent value, the narrowed type for a valid one, and throws for an invalid one
 * (callers surface the message as a 400). Used by every route that scopes by type.
 */
export function parseServiceType(value: unknown): FleetServiceType | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (isFleetServiceType(value)) {
    return value;
  }
  throw new Error(`serviceType must be one of: ${FLEET_SERVICE_TYPES.join(', ')}`);
}

/** SQL fragment for the CHECK constraint / IN clause, e.g. `'robin', 'rspamd', ...`. */
export function serviceTypeSqlList(): string {
  return FLEET_SERVICE_TYPES.map((type) => `'${type}'`).join(', ');
}

/**
 * Database types are reached with a connection string in `metricsUrl` rather
 * than an http(s) URL: the URL protocols each accepts.
 */
export const DSN_PROTOCOLS: Partial<Record<FleetServiceType, readonly string[]>> = {
  redis: ['redis:', 'rediss:'],
  postgres: ['postgres:', 'postgresql:'],
  mariadb: ['mysql:', 'mariadb:'],
};
