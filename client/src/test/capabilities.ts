/**
 * Test double for fleet capabilities. Pages see every capability as available
 * unless a test denies some with `denyCapabilities`; `resetCapabilities` runs
 * before each test (see setup.ts).
 */
const denied = new Set<string>();

export function denyCapabilities(...ids: string[]): void {
  ids.forEach((id) => denied.add(id));
}

export function resetCapabilities(): void {
  denied.clear();
}

export function capabilityAllowed(id: string): boolean {
  return !denied.has(id);
}
