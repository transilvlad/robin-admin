// Shared config layering: one implementation of the "shared `default` base +
// per-instance delta override" model used by BOTH the pull-agent sync path
// (fleet-agent-sync.ts) and the admin read/save path (the per-service modules).
//
// - `deepMerge(base, override)` → the effective config (override wins, nested
//   records merge, unspecified keys fall through to base).
// - `extractDelta(base, effective)` → the inverse: only the keys whose value
//   differs from base (recursing into records); a key reverted to base is
//   dropped. This is what an instance override stores — "only the changed values".

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Effective config = base overlaid with override (deep, override wins). */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = merged[key];
    if (isRecord(baseValue) && isRecord(overrideValue)) {
      merged[key] = deepMerge(baseValue, overrideValue);
    } else {
      merged[key] = overrideValue;
    }
  }

  return merged;
}

/**
 * Delta = only the fields of `effective` that differ from `base`. Recurses into
 * nested records so a nested delta carries just the changed leaves. Keys equal to
 * base (or reverted to base) are omitted — so the override row holds solely the
 * instance's real changes. `deepMerge(base, extractDelta(base, effective))`
 * reproduces `effective` for every effective reachable by overriding base.
 */
export function extractDelta(
  base: Record<string, unknown>,
  effective: Record<string, unknown>,
): Record<string, unknown> {
  const delta: Record<string, unknown> = {};

  for (const [key, effValue] of Object.entries(effective)) {
    const baseValue = base[key];
    if (isRecord(baseValue) && isRecord(effValue)) {
      const nested = extractDelta(baseValue, effValue);
      if (Object.keys(nested).length > 0) {
        delta[key] = nested;
      }
    } else if (JSON.stringify(baseValue) !== JSON.stringify(effValue)) {
      delta[key] = effValue;
    }
  }

  return delta;
}
