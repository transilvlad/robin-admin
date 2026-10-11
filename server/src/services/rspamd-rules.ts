import {
  deleteConfigStoreEntry,
  getConfigStorePayload,
  listConfigStoreFileNames,
  RSPAMD_CONFIG_STORE_TABLE,
  upsertConfigStorePayload,
} from '../db/queries/config-store.js';
import {
  getRspamdFileManagement,
  getRspamdRulesDocument,
  type RspamdFileManagement,
  type RspamdRulesStoreDocument,
  getRspamdSettings,
  toPublicRspamdSettings,
  type PublicRspamdSettings,
  updateRspamdFileManagement,
  updateRspamdRulesDocument,
} from '../db/queries/rspamd.js';
import { getRspamdStatus, type ManagedFileState, type RspamdStatus } from './rspamd.js';

const MANAGED_MARKER = '# Managed by Robin Admin';
const MANAGED_ACTIONS_FILE = 'actions.conf';
const MANAGED_GROUPS_FILE = 'groups.conf';
const MANAGED_SETTINGS_FILE = 'settings.conf';
const MANAGED_COMPOSITES_FILE = 'composites.conf';
const MANAGED_MULTIMAP_FILE = 'multimap.conf';
const LOCAL_MAP_PREFIX = 'maps/';
// The agent writes managed files under local.d, keeping the maps/ subfolder;
// rspamd resolves a relative map path against its working directory, not
// local.d, so the multimap names the file absolutely.
const LOCAL_MAP_CONFIG_PATH = '$LOCAL_CONFDIR/local.d/maps/';
const MANAGED_STORE_PREFIX = 'db://rspamd_config_store';

type AdvancedValueType = 'string' | 'number' | 'boolean' | 'stringList';
type MultimapSourceType = 'local' | 'http' | 'https' | 'redis' | 'selector' | 'external';

export interface RspamdRulesAdvancedOption {
  id: string;
  key: string;
  valueType: AdvancedValueType;
  stringValue: string;
  numberValue: number | null;
  booleanValue: boolean;
  listValue: string[];
}

export interface RspamdActionThreshold {
  id: string;
  name: string;
  threshold: number;
  enabled: boolean;
  flags: string[];
  subject: string;
  growFactor: number | null;
  unknownWeight: number | null;
  options: RspamdRulesAdvancedOption[];
}

export interface RspamdSymbolRule {
  id: string;
  name: string;
  weight: number;
  description: string;
  oneShot: boolean;
  enabled: boolean;
  options: RspamdRulesAdvancedOption[];
}

export interface RspamdGroupRule {
  id: string;
  name: string;
  description: string;
  maxScore: number | null;
  minScore: number | null;
  enabled: boolean;
  options: RspamdRulesAdvancedOption[];
  symbols: RspamdSymbolRule[];
}

export interface RspamdSettingsCondition {
  authenticated: boolean | null;
  local: boolean | null;
  ips: string[];
  from: string[];
  rcpt: string[];
  domains: string[];
  headers: string[];
  selector: string;
  options: RspamdRulesAdvancedOption[];
}

export interface RspamdActionOverride {
  id: string;
  action: string;
  threshold: number;
}

export interface RspamdScoreOverride {
  id: string;
  name: string;
  score: number;
}

export interface RspamdSettingsApply {
  actionOverrides: RspamdActionOverride[];
  enableSymbols: string[];
  disableSymbols: string[];
  enableGroups: string[];
  disableGroups: string[];
  symbolScores: RspamdScoreOverride[];
  groupScores: RspamdScoreOverride[];
  options: RspamdRulesAdvancedOption[];
}

export interface RspamdSettingsProfile {
  id: string;
  name: string;
  profileId: string;
  priority: number;
  enabled: boolean;
  description: string;
  conditions: RspamdSettingsCondition;
  apply: RspamdSettingsApply;
  options: RspamdRulesAdvancedOption[];
}

export interface RspamdCompositeRule {
  id: string;
  name: string;
  expression: string;
  description: string;
  score: number | null;
  policy: string;
  group: string;
  enabled: boolean;
  options: RspamdRulesAdvancedOption[];
}

export interface RspamdLocalMap {
  id: string;
  slug: string;
  name: string;
  description: string;
  content: string;
}

export interface RspamdMultimapSource {
  type: MultimapSourceType;
  localMapSlug: string;
  url: string;
  redisKey: string;
  selector: string;
  externalDefinition: string;
  backend: string;
  options: RspamdRulesAdvancedOption[];
}

export interface RspamdMultimapRule {
  id: string;
  name: string;
  ruleType: string;
  selector: string;
  description: string;
  score: number | null;
  oneShot: boolean;
  regexp: boolean;
  enabled: boolean;
  filter: string;
  source: RspamdMultimapSource;
  options: RspamdRulesAdvancedOption[];
}

export interface RspamdRulesDocument {
  actions: RspamdActionThreshold[];
  groups: RspamdGroupRule[];
  settingsProfiles: RspamdSettingsProfile[];
  composites: RspamdCompositeRule[];
  multimaps: RspamdMultimapRule[];
  localMaps: RspamdLocalMap[];
}

export interface RspamdRulesFileManagement {
  actions: boolean | null;
  groups: boolean | null;
  settings: boolean | null;
  composites: boolean | null;
  multimap: boolean | null;
}

export interface RspamdRulesValidationState {
  errors: string[];
  warnings: string[];
}

export interface RspamdRulesState {
  settings: PublicRspamdSettings;
  status: RspamdStatus;
  fileManagement: RspamdRulesFileManagement;
  document: RspamdRulesDocument;
  files: {
    actions: ManagedFileState;
    groups: ManagedFileState;
    settings: ManagedFileState;
    composites: ManagedFileState;
    multimap: ManagedFileState;
    localMaps: ManagedFileState[];
  };
  validation: RspamdRulesValidationState;
}

const DEFAULT_ACTIONS: RspamdActionThreshold[] = [
  { id: 'action-reject', name: 'reject', threshold: 15, enabled: true, flags: [], subject: '', growFactor: null, unknownWeight: null, options: [] },
  { id: 'action-add-header', name: 'add_header', threshold: 6, enabled: true, flags: [], subject: '', growFactor: null, unknownWeight: null, options: [] },
  { id: 'action-greylist', name: 'greylist', threshold: 4, enabled: true, flags: [], subject: '', growFactor: null, unknownWeight: null, options: [] },
];

const DEFAULT_DOCUMENT: RspamdRulesDocument = {
  actions: DEFAULT_ACTIONS,
  groups: [],
  settingsProfiles: [],
  composites: [],
  multimaps: [],
  localMaps: [],
};

const DEFAULT_FILE_MANAGEMENT: RspamdRulesFileManagement = {
  actions: true,
  groups: true,
  settings: true,
  composites: true,
  multimap: true,
};

function emptyOption(id = ''): RspamdRulesAdvancedOption {
  return {
    id,
    key: '',
    valueType: 'string',
    stringValue: '',
    numberValue: null,
    booleanValue: false,
    listValue: [],
  };
}

function emptyConditions(): RspamdSettingsCondition {
  return {
    authenticated: null,
    local: null,
    ips: [],
    from: [],
    rcpt: [],
    domains: [],
    headers: [],
    selector: '',
    options: [],
  };
}

function emptyApply(): RspamdSettingsApply {
  return {
    actionOverrides: [],
    enableSymbols: [],
    disableSymbols: [],
    enableGroups: [],
    disableGroups: [],
    symbolScores: [],
    groupScores: [],
    options: [],
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return fallback;
}

function nullableBooleanValue(value: unknown): boolean | null {
  if (value === null || value === undefined || value === '') return null;
  return booleanValue(value, false);
}

function numberValue(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function nullableNumberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function stringListValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
}

function normalizeId(prefix: string, value: unknown, index: number): string {
  const candidate = stringValue(value).trim();
  return candidate || `${prefix}-${index + 1}`;
}

function escapeUcl(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function storeRef(serviceId: string | null | undefined, name: string): string {
  if (!serviceId) return `${MANAGED_STORE_PREFIX}/unbound/${name}`;
  return `${MANAGED_STORE_PREFIX}/${serviceId}/${name}`;
}

function normalizeAdvancedOption(option: unknown, index: number): RspamdRulesAdvancedOption {
  const record = toRecord(option);
  const rawType = stringValue(record.valueType, 'string');
  const valueType: AdvancedValueType = rawType === 'number' || rawType === 'boolean' || rawType === 'stringList'
    ? rawType
    : 'string';
  return {
    id: normalizeId('option', record.id, index),
    key: stringValue(record.key).trim(),
    valueType,
    stringValue: stringValue(record.stringValue),
    numberValue: nullableNumberValue(record.numberValue),
    booleanValue: booleanValue(record.booleanValue, false),
    listValue: stringListValue(record.listValue),
  };
}

function normalizeAction(action: unknown, index: number): RspamdActionThreshold {
  const record = toRecord(action);
  return {
    id: normalizeId('action', record.id, index),
    name: stringValue(record.name, `action-${index + 1}`).trim(),
    threshold: numberValue(record.threshold, 0),
    enabled: booleanValue(record.enabled, true),
    flags: stringListValue(record.flags),
    subject: stringValue(record.subject),
    growFactor: nullableNumberValue(record.growFactor),
    unknownWeight: nullableNumberValue(record.unknownWeight),
    options: toArray(record.options).map(normalizeAdvancedOption),
  };
}

function normalizeSymbol(symbol: unknown, index: number): RspamdSymbolRule {
  const record = toRecord(symbol);
  return {
    id: normalizeId('symbol', record.id, index),
    name: stringValue(record.name, `SYMBOL_${index + 1}`).trim(),
    weight: numberValue(record.weight, 0),
    description: stringValue(record.description),
    oneShot: booleanValue(record.oneShot, false),
    enabled: booleanValue(record.enabled, true),
    options: toArray(record.options).map(normalizeAdvancedOption),
  };
}

function normalizeGroup(group: unknown, index: number): RspamdGroupRule {
  const record = toRecord(group);
  return {
    id: normalizeId('group', record.id, index),
    name: stringValue(record.name, `group-${index + 1}`).trim(),
    description: stringValue(record.description),
    maxScore: nullableNumberValue(record.maxScore),
    minScore: nullableNumberValue(record.minScore),
    enabled: booleanValue(record.enabled, true),
    options: toArray(record.options).map(normalizeAdvancedOption),
    symbols: toArray(record.symbols).map(normalizeSymbol),
  };
}

function normalizeConditions(conditions: unknown): RspamdSettingsCondition {
  const record = toRecord(conditions);
  return {
    authenticated: nullableBooleanValue(record.authenticated),
    local: nullableBooleanValue(record.local),
    ips: stringListValue(record.ips),
    from: stringListValue(record.from),
    rcpt: stringListValue(record.rcpt),
    domains: stringListValue(record.domains),
    headers: stringListValue(record.headers),
    selector: stringValue(record.selector).trim(),
    options: toArray(record.options).map(normalizeAdvancedOption),
  };
}

function normalizeActionOverride(item: unknown, index: number): RspamdActionOverride {
  const record = toRecord(item);
  return {
    id: normalizeId('action-override', record.id, index),
    action: stringValue(record.action).trim(),
    threshold: numberValue(record.threshold, 0),
  };
}

function normalizeScoreOverride(item: unknown, index: number): RspamdScoreOverride {
  const record = toRecord(item);
  return {
    id: normalizeId('score-override', record.id, index),
    name: stringValue(record.name).trim(),
    score: numberValue(record.score, 0),
  };
}

function normalizeApply(apply: unknown): RspamdSettingsApply {
  const record = toRecord(apply);
  return {
    actionOverrides: toArray(record.actionOverrides).map(normalizeActionOverride),
    enableSymbols: stringListValue(record.enableSymbols),
    disableSymbols: stringListValue(record.disableSymbols),
    enableGroups: stringListValue(record.enableGroups),
    disableGroups: stringListValue(record.disableGroups),
    symbolScores: toArray(record.symbolScores).map(normalizeScoreOverride),
    groupScores: toArray(record.groupScores).map(normalizeScoreOverride),
    options: toArray(record.options).map(normalizeAdvancedOption),
  };
}

function normalizeProfile(profile: unknown, index: number): RspamdSettingsProfile {
  const record = toRecord(profile);
  return {
    id: normalizeId('profile', record.id, index),
    name: stringValue(record.name, `profile-${index + 1}`).trim(),
    profileId: stringValue(record.profileId).trim(),
    priority: numberValue(record.priority, 0),
    enabled: booleanValue(record.enabled, true),
    description: stringValue(record.description),
    conditions: normalizeConditions(record.conditions),
    apply: normalizeApply(record.apply),
    options: toArray(record.options).map(normalizeAdvancedOption),
  };
}

function normalizeComposite(composite: unknown, index: number): RspamdCompositeRule {
  const record = toRecord(composite);
  return {
    id: normalizeId('composite', record.id, index),
    name: stringValue(record.name, `COMPOSITE_${index + 1}`).trim(),
    expression: stringValue(record.expression).trim(),
    description: stringValue(record.description),
    score: nullableNumberValue(record.score),
    policy: stringValue(record.policy).trim(),
    group: stringValue(record.group).trim(),
    enabled: booleanValue(record.enabled, true),
    options: toArray(record.options).map(normalizeAdvancedOption),
  };
}

function normalizeLocalMap(map: unknown, index: number): RspamdLocalMap {
  const record = toRecord(map);
  return {
    id: normalizeId('local-map', record.id, index),
    slug: stringValue(record.slug, `map-${index + 1}`).trim(),
    name: stringValue(record.name),
    description: stringValue(record.description),
    content: stringValue(record.content),
  };
}

function normalizeSource(source: unknown): RspamdMultimapSource {
  const record = toRecord(source);
  const rawType = stringValue(record.type, 'local');
  const type: MultimapSourceType = rawType === 'http' || rawType === 'https' || rawType === 'redis' || rawType === 'selector' || rawType === 'external'
    ? rawType
    : 'local';
  return {
    type,
    localMapSlug: stringValue(record.localMapSlug).trim(),
    url: stringValue(record.url).trim(),
    redisKey: stringValue(record.redisKey).trim(),
    selector: stringValue(record.selector).trim(),
    externalDefinition: stringValue(record.externalDefinition),
    backend: stringValue(record.backend).trim(),
    options: toArray(record.options).map(normalizeAdvancedOption),
  };
}

function normalizeMultimap(multimap: unknown, index: number): RspamdMultimapRule {
  const record = toRecord(multimap);
  return {
    id: normalizeId('multimap', record.id, index),
    name: stringValue(record.name, `MULTIMAP_${index + 1}`).trim(),
    ruleType: stringValue(record.ruleType, 'from').trim(),
    selector: stringValue(record.selector).trim(),
    description: stringValue(record.description),
    score: nullableNumberValue(record.score),
    oneShot: booleanValue(record.oneShot, false),
    regexp: booleanValue(record.regexp, false),
    enabled: booleanValue(record.enabled, true),
    filter: stringValue(record.filter).trim(),
    source: normalizeSource(record.source),
    options: toArray(record.options).map(normalizeAdvancedOption),
  };
}

export function normalizeRspamdRulesDocument(document: unknown): RspamdRulesDocument {
  const record = toRecord(document);
  return {
    actions: toArray(record.actions).map(normalizeAction),
    groups: toArray(record.groups).map(normalizeGroup),
    settingsProfiles: toArray(record.settingsProfiles).map(normalizeProfile),
    composites: toArray(record.composites).map(normalizeComposite),
    multimaps: toArray(record.multimaps).map(normalizeMultimap),
    localMaps: toArray(record.localMaps).map(normalizeLocalMap),
  };
}

function normalizeRulesFileManagement(fileManagement: RspamdFileManagement): RspamdRulesFileManagement {
  return {
    actions: fileManagement.actions ?? DEFAULT_FILE_MANAGEMENT.actions,
    groups: fileManagement.groups ?? DEFAULT_FILE_MANAGEMENT.groups,
    settings: fileManagement.settings ?? DEFAULT_FILE_MANAGEMENT.settings,
    composites: fileManagement.composites ?? DEFAULT_FILE_MANAGEMENT.composites,
    multimap: fileManagement.multimap ?? DEFAULT_FILE_MANAGEMENT.multimap,
  };
}

function renderOptionValue(option: RspamdRulesAdvancedOption): string {
  switch (option.valueType) {
    case 'number':
      return option.numberValue === null ? '0' : `${option.numberValue}`;
    case 'boolean':
      return option.booleanValue ? 'true' : 'false';
    case 'stringList':
      return `[${option.listValue.map((entry) => `"${escapeUcl(entry)}"`).join(', ')}]`;
    case 'string':
    default:
      return `"${escapeUcl(option.stringValue)}"`;
  }
}

function renderAdvancedOptions(options: RspamdRulesAdvancedOption[], indent = '  '): string[] {
  return options
    .filter((option) => option.key.trim())
    .map((option) => `${indent}${option.key} = ${renderOptionValue(option)};`);
}

// rspamd includes local.d/actions.conf inside its own `actions { }` block, so
// the file holds the thresholds alone.
export function renderActionsFile(actions: RspamdActionThreshold[]): string {
  const lines = [MANAGED_MARKER];
  for (const action of actions.filter((item) => item.name)) {
    if (!action.enabled) continue;
    const hasExtendedFields = action.flags.length > 0
      || action.subject.trim()
      || action.growFactor !== null
      || action.unknownWeight !== null
      || action.options.some((option) => option.key.trim());
    if (!hasExtendedFields) {
      lines.push(`${action.name} = ${action.threshold};`);
      continue;
    }
    lines.push(`${action.name} {`);
    lines.push(`  threshold = ${action.threshold};`);
    if (action.flags.length > 0) {
      lines.push(`  flags = [${action.flags.map((flag) => `"${escapeUcl(flag)}"`).join(', ')}];`);
    }
    if (action.subject.trim()) lines.push(`  subject = "${escapeUcl(action.subject)}";`);
    if (action.growFactor !== null) lines.push(`  grow_factor = ${action.growFactor};`);
    if (action.unknownWeight !== null) lines.push(`  unknown_weight = ${action.unknownWeight};`);
    lines.push(...renderAdvancedOptions(action.options, '  '));
    lines.push('}');
  }
  lines.push('');
  return lines.join('\n');
}

function renderGroupsFile(groups: RspamdGroupRule[]): string {
  const lines = [MANAGED_MARKER];
  for (const group of groups.filter((item) => item.name)) {
    lines.push(`group "${escapeUcl(group.name)}" {`);
    if (group.description.trim()) lines.push(`  description = "${escapeUcl(group.description)}";`);
    if (group.maxScore !== null) lines.push(`  max_score = ${group.maxScore};`);
    if (group.minScore !== null) lines.push(`  min_score = ${group.minScore};`);
    if (!group.enabled) lines.push('  disabled = true;');
    lines.push(...renderAdvancedOptions(group.options, '  '));
    for (const symbol of group.symbols.filter((item) => item.name)) {
      lines.push(`  symbol "${escapeUcl(symbol.name)}" {`);
      lines.push(`    weight = ${symbol.weight};`);
      if (symbol.description.trim()) lines.push(`    description = "${escapeUcl(symbol.description)}";`);
      if (symbol.oneShot) lines.push('    one_shot = true;');
      if (!symbol.enabled) lines.push('    disabled = true;');
      lines.push(...renderAdvancedOptions(symbol.options, '    '));
      lines.push('  }');
    }
    lines.push('}', '');
  }
  return lines.join('\n');
}

function renderSettingsConditions(conditions: RspamdSettingsCondition): string[] {
  const lines: string[] = [];
  if (conditions.authenticated !== null) lines.push(`  authenticated = ${conditions.authenticated ? 'true' : 'false'};`);
  if (conditions.local !== null) lines.push(`  local = ${conditions.local ? 'true' : 'false'};`);
  if (conditions.ips.length > 0) lines.push(`  ip = [${conditions.ips.map((item) => `"${escapeUcl(item)}"`).join(', ')}];`);
  if (conditions.from.length > 0) lines.push(`  from = [${conditions.from.map((item) => `"${escapeUcl(item)}"`).join(', ')}];`);
  if (conditions.rcpt.length > 0) lines.push(`  rcpt = [${conditions.rcpt.map((item) => `"${escapeUcl(item)}"`).join(', ')}];`);
  if (conditions.domains.length > 0) lines.push(`  domain = [${conditions.domains.map((item) => `"${escapeUcl(item)}"`).join(', ')}];`);
  if (conditions.headers.length > 0) lines.push(`  request_header = [${conditions.headers.map((item) => `"${escapeUcl(item)}"`).join(', ')}];`);
  if (conditions.selector) lines.push(`  selector = "${escapeUcl(conditions.selector)}";`);
  lines.push(...renderAdvancedOptions(conditions.options, '  '));
  return lines;
}

function renderSettingsApply(apply: RspamdSettingsApply): string[] {
  const lines = ['  apply {'];
  for (const action of apply.actionOverrides.filter((item) => item.action)) {
    lines.push(`    ${action.action} = ${action.threshold};`);
  }
  if (apply.enableSymbols.length > 0) lines.push(`    symbols_enabled = [${apply.enableSymbols.map((item) => `"${escapeUcl(item)}"`).join(', ')}];`);
  if (apply.disableSymbols.length > 0) lines.push(`    symbols_disabled = [${apply.disableSymbols.map((item) => `"${escapeUcl(item)}"`).join(', ')}];`);
  if (apply.enableGroups.length > 0) lines.push(`    groups_enabled = [${apply.enableGroups.map((item) => `"${escapeUcl(item)}"`).join(', ')}];`);
  if (apply.disableGroups.length > 0) lines.push(`    groups_disabled = [${apply.disableGroups.map((item) => `"${escapeUcl(item)}"`).join(', ')}];`);
  for (const symbol of apply.symbolScores.filter((item) => item.name)) {
    lines.push(`    symbol_scores["${escapeUcl(symbol.name)}"] = ${symbol.score};`);
  }
  for (const group of apply.groupScores.filter((item) => item.name)) {
    lines.push(`    group_scores["${escapeUcl(group.name)}"] = ${group.score};`);
  }
  lines.push(...renderAdvancedOptions(apply.options, '    '));
  lines.push('  }');
  return lines;
}

function renderSettingsFile(profiles: RspamdSettingsProfile[]): string {
  const lines = [MANAGED_MARKER];
  for (const profile of profiles.filter((item) => item.name)) {
    lines.push(`${escapeUcl(profile.name)} {`);
    if (profile.profileId) lines.push(`  id = "${escapeUcl(profile.profileId)}";`);
    lines.push(`  priority = ${profile.priority};`);
    if (profile.description.trim()) lines.push(`  description = "${escapeUcl(profile.description)}";`);
    if (!profile.enabled) lines.push('  disabled = true;');
    lines.push(...renderSettingsConditions(profile.conditions));
    lines.push(...renderSettingsApply(profile.apply));
    lines.push(...renderAdvancedOptions(profile.options, '  '));
    lines.push('}', '');
  }
  return lines.join('\n');
}

function renderCompositesFile(composites: RspamdCompositeRule[]): string {
  const lines = [MANAGED_MARKER];
  for (const composite of composites.filter((item) => item.name && item.expression)) {
    lines.push(`${composite.name} {`);
    lines.push(`  expression = "${escapeUcl(composite.expression)}";`);
    if (composite.description.trim()) lines.push(`  description = "${escapeUcl(composite.description)}";`);
    if (composite.score !== null) lines.push(`  score = ${composite.score};`);
    if (composite.group) lines.push(`  group = "${escapeUcl(composite.group)}";`);
    if (composite.policy) lines.push(`  policy = "${escapeUcl(composite.policy)}";`);
    if (!composite.enabled) lines.push('  disabled = true;');
    lines.push(...renderAdvancedOptions(composite.options, '  '));
    lines.push('}', '');
  }
  return lines.join('\n');
}

function renderMultimapSource(source: RspamdMultimapSource): string[] {
  const lines: string[] = [];
  if (source.type === 'local' && source.localMapSlug) {
    lines.push(`  map = "${LOCAL_MAP_CONFIG_PATH}${escapeUcl(source.localMapSlug)}.map";`);
  } else if ((source.type === 'http' || source.type === 'https') && source.url) {
    lines.push(`  map = "${escapeUcl(source.url)}";`);
  } else if (source.type === 'redis' && source.redisKey) {
    lines.push(`  map = "redis://${escapeUcl(source.redisKey)}";`);
  } else if (source.type === 'selector' && source.selector) {
    lines.push(`  selector = "${escapeUcl(source.selector)}";`);
  } else if (source.type === 'external' && source.externalDefinition.trim()) {
    lines.push(`  map = ${source.externalDefinition.trim()};`);
  }
  if (source.backend) lines.push(`  backend = "${escapeUcl(source.backend)}";`);
  lines.push(...renderAdvancedOptions(source.options, '  '));
  return lines;
}

export function renderMultimapFile(multimaps: RspamdMultimapRule[]): string {
  const lines = [MANAGED_MARKER];
  for (const rule of multimaps.filter((item) => item.name)) {
    lines.push(`${rule.name} {`);
    lines.push(`  type = "${escapeUcl(rule.ruleType)}";`);
    if (rule.selector) lines.push(`  selector = "${escapeUcl(rule.selector)}";`);
    if (rule.description.trim()) lines.push(`  description = "${escapeUcl(rule.description)}";`);
    if (rule.score !== null) lines.push(`  score = ${rule.score};`);
    if (rule.oneShot) lines.push('  one_shot = true;');
    if (rule.regexp) lines.push('  regexp = true;');
    if (!rule.enabled) lines.push('  disabled = true;');
    if (rule.filter) lines.push(`  filter = "${escapeUcl(rule.filter)}";`);
    lines.push(...renderMultimapSource(rule.source));
    lines.push(...renderAdvancedOptions(rule.options, '  '));
    lines.push('}', '');
  }
  return lines.join('\n');
}

function renderLocalMap(map: RspamdLocalMap): string {
  return [MANAGED_MARKER, map.content.trim(), ''].join('\n');
}

function balancedExpression(expression: string): boolean {
  let depth = 0;
  for (const char of expression) {
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function pushUniqueNameErrors(errors: string[], items: Array<{ name: string }>, label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const normalized = item.name.trim().toLowerCase();
    if (!normalized) continue;
    if (seen.has(normalized)) {
      errors.push(`Duplicate ${label} name: ${item.name}`);
      continue;
    }
    seen.add(normalized);
  }
}

export function validateRspamdRulesDocument(document: RspamdRulesDocument): RspamdRulesValidationState {
  const errors: string[] = [];
  const warnings: string[] = [];

  pushUniqueNameErrors(errors, document.actions, 'action');
  pushUniqueNameErrors(errors, document.groups, 'group');
  pushUniqueNameErrors(errors, document.settingsProfiles, 'settings profile');
  pushUniqueNameErrors(errors, document.composites, 'composite');
  pushUniqueNameErrors(errors, document.multimaps, 'multimap');
  pushUniqueNameErrors(errors, document.localMaps, 'local map');

  const localMapSlugs = new Set(document.localMaps.map((map) => map.slug.trim().toLowerCase()).filter(Boolean));

  for (const action of document.actions) {
    if (!action.name.trim()) errors.push('Every action must have a name');
  }
  for (const group of document.groups) {
    if (!group.name.trim()) errors.push('Every group must have a name');
    pushUniqueNameErrors(errors, group.symbols, `symbol in group ${group.name || group.id}`);
  }
  for (const profile of document.settingsProfiles) {
    if (!profile.name.trim()) errors.push('Every settings profile must have a name');
    if (profile.profileId && /\s/.test(profile.profileId)) {
      errors.push(`Settings profile ${profile.name} has an invalid id`);
    }
  }
  for (const composite of document.composites) {
    if (!composite.name.trim()) errors.push('Every composite must have a name');
    if (!composite.expression.trim()) {
      errors.push(`Composite ${composite.name || composite.id} must have an expression`);
    } else if (!balancedExpression(composite.expression)) {
      errors.push(`Composite ${composite.name} has unbalanced parentheses`);
    }
  }
  for (const multimap of document.multimaps) {
    if (!multimap.name.trim()) errors.push('Every multimap must have a name');
    if (multimap.source.type === 'local' && !multimap.source.localMapSlug) {
      errors.push(`Multimap ${multimap.name || multimap.id} uses a local source but has no map slug`);
    }
    if (multimap.source.type === 'local' && multimap.source.localMapSlug && !localMapSlugs.has(multimap.source.localMapSlug.trim().toLowerCase())) {
      errors.push(`Multimap ${multimap.name} references missing local map ${multimap.source.localMapSlug}`);
    }
    if ((multimap.source.type === 'http' || multimap.source.type === 'https') && !multimap.source.url) {
      errors.push(`Multimap ${multimap.name} needs a remote URL`);
    }
    if (multimap.source.type === 'redis' && !multimap.source.redisKey) {
      errors.push(`Multimap ${multimap.name} needs a Redis key`);
    }
    if (multimap.source.type === 'selector' && !multimap.source.selector && !multimap.selector) {
      errors.push(`Multimap ${multimap.name} needs a selector`);
    }
    if (multimap.source.type === 'external' && !multimap.source.externalDefinition.trim()) {
      errors.push(`Multimap ${multimap.name} needs an external map definition`);
    }
  }
  for (const map of document.localMaps) {
    if (!map.slug.trim()) errors.push('Every local map must have a slug');
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(map.slug.trim())) {
      errors.push(`Local map slug ${map.slug} is invalid`);
    }
    if (!map.content.trim()) {
      warnings.push(`Local map ${map.slug || map.id} is empty`);
    }
  }

  return { errors, warnings };
}

async function readManagedFileState(
  serviceId: string | null | undefined,
  fileName: string,
  renderedContent: string,
  managementEnabled: boolean,
): Promise<ManagedFileState> {
  const payload = await getConfigStorePayload<{ content?: string }>(
    RSPAMD_CONFIG_STORE_TABLE,
    'service_id',
    serviceId ?? '',
    fileName
  );
  const storedContent = typeof payload?.content === 'string' ? payload.content : '';
  const content = storedContent || renderedContent;
  const exists = Boolean(serviceId) && storedContent.length > 0;
  return {
    path: storeRef(serviceId, fileName),
    exists,
    readable: exists,
    writable: Boolean(serviceId),
    managed: storedContent.includes(MANAGED_MARKER),
    managementEnabled,
    content: managementEnabled ? content : storedContent || renderedContent || null,
  };
}

async function writeManagedFile(serviceId: string, fileName: string, content: string): Promise<void> {
  await upsertConfigStorePayload(
    RSPAMD_CONFIG_STORE_TABLE,
    'service_id',
    serviceId,
    fileName,
    {
      content,
      managedBy: 'Robin Admin',
    }
  );
}

async function removeManagedFile(serviceId: string, fileName: string): Promise<void> {
  await deleteConfigStoreEntry(RSPAMD_CONFIG_STORE_TABLE, 'service_id', serviceId, fileName);
}

function toStoreDocument(document: RspamdRulesDocument): RspamdRulesStoreDocument {
  return document as unknown as RspamdRulesStoreDocument;
}

async function renderRulesFileStates(
  serviceId: string | null | undefined,
  document: RspamdRulesDocument,
  fileManagement: RspamdRulesFileManagement,
): Promise<RspamdRulesState['files']> {
  const renderedActions = renderActionsFile(document.actions);
  const renderedGroups = renderGroupsFile(document.groups);
  const renderedSettings = renderSettingsFile(document.settingsProfiles);
  const renderedComposites = renderCompositesFile(document.composites);
  const renderedMultimap = renderMultimapFile(document.multimaps);

  const [actions, groups, settings, composites, multimap, localMaps] = await Promise.all([
    readManagedFileState(serviceId, MANAGED_ACTIONS_FILE, renderedActions, fileManagement.actions ?? true),
    readManagedFileState(serviceId, MANAGED_GROUPS_FILE, renderedGroups, fileManagement.groups ?? true),
    readManagedFileState(serviceId, MANAGED_SETTINGS_FILE, renderedSettings, fileManagement.settings ?? true),
    readManagedFileState(serviceId, MANAGED_COMPOSITES_FILE, renderedComposites, fileManagement.composites ?? true),
    readManagedFileState(serviceId, MANAGED_MULTIMAP_FILE, renderedMultimap, fileManagement.multimap ?? true),
    Promise.all(document.localMaps.map((map) => readManagedFileState(
      serviceId,
      `${LOCAL_MAP_PREFIX}${map.slug}.map`,
      renderLocalMap(map),
      fileManagement.multimap ?? true,
    ))),
  ]);

  return { actions, groups, settings, composites, multimap, localMaps };
}

async function removeStaleLocalMaps(serviceId: string, activeSlugs: Set<string>): Promise<void> {
  const fileNames = await listConfigStoreFileNames(RSPAMD_CONFIG_STORE_TABLE, 'service_id', serviceId);
  const staleMaps = fileNames.filter((name) => name.startsWith(LOCAL_MAP_PREFIX) && !activeSlugs.has(name));
  await Promise.all(staleMaps.map((fileName) => removeManagedFile(serviceId, fileName)));
}

async function writeRulesFiles(serviceId: string, document: RspamdRulesDocument, fileManagement: RspamdRulesFileManagement): Promise<void> {
  const tasks: Promise<void>[] = [];

  if (fileManagement.actions) {
    tasks.push(writeManagedFile(serviceId, MANAGED_ACTIONS_FILE, renderActionsFile(document.actions)));
  } else {
    tasks.push(removeManagedFile(serviceId, MANAGED_ACTIONS_FILE));
  }
  if (fileManagement.groups) {
    tasks.push(writeManagedFile(serviceId, MANAGED_GROUPS_FILE, renderGroupsFile(document.groups)));
  } else {
    tasks.push(removeManagedFile(serviceId, MANAGED_GROUPS_FILE));
  }
  if (fileManagement.settings) {
    tasks.push(writeManagedFile(serviceId, MANAGED_SETTINGS_FILE, renderSettingsFile(document.settingsProfiles)));
  } else {
    tasks.push(removeManagedFile(serviceId, MANAGED_SETTINGS_FILE));
  }
  if (fileManagement.composites) {
    tasks.push(writeManagedFile(serviceId, MANAGED_COMPOSITES_FILE, renderCompositesFile(document.composites)));
  } else {
    tasks.push(removeManagedFile(serviceId, MANAGED_COMPOSITES_FILE));
  }
  if (fileManagement.multimap) {
    tasks.push(writeManagedFile(serviceId, MANAGED_MULTIMAP_FILE, renderMultimapFile(document.multimaps)));
    const activeMapFiles = new Set(document.localMaps.map((map) => `${LOCAL_MAP_PREFIX}${map.slug}.map`));
    await Promise.all(document.localMaps.map((map) => writeManagedFile(serviceId, `${LOCAL_MAP_PREFIX}${map.slug}.map`, renderLocalMap(map))));
    await removeStaleLocalMaps(serviceId, activeMapFiles);
  } else {
    tasks.push(removeManagedFile(serviceId, MANAGED_MULTIMAP_FILE));
    await removeStaleLocalMaps(serviceId, new Set<string>());
  }

  await Promise.all(tasks);
}

export async function getRspamdRulesState(serviceId?: string): Promise<RspamdRulesState> {
  const settings = await getRspamdSettings(serviceId);
  const status = await getRspamdStatus(settings);
  const storedDocument = await getRspamdRulesDocument(serviceId);
  const document = normalizeRspamdRulesDocument(storedDocument ?? DEFAULT_DOCUMENT);
  const fileManagement = normalizeRulesFileManagement(await getRspamdFileManagement(serviceId));
  const files = await renderRulesFileStates(settings.serviceId ?? null, document, fileManagement);
  const validation = validateRspamdRulesDocument(document);
  return { settings: toPublicRspamdSettings(settings), status, fileManagement, document, files, validation };
}

export async function previewRspamdRules(
  documentInput: unknown,
  fileManagementInput: Partial<RspamdRulesFileManagement> | undefined,
  serviceId?: string,
): Promise<RspamdRulesState> {
  const settings = await getRspamdSettings(serviceId);
  const status = await getRspamdStatus(settings);
  const currentFileManagement = normalizeRulesFileManagement(await getRspamdFileManagement(serviceId));
  const fileManagement: RspamdRulesFileManagement = {
    ...currentFileManagement,
    ...fileManagementInput,
  };
  const document = normalizeRspamdRulesDocument(documentInput ?? DEFAULT_DOCUMENT);
  const validation = validateRspamdRulesDocument(document);
  const files = await renderRulesFileStates(settings.serviceId ?? null, document, fileManagement);
  return { settings: toPublicRspamdSettings(settings), status, fileManagement, document, files, validation };
}

export async function saveRspamdRules(
  documentInput: unknown,
  fileManagementInput: Partial<RspamdRulesFileManagement> | undefined,
  serviceId?: string,
): Promise<RspamdRulesState> {
  const settings = await getRspamdSettings(serviceId);
  if (!settings.serviceId) {
    throw new Error('No managed Rspamd service is configured in fleet_services');
  }
  const document = normalizeRspamdRulesDocument(documentInput ?? DEFAULT_DOCUMENT);
  const validation = validateRspamdRulesDocument(document);
  if (validation.errors.length > 0) {
    throw new Error(validation.errors[0]);
  }

  const fileManagementUpdates = {
    actions: fileManagementInput?.actions ?? undefined,
    groups: fileManagementInput?.groups ?? undefined,
    settings: fileManagementInput?.settings ?? undefined,
    composites: fileManagementInput?.composites ?? undefined,
    multimap: fileManagementInput?.multimap ?? undefined,
  };

  const fileManagement = normalizeRulesFileManagement(await updateRspamdFileManagement({
    actions: fileManagementUpdates.actions,
    groups: fileManagementUpdates.groups,
    settings: fileManagementUpdates.settings,
    composites: fileManagementUpdates.composites,
    multimap: fileManagementUpdates.multimap,
  }, settings.serviceId));

  await updateRspamdRulesDocument(toStoreDocument(document), settings.serviceId);
  await writeRulesFiles(settings.serviceId, document, fileManagement);
  return getRspamdRulesState(settings.serviceId);
}
