import type { PoolClient } from 'pg';
import { getClient } from '../../db/connection.js';
import { MONITORING_CHECK_TYPES, MONITORING_TARGET_TYPES, type MonitoringCheckOptions, type MonitoringCheckType, type MonitoringTargetType } from '../../types/monitoring.js';
import { MonitoringInputError, parseMonitoringOptions, validateMonitoringProtocol } from './options.js';

const FORMAT = 'robin-admin-monitoring';
const MAX_ROWS = 500;
const MAX_IMPORT_BODY_BYTES = 1_000_000;
const IMPORT_ENVELOPE_BYTES = Buffer.byteLength('{"configuration":,"dryRun":true}');
const MAX_CONFIGURATION_BYTES = MAX_IMPORT_BODY_BYTES - IMPORT_ENVELOPE_BYTES;

interface TargetConfig {
  name: string;
  targetType: MonitoringTargetType;
  environment: string;
  description: string | null;
  enabled: boolean;
}

interface CheckConfig {
  target: { name: string; environment: string };
  name: string;
  checkType: MonitoringCheckType;
  endpoint: string;
  port: number | null;
  intervalSeconds: number;
  timeoutSeconds: number;
  confirmationSeconds: number;
  recoverySeconds: number;
  certExpiryDays: number | null;
  tlsMode: 'strict' | 'allow_self_signed';
  certificateErrorMode: 'down' | 'warning';
  allowPrivate: boolean;
  options: MonitoringCheckOptions;
  enabled: boolean;
}

interface SectionConfig { name: string; position: number; enabled: boolean; }
interface ComponentCheckConfig { target: { name: string; environment: string }; name: string; }
interface ComponentConfig {
  section: string;
  publicName: string;
  description: string | null;
  position: number;
  enabled: boolean;
  showHistory: boolean;
  checks: ComponentCheckConfig[];
}

export interface MonitoringConfiguration {
  format: typeof FORMAT;
  version: 1;
  targets: TargetConfig[];
  checks: CheckConfig[];
  sections: SectionConfig[];
  components: ComponentConfig[];
}

export interface MonitoringImportReport {
  changes: Array<{ resource: 'target' | 'check' | 'section' | 'component'; action: 'create' | 'update'; identity: string }>;
  conflicts: Array<{ path: string; message: string }>;
  errors: Array<{ path: string; message: string }>;
}

interface ExistingTarget { id: number; name: string; environment: string; }
interface ExistingCheck { id: number; target_id: number; name: string; secret_header_names: string[]; }
interface ExistingSection { id: number; name: string; }
interface ExistingComponent { id: number; section_id: number; section_name: string; public_name: string; }

interface Planned<T> { value: T; key: string; id: number | null; path: string; }
interface ImportPlan {
  report: MonitoringImportReport;
  targets: Planned<TargetConfig>[];
  checks: Array<Planned<CheckConfig> & { targetKey: string }>;
  sections: Planned<SectionConfig>[];
  components: Array<Planned<ComponentConfig> & { checkKeys: string[] }>;
}

const identityKey = (...parts: string[]) => JSON.stringify(parts);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function fail(message: string): never { throw new MonitoringInputError(message); }

function record(value: unknown, path: string, keys: string[]): Record<string, unknown> {
  if (!isRecord(value)) fail(`${path} must be an object`);
  if (Object.keys(value).some(key => !keys.includes(key))) fail(`${path} contains unsupported settings`);
  return value;
}
function stringValue(value: unknown, path: string, max: number, required = true): string | null {
  if (value === null && !required) return null;
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) fail(`${path} must be ${required ? 'a non-empty ' : 'a '}string of at most ${max} characters`);
  return required ? value.trim() : value;
}
function boolValue(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(`${path} must be a boolean`);
  return value;
}
function intValue(value: unknown, path: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail(`${path} must be an integer between ${min} and ${max}`);
  return value;
}
function nullableInt(value: unknown, path: string, min: number, max: number): number | null {
  if (value === undefined || value === null) return null;
  return intValue(value, path, min, max, min);
}
function oneOf<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail(`${path} must be one of: ${values.join(', ')}`);
  return value as T;
}
function arrayValue(value: unknown, path: string, report: MonitoringImportReport): unknown[] {
  if (!Array.isArray(value)) { report.errors.push({ path, message: `${path} must be an array` }); return []; }
  if (value.length > MAX_ROWS) { report.errors.push({ path, message: `${path} cannot contain more than ${MAX_ROWS} entries` }); return []; }
  return value;
}
function row<T>(items: unknown[], path: string, report: MonitoringImportReport, parse: (value: unknown, path: string) => T): T[] {
  const parsed: T[] = [];
  items.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    try { parsed.push(parse(item, itemPath)); }
    catch (error) { report.errors.push({ path: itemPath, message: error instanceof Error ? error.message : 'Invalid row' }); }
  });
  return parsed;
}

function parseTarget(value: unknown, path: string): TargetConfig {
  const data = record(value, path, ['name', 'targetType', 'environment', 'description', 'enabled']);
  return {
    name: stringValue(data.name, `${path}.name`, 160)!,
    targetType: oneOf(data.targetType, MONITORING_TARGET_TYPES, `${path}.targetType`),
    environment: stringValue(data.environment, `${path}.environment`, 40)!,
    description: stringValue(data.description ?? null, `${path}.description`, 1_000_000, false),
    enabled: boolValue(data.enabled, `${path}.enabled`, true),
  };
}

function parseCheck(value: unknown, path: string): CheckConfig {
  const data = record(value, path, ['target', 'name', 'checkType', 'endpoint', 'port', 'intervalSeconds', 'timeoutSeconds', 'confirmationSeconds', 'recoverySeconds', 'certExpiryDays', 'tlsMode', 'certificateErrorMode', 'allowPrivate', 'options', 'enabled']);
  const target = record(data.target, `${path}.target`, ['name', 'environment']);
  const targetRef = { name: stringValue(target.name, `${path}.target.name`, 160)!, environment: stringValue(target.environment, `${path}.target.environment`, 40)! };
  const checkType = oneOf(data.checkType, MONITORING_CHECK_TYPES.filter((type) => type !== 'push'), `${path}.checkType`);
  const endpoint = stringValue(data.endpoint, `${path}.endpoint`, 500)!;
  const port = nullableInt(data.port, `${path}.port`, 1, 65535);
  const certExpiryDays = nullableInt(data.certExpiryDays, `${path}.certExpiryDays`, 1, 365);
  const tlsMode = oneOf(data.tlsMode ?? 'strict', ['strict', 'allow_self_signed'] as const, `${path}.tlsMode`);
  const certificateErrorMode = oneOf(data.certificateErrorMode ?? 'down', ['down', 'warning'] as const, `${path}.certificateErrorMode`);
  const options = parseMonitoringOptions(checkType, data.options, port);
  const normalized: CheckConfig = {
    target: targetRef,
    name: stringValue(data.name, `${path}.name`, 160)!,
    checkType,
    endpoint,
    port,
    intervalSeconds: intValue(data.intervalSeconds, `${path}.intervalSeconds`, 10, 86400, 60),
    timeoutSeconds: intValue(data.timeoutSeconds, `${path}.timeoutSeconds`, 1, 120, checkType === 'http' ? 10 : 5),
    confirmationSeconds: intValue(data.confirmationSeconds, `${path}.confirmationSeconds`, 0, 86400, 180),
    recoverySeconds: intValue(data.recoverySeconds, `${path}.recoverySeconds`, 0, 86400, 180),
    certExpiryDays,
    tlsMode,
    certificateErrorMode,
    allowPrivate: boolValue(data.allowPrivate, `${path}.allowPrivate`, false),
    options,
    enabled: boolValue(data.enabled, `${path}.enabled`, true),
  };
  validateMonitoringProtocol({ ...normalized, checkType, options });
  return normalized;
}

function parseSection(value: unknown, path: string): SectionConfig {
  const data = record(value, path, ['name', 'position', 'enabled']);
  return {
    name: stringValue(data.name, `${path}.name`, 160)!,
    position: intValue(data.position, `${path}.position`, 0, 10000, 0),
    enabled: boolValue(data.enabled, `${path}.enabled`, true),
  };
}

function parseComponent(value: unknown, path: string): ComponentConfig {
  const data = record(value, path, ['section', 'publicName', 'description', 'position', 'enabled', 'showHistory', 'checks']);
  const rawChecks = data.checks === undefined ? [] : data.checks;
  if (!Array.isArray(rawChecks) || rawChecks.length > MAX_ROWS) fail(`${path}.checks must be an array with at most ${MAX_ROWS} entries`);
  const checks = rawChecks.map((raw, index) => {
    const checkPath = `${path}.checks[${index}]`;
    const item = record(raw, checkPath, ['target', 'name']);
    const target = record(item.target, `${checkPath}.target`, ['name', 'environment']);
    return {
      target: {
        name: stringValue(target.name, `${checkPath}.target.name`, 160)!,
        environment: stringValue(target.environment, `${checkPath}.target.environment`, 40)!,
      },
      name: stringValue(item.name, `${checkPath}.name`, 160)!,
    };
  });
  return {
    section: stringValue(data.section, `${path}.section`, 160)!,
    publicName: stringValue(data.publicName, `${path}.publicName`, 180)!,
    description: stringValue(data.description ?? null, `${path}.description`, 1_000_000, false),
    position: intValue(data.position, `${path}.position`, 0, 10000, 0),
    enabled: boolValue(data.enabled, `${path}.enabled`, true),
    showHistory: boolValue(data.showHistory, `${path}.showHistory`, true),
    checks,
  };
}

function parseConfiguration(raw: unknown, report: MonitoringImportReport): MonitoringConfiguration | null {
  if (!isRecord(raw)) {
    report.errors.push({ path: 'configuration', message: 'configuration must be an object' });
    return null;
  }
  let serialized: string;
  try { serialized = JSON.stringify(raw); }
  catch {
    report.errors.push({ path: 'configuration', message: 'configuration cannot be serialized as JSON' });
    return null;
  }
  if (Buffer.byteLength(serialized) > MAX_CONFIGURATION_BYTES) {
    report.errors.push({ path: 'configuration', message: `configuration cannot exceed ${MAX_CONFIGURATION_BYTES.toLocaleString()} bytes` });
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!['format', 'version', 'targets', 'checks', 'sections', 'components'].includes(key)) report.errors.push({ path: `configuration.${key}`, message: 'Unsupported configuration property' });
  }
  if (raw.format !== FORMAT) report.errors.push({ path: 'configuration.format', message: `format must be ${FORMAT}` });
  if (raw.version !== 1) report.errors.push({ path: 'configuration.version', message: 'Only configuration version 1 is supported' });
  const targets = row(arrayValue(raw.targets, 'configuration.targets', report), 'configuration.targets', report, parseTarget);
  const checks = row(arrayValue(raw.checks, 'configuration.checks', report), 'configuration.checks', report, parseCheck);
  const sections = row(arrayValue(raw.sections, 'configuration.sections', report), 'configuration.sections', report, parseSection);
  const components = row(arrayValue(raw.components, 'configuration.components', report), 'configuration.components', report, parseComponent);
  return { format: FORMAT, version: 1, targets, checks, sections, components };
}

function buildPlan(configuration: MonitoringConfiguration | null, report: MonitoringImportReport, existing: {
  targets: ExistingTarget[]; checks: ExistingCheck[]; sections: ExistingSection[]; components: ExistingComponent[];
}): ImportPlan {
  const plan: ImportPlan = { report, targets: [], checks: [], sections: [], components: [] };
  if (!configuration) return plan;
  const targetExisting = new Map<string, ExistingTarget[]>();
  for (const target of existing.targets) {
    const key = identityKey(target.name, target.environment);
    targetExisting.set(key, [...(targetExisting.get(key) ?? []), target]);
  }
  const targetSeen = new Set<string>();
  for (const value of configuration.targets) {
    const key = identityKey(value.name, value.environment);
    if (targetSeen.has(key)) { report.conflicts.push({ path: 'configuration.targets', message: `Duplicate target identity: ${value.name} (${value.environment})` }); continue; }
    targetSeen.add(key);
    const matches = targetExisting.get(key) ?? [];
    if (matches.length > 1) report.conflicts.push({ path: 'configuration.targets', message: `Target identity is ambiguous: ${value.name} (${value.environment})` });
    else {
      const id = matches[0]?.id ?? null;
      plan.targets.push({ value, key, id, path: 'configuration.targets' });
      report.changes.push({ resource: 'target', action: id === null ? 'create' : 'update', identity: `${value.name} (${value.environment})` });
    }
  }
  const targetIdByKey = new Map<string, number>();
  for (const target of existing.targets) targetIdByKey.set(identityKey(target.name, target.environment), target.id);
  for (const target of plan.targets) if (target.id !== null) targetIdByKey.set(target.key, target.id);
  const checkExisting = new Map<string, ExistingCheck[]>();
  for (const check of existing.checks) {
    const target = existing.targets.find(item => item.id === check.target_id);
    if (!target) continue;
    const key = identityKey(target.name, target.environment, check.name);
    checkExisting.set(key, [...(checkExisting.get(key) ?? []), check]);
  }
  const checkSeen = new Set<string>();
  for (const value of configuration.checks) {
    const targetKey = identityKey(value.target.name, value.target.environment);
    if ((targetExisting.get(targetKey) ?? []).length > 1) {
      report.conflicts.push({ path: 'configuration.checks', message: `Target identity is ambiguous for check ${value.name}: ${value.target.name} (${value.target.environment})` });
      continue;
    }
    if (!targetIdByKey.has(targetKey) && !plan.targets.some(target => target.key === targetKey && target.id === null)) {
      report.errors.push({ path: 'configuration.checks', message: `Target not found for check ${value.name}: ${value.target.name} (${value.target.environment})` });
      continue;
    }
    const key = identityKey(value.target.name, value.target.environment, value.name);
    if (checkSeen.has(key)) { report.conflicts.push({ path: 'configuration.checks', message: `Duplicate check identity: ${value.target.name} / ${value.name}` }); continue; }
    checkSeen.add(key);
    const targetId = targetIdByKey.get(targetKey);
    const matches = targetId === undefined ? [] : (checkExisting.get(key) ?? []).filter(check => check.target_id === targetId);
    if (matches.length > 1) report.conflicts.push({ path: 'configuration.checks', message: `Check identity is ambiguous: ${value.target.name} / ${value.name}` });
    else {
      const id = matches[0]?.id ?? null;
      const publicHeaderNames = new Set(Object.keys(value.options.http?.headers ?? {}).map(name => name.toLowerCase()));
      const overlappingSecretHeader = matches[0]?.secret_header_names.find(name => publicHeaderNames.has(name.toLowerCase()));
      if (overlappingSecretHeader) {
        report.conflicts.push({ path: 'configuration.checks', message: `Header ${overlappingSecretHeader} is already stored as a credential header for check ${value.name}; remove or rename one of the headers in Monitoring first` });
        continue;
      }
      if (matches[0]?.secret_header_names.length && (value.checkType !== 'http' || new URL(value.endpoint).protocol !== 'https:')) {
        report.conflicts.push({ path: 'configuration.checks', message: `Existing secret headers prevent this incompatible update to check ${value.name}; remove them in Monitoring first` });
        continue;
      }
      plan.checks.push({ value, key, targetKey, id, path: 'configuration.checks' });
      report.changes.push({ resource: 'check', action: id === null ? 'create' : 'update', identity: `${value.target.name} / ${value.name}` });
    }
  }
  const sectionExisting = new Map<string, ExistingSection[]>();
  for (const section of existing.sections) sectionExisting.set(section.name, [...(sectionExisting.get(section.name) ?? []), section]);
  const sectionSeen = new Set<string>();
  for (const value of configuration.sections) {
    if (sectionSeen.has(value.name)) { report.conflicts.push({ path: 'configuration.sections', message: `Duplicate section name: ${value.name}` }); continue; }
    sectionSeen.add(value.name);
    const matches = sectionExisting.get(value.name) ?? [];
    const id = matches[0]?.id ?? null;
    plan.sections.push({ value, key: value.name, id, path: 'configuration.sections' });
    report.changes.push({ resource: 'section', action: id === null ? 'create' : 'update', identity: value.name });
  }
  const sectionsByName = new Map(existing.sections.map(section => [section.name, section.id]));
  for (const section of plan.sections) if (section.id !== null) sectionsByName.set(section.key, section.id);
  const existingComponentsByName = new Map<string, ExistingComponent[]>();
  for (const component of existing.components) existingComponentsByName.set(component.public_name, [...(existingComponentsByName.get(component.public_name) ?? []), component]);
  const componentSeen = new Set<string>();
  const componentNamesSeen = new Set<string>();
  for (const value of configuration.components) {
    const sectionKey = value.section;
    if (!sectionsByName.has(sectionKey) && !plan.sections.some(section => section.key === sectionKey && section.id === null)) {
      report.errors.push({ path: 'configuration.components', message: `Section not found for component ${value.publicName}: ${sectionKey}` });
      continue;
    }
    const key = identityKey(sectionKey, value.publicName);
    if (componentSeen.has(key) || componentNamesSeen.has(value.publicName)) {
      report.conflicts.push({ path: 'configuration.components', message: `Duplicate component name: ${value.publicName}` }); continue;
    }
    componentSeen.add(key);
    componentNamesSeen.add(value.publicName);
    const matches = existingComponentsByName.get(value.publicName) ?? [];
    if (matches.length > 1 || (matches.length === 1 && matches[0]!.section_name !== sectionKey)) {
      report.conflicts.push({ path: 'configuration.components', message: `Component name conflicts with an existing component in another section: ${value.publicName}` }); continue;
    }
    const checkKeys: string[] = [];
    let missingCheck = false;
    for (const ref of value.checks) {
      const checkKey = identityKey(ref.target.name, ref.target.environment, ref.name);
      const plannedCheck = plan.checks.some(check => check.key === checkKey);
      const existingMatches = checkExisting.get(checkKey) ?? [];
      if (!plannedCheck && existingMatches.length > 1) {
        report.conflicts.push({ path: 'configuration.components', message: `Check identity is ambiguous for component ${value.publicName}: ${ref.target.name} / ${ref.name}` });
        missingCheck = true;
      } else if (!plannedCheck && existingMatches.length === 0) {
        report.errors.push({ path: 'configuration.components', message: `Check not found for component ${value.publicName}: ${ref.target.name} / ${ref.name}` });
        missingCheck = true;
      } else checkKeys.push(checkKey);
    }
    if (missingCheck) continue;
    const id = matches[0]?.id ?? null;
    plan.components.push({ value, key, id, path: 'configuration.components', checkKeys });
    report.changes.push({ resource: 'component', action: id === null ? 'create' : 'update', identity: `${sectionKey} / ${value.publicName}` });
  }
  return plan;
}

async function loadExisting(client: PoolClient) {
  const [targets, checks, sections, components] = await Promise.all([
    client.query<ExistingTarget>('SELECT id, name, environment FROM monitoring_targets ORDER BY id'),
    client.query<ExistingCheck>('SELECT id, target_id, name, secret_header_names FROM monitoring_checks ORDER BY id'),
    client.query<ExistingSection>('SELECT id, name FROM status_page_sections ORDER BY id'),
    client.query<ExistingComponent>('SELECT c.id, c.section_id, s.name AS section_name, c.public_name FROM status_page_components c JOIN status_page_sections s ON s.id = c.section_id ORDER BY c.id'),
  ]);
  return { targets: targets.rows, checks: checks.rows, sections: sections.rows, components: components.rows };
}

export async function exportMonitoringConfiguration(): Promise<MonitoringConfiguration> {
  const client = await getClient();
  try {
    const [targetsResult, checksResult, sectionsResult, componentsResult, linksResult] = await Promise.all([
      client.query<TargetConfig>('SELECT name, target_type AS "targetType", environment, description, enabled FROM monitoring_targets ORDER BY name, environment, id LIMIT 501'),
      client.query<{ name: string; target_name: string; target_environment: string; check_type: MonitoringCheckType; endpoint: string; port: number | null; interval_seconds: number; timeout_seconds: number; confirmation_seconds: number; recovery_seconds: number; cert_expiry_days: number | null; tls_mode: CheckConfig['tlsMode']; certificate_error_mode: CheckConfig['certificateErrorMode']; allow_private: boolean; options_json: MonitoringCheckOptions; enabled: boolean }>(
        `SELECT c.name, t.name AS target_name, t.environment AS target_environment, c.check_type, c.endpoint, c.port,
                c.interval_seconds, c.timeout_seconds, c.confirmation_seconds, c.recovery_seconds, c.cert_expiry_days,
                c.tls_mode, c.certificate_error_mode, c.allow_private, c.options_json, c.enabled
         FROM monitoring_checks c JOIN monitoring_targets t ON t.id = c.target_id
         -- Push checks are tied to their secret ping URL, so they are not exported.
         WHERE c.check_type <> 'push'
         ORDER BY t.name, t.environment, c.name, c.id LIMIT 501`),
      client.query<SectionConfig>('SELECT name, position, enabled FROM status_page_sections ORDER BY position, id LIMIT 501'),
      client.query<{ section_name: string; public_name: string; description: string | null; position: number; enabled: boolean; show_history: boolean; id: number }>(
        `SELECT s.name AS section_name, c.public_name, c.description, c.position, c.enabled, c.show_history, c.id
         FROM status_page_components c JOIN status_page_sections s ON s.id = c.section_id ORDER BY s.position, c.position, c.id LIMIT 501`),
      client.query<{ component_id: number; check_name: string; target_name: string; target_environment: string }>(
        `SELECT scc.component_id, c.name AS check_name, t.name AS target_name, t.environment AS target_environment
         FROM status_page_component_checks scc JOIN monitoring_checks c ON c.id = scc.check_id
         JOIN monitoring_targets t ON t.id = c.target_id ORDER BY scc.component_id, t.name, t.environment, c.name LIMIT 250001`),
    ]);
    const rowCounts = {
      targets: targetsResult.rows.length,
      checks: checksResult.rows.length,
      sections: sectionsResult.rows.length,
      components: componentsResult.rows.length,
    };
    const oversized = Object.entries(rowCounts).find(([, count]) => count > MAX_ROWS);
    if (oversized) throw new MonitoringInputError(`Cannot export Monitoring configuration: ${oversized[0]} exceeds the import limit of ${MAX_ROWS} entries`);
    if (linksResult.rows.length > MAX_ROWS * MAX_ROWS) {
      throw new MonitoringInputError(`Cannot export Monitoring configuration: component check links exceed the maximum supported by ${MAX_ROWS} components with ${MAX_ROWS} checks each`);
    }
    const linkCounts = new Map<number, number>();
    for (const link of linksResult.rows) linkCounts.set(link.component_id, (linkCounts.get(link.component_id) ?? 0) + 1);
    if (Array.from(linkCounts.values()).some(count => count > MAX_ROWS)) {
      throw new MonitoringInputError(`Cannot export Monitoring configuration: a component links more than ${MAX_ROWS} checks`);
    }
    const checks = checksResult.rows.map(row => ({
      target: { name: row.target_name, environment: row.target_environment },
      name: row.name,
      checkType: row.check_type,
      endpoint: row.endpoint,
      port: row.port,
      intervalSeconds: row.interval_seconds,
      timeoutSeconds: row.timeout_seconds,
      confirmationSeconds: row.confirmation_seconds,
      recoverySeconds: row.recovery_seconds,
      certExpiryDays: row.cert_expiry_days,
      tlsMode: row.tls_mode,
      certificateErrorMode: row.certificate_error_mode,
      allowPrivate: row.allow_private,
      options: parseMonitoringOptions(row.check_type, row.options_json, row.port),
      enabled: row.enabled,
    }));
    const linkedChecks = new Map<number, ComponentCheckConfig[]>();
    for (const link of linksResult.rows) linkedChecks.set(link.component_id, [...(linkedChecks.get(link.component_id) ?? []), { target: { name: link.target_name, environment: link.target_environment }, name: link.check_name }]);
    const configuration: MonitoringConfiguration = {
      format: FORMAT,
      version: 1,
      targets: targetsResult.rows,
      checks,
      sections: sectionsResult.rows,
      components: componentsResult.rows.map(({ section_name, public_name, description, position, enabled, show_history, id }) => ({
        section: section_name,
        publicName: public_name,
        description,
        position,
        enabled,
        showHistory: show_history,
        checks: linkedChecks.get(id) ?? [],
      })),
    };
    const checkIdentities = new Set<string>();
    for (const check of configuration.checks) {
      const identity = identityKey(check.target.name, check.target.environment, check.name);
      if (checkIdentities.has(identity)) {
        throw new MonitoringInputError(`Cannot export Monitoring configuration: duplicate check identity ${check.target.name} / ${check.name} makes component links ambiguous`);
      }
      checkIdentities.add(identity);
    }
    const byteLength = Buffer.byteLength(JSON.stringify(configuration));
    if (byteLength > MAX_CONFIGURATION_BYTES) {
      throw new MonitoringInputError(`Cannot export Monitoring configuration: serialized configuration is ${byteLength.toLocaleString()} bytes; the import limit is ${MAX_CONFIGURATION_BYTES.toLocaleString()} bytes`);
    }
    return configuration;
  } finally { client.release(); }
}

export async function importMonitoringConfiguration(raw: unknown, dryRun: boolean): Promise<MonitoringImportReport> {
  const client = await getClient();
  let transaction = false;
  try {
    await client.query('BEGIN');
    transaction = true;
    await client.query('SELECT pg_advisory_xact_lock(824214, 1)');
    const report: MonitoringImportReport = { changes: [], conflicts: [], errors: [] };
    const configuration = parseConfiguration(raw, report);
    const existing = await loadExisting(client);
    const plan = buildPlan(configuration, report, existing);
    if (dryRun || report.errors.length || report.conflicts.length) {
      await client.query('ROLLBACK');
      transaction = false;
      return report;
    }

    const targetIds = new Map<string, number>();
    for (const target of plan.targets) {
      const result = target.id === null
        ? await client.query<{ id: number }>(
          `INSERT INTO monitoring_targets (name, target_type, environment, description, enabled)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [target.value.name, target.value.targetType, target.value.environment, target.value.description, target.value.enabled])
        : await client.query<{ id: number }>(
          `UPDATE monitoring_targets SET name = $1, target_type = $2, environment = $3, description = $4, enabled = $5, updated_at = CURRENT_TIMESTAMP
           WHERE id = $6 RETURNING id`,
          [target.value.name, target.value.targetType, target.value.environment, target.value.description, target.value.enabled, target.id]);
      const id = result.rows[0]?.id;
      if (!id) throw new Error(`Failed to persist target ${target.value.name}`);
      targetIds.set(target.key, id);
    }
    const checkIds = new Map<string, number>();
    for (const check of existing.checks) {
      const target = existing.targets.find(item => item.id === check.target_id);
      if (target) checkIds.set(identityKey(target.name, target.environment, check.name), check.id);
    }
    for (const check of plan.checks) {
      const targetId = targetIds.get(check.targetKey) ?? existing.targets.find(target => identityKey(target.name, target.environment) === check.targetKey)?.id;
      if (!targetId) throw new Error(`Failed to resolve target for check ${check.value.name}`);
      const values = [targetId, check.value.name, check.value.checkType, check.value.endpoint, check.value.port, check.value.intervalSeconds, check.value.timeoutSeconds,
        check.value.confirmationSeconds, check.value.recoverySeconds, check.value.certExpiryDays, check.value.tlsMode, check.value.certificateErrorMode,
        check.value.enabled, check.value.allowPrivate, JSON.stringify(check.value.options)];
      const result = check.id === null
        ? await client.query<{ id: number }>(
          `INSERT INTO monitoring_checks (target_id, name, check_type, endpoint, port, interval_seconds, timeout_seconds, confirmation_seconds,
             recovery_seconds, cert_expiry_days, tls_mode, certificate_error_mode, enabled, allow_private, options_json, next_run_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, CURRENT_TIMESTAMP) RETURNING id`, values)
        : await client.query<{ id: number }>(
          `UPDATE monitoring_checks SET target_id = $1, name = $2, check_type = $3, endpoint = $4, port = $5, interval_seconds = $6,
             timeout_seconds = $7, confirmation_seconds = $8, recovery_seconds = $9, cert_expiry_days = $10, tls_mode = $11,
             certificate_error_mode = $12, enabled = $13, allow_private = $14, options_json = $15::jsonb, next_run_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP WHERE id = $16 RETURNING id`, [...values, check.id]);
      const id = result.rows[0]?.id;
      if (!id) throw new Error(`Failed to persist check ${check.value.name}`);
      checkIds.set(check.key, id);
    }
    const sectionIds = new Map<string, number>();
    for (const section of existing.sections) sectionIds.set(section.name, section.id);
    for (const section of plan.sections) {
      const result = await client.query<{ id: number }>(
        `INSERT INTO status_page_sections (name, position, enabled) VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET position = EXCLUDED.position, enabled = EXCLUDED.enabled, updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [section.value.name, section.value.position, section.value.enabled]);
      const id = result.rows[0]?.id;
      if (!id) throw new Error(`Failed to persist section ${section.value.name}`);
      sectionIds.set(section.key, id);
    }
    for (const component of plan.components) {
      const sectionId = sectionIds.get(component.value.section);
      if (!sectionId) throw new Error(`Failed to resolve section for component ${component.value.publicName}`);
      const result = await client.query<{ id: number }>(
        `INSERT INTO status_page_components (section_id, public_name, description, position, enabled, show_history)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (public_name) DO UPDATE SET section_id = EXCLUDED.section_id, description = EXCLUDED.description,
           position = EXCLUDED.position, enabled = EXCLUDED.enabled, show_history = EXCLUDED.show_history, updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [sectionId, component.value.publicName, component.value.description, component.value.position, component.value.enabled, component.value.showHistory]);
      const id = result.rows[0]?.id;
      if (!id) throw new Error(`Failed to persist component ${component.value.publicName}`);
      await client.query('DELETE FROM status_page_component_checks WHERE component_id = $1', [id]);
      for (const checkKey of component.checkKeys) {
        const checkId = checkIds.get(checkKey);
        if (!checkId) throw new Error(`Failed to resolve linked check for component ${component.value.publicName}`);
        await client.query('INSERT INTO status_page_component_checks (component_id, check_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, checkId]);
      }
    }
    await client.query('COMMIT');
    transaction = false;
    return report;
  } catch (error) {
    if (transaction) await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
