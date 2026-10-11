/**
 * Shared spine for per-file managed service configs (the Robin-style per-file
 * model applied to fleet services). Each managed file declares its defaults, a
 * normalizer (arbitrary payload → typed, validated values) and a renderer
 * (values → the real config-file text the agent writes). The service registry
 * owns rendering; the client owns the field metadata that drives a generic form.
 */

export const MANAGED_MARKER = '# Managed by Robin Admin';

export interface ManagedFileDef<T extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable key used in the API + client catalog (e.g. 'redis', 'logging'). */
  key: string;
  /** Real file name written into the service's config dir (e.g. 'redis.conf'). */
  fileName: string;
  defaults: T;
  normalize: (raw: unknown) => T;
  render: (values: T) => string;
}

/** Erase a typed file def to the base registry type (render is contravariant). */
export function asManagedFileDef<T extends Record<string, unknown>>(def: ManagedFileDef<T>): ManagedFileDef {
  return def as unknown as ManagedFileDef;
}

// ── coercion helpers ─────────────────────────────────────────────────────────
/**
 * A single-line directive value. Line breaks, NUL and double quotes are
 * replaced: they would let a value close its directive and inject new ones
 * (for example a Dovecot service block or a Postfix mailbox_command).
 */
export function cfgStr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v.replace(/[\r\n\0"]+/g, ' ') : fallback;
}
export function cfgNum(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
export function cfgBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
export function cfgOneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}
export function cfgRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The config-store payload file name that holds a managed file's typed values. */
export function valuesStoreFileName(key: string): string {
  return `robin-admin.${key}.values.json`;
}

// ── shared store loaders (reused by every service registry) ──────────────────
import {
  deleteConfigStoreEntry,
  getConfigStorePayload,
  upsertConfigStorePayload,
  type ConfigStoreTable,
  type ConfigStoreOwnerColumn,
} from '../db/queries/config-store.js';
import { deepMerge, extractDelta, isRecord } from '../db/queries/config-layering.js';

/** The shared base scope every instance override layers on top of. */
export const BASE_SCOPE = 'default';

/** A managed file's current state: its key, real name, typed values, rendered text. */
export interface ManagedFileEntry {
  key: string;
  fileName: string;
  values: Record<string, unknown>;
  rendered: string;
}

async function readValues(
  table: ConfigStoreTable,
  ownerCol: ConfigStoreOwnerColumn,
  ownerId: string,
  key: string,
): Promise<Record<string, unknown>> {
  const stored = await getConfigStorePayload<Record<string, unknown>>(table, ownerCol, ownerId, valuesStoreFileName(key));
  return isRecord(stored) ? stored : {};
}

/**
 * Load every managed file's EFFECTIVE entry for one scope: base ('default') ⊕
 * this scope's override delta, normalized + rendered. The base scope returns its
 * own values (or defaults when unset).
 */
export async function getManagedFileEntries(
  table: ConfigStoreTable,
  ownerCol: ConfigStoreOwnerColumn,
  ownerId: string | null | undefined,
  files: ManagedFileDef[],
): Promise<ManagedFileEntry[]> {
  const scope = (ownerId ?? '').trim() || BASE_SCOPE;
  return Promise.all(files.map(async (def) => {
    const base = await readValues(table, ownerCol, BASE_SCOPE, def.key);
    const effectiveRaw = scope === BASE_SCOPE
      ? base
      : deepMerge(base, await readValues(table, ownerCol, scope, def.key));
    const values = def.normalize(Object.keys(effectiveRaw).length ? effectiveRaw : def.defaults);
    return { key: def.key, fileName: def.fileName, values, rendered: def.render(values) };
  }));
}

/**
 * Save one managed file for a scope: the base scope stores the full values; an
 * instance scope stores ONLY the delta from base. Both also store the full
 * rendered file (`{content, managedBy}`) — the materialized effective file the
 * fleet agent writes (it replaces text files wholesale).
 */
export async function saveManagedFileEntry(
  table: ConfigStoreTable,
  ownerCol: ConfigStoreOwnerColumn,
  ownerId: string,
  def: ManagedFileDef,
  rawValues: unknown,
): Promise<ManagedFileEntry> {
  const scope = (ownerId ?? '').trim() || BASE_SCOPE;
  const values = def.normalize(rawValues);
  const rendered = def.render(values);
  const baseValues = def.normalize(await readValues(table, ownerCol, BASE_SCOPE, def.key));
  const toStore = scope === BASE_SCOPE
    ? (values as Record<string, unknown>)
    : extractDelta(baseValues as Record<string, unknown>, values as Record<string, unknown>);
  await upsertConfigStorePayload(table, ownerCol, scope, valuesStoreFileName(def.key), toStore);
  await upsertConfigStorePayload(table, ownerCol, scope, def.fileName, { content: rendered, managedBy: 'Robin Admin' });
  return { key: def.key, fileName: def.fileName, values, rendered };
}

/** Drop a scope's override for one managed file so it inherits base again. */
export async function resetManagedFileEntry(
  table: ConfigStoreTable,
  ownerCol: ConfigStoreOwnerColumn,
  ownerId: string,
  def: ManagedFileDef,
): Promise<void> {
  await deleteConfigStoreEntry(table, ownerCol, ownerId, valuesStoreFileName(def.key));
  await deleteConfigStoreEntry(table, ownerCol, ownerId, def.fileName);
}

// ── single-object layering (redis/postgres/dovecot-core/postfix-core/clamav) ──
// For services whose managed config is one JSON object stored under a literal
// file name (managed.json etc.). Same base ⊕ delta model, object-level.

export function scopeOf(ownerId?: string | null): string {
  return (ownerId ?? '').trim() || BASE_SCOPE;
}

async function readRawPayload(
  table: ConfigStoreTable,
  ownerCol: ConfigStoreOwnerColumn,
  ownerId: string,
  fileName: string,
): Promise<Record<string, unknown>> {
  const stored = await getConfigStorePayload<Record<string, unknown>>(table, ownerCol, ownerId, fileName);
  return isRecord(stored) ? stored : {};
}

/** Effective raw payload for a scope = base ⊕ this scope's override delta. */
export async function readLayeredPayload(
  table: ConfigStoreTable,
  ownerCol: ConfigStoreOwnerColumn,
  ownerId: string | null | undefined,
  fileName: string,
): Promise<Record<string, unknown>> {
  const scope = scopeOf(ownerId);
  const base = await readRawPayload(table, ownerCol, BASE_SCOPE, fileName);
  if (scope === BASE_SCOPE) return base;
  return deepMerge(base, await readRawPayload(table, ownerCol, scope, fileName));
}

/** Store a scope's effective object: base scope stores full, instance stores delta. */
export async function writeLayeredPayload(
  table: ConfigStoreTable,
  ownerCol: ConfigStoreOwnerColumn,
  ownerId: string | null | undefined,
  fileName: string,
  effective: Record<string, unknown>,
): Promise<void> {
  const scope = scopeOf(ownerId);
  const base = await readRawPayload(table, ownerCol, BASE_SCOPE, fileName);
  const toStore = scope === BASE_SCOPE ? effective : extractDelta(base, effective);
  await upsertConfigStorePayload(table, ownerCol, scope, fileName, toStore);
}

/** List the config scopes (owners) for a table: 'default' base ∪ override owners. */
export { listConfigStoreOwners } from '../db/queries/config-store.js';
