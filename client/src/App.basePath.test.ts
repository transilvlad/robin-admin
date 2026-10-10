import { describe, expect, it } from 'vitest';
import { isOutsideBasePath } from './App';

describe('isOutsideBasePath', () => {
  it('treats paths outside a prefixed base as the public status page', () => {
    expect(isOutsideBasePath('/', '/admin')).toBe(true);
    expect(isOutsideBasePath('/status', '/admin')).toBe(true);
    expect(isOutsideBasePath('/administration', '/admin')).toBe(true);
  });

  it('keeps the application under its base and when hosted at the root', () => {
    expect(isOutsideBasePath('/admin', '/admin')).toBe(false);
    expect(isOutsideBasePath('/admin/status', '/admin')).toBe(false);
    expect(isOutsideBasePath('/admin/telemetry', '/admin')).toBe(false);
    expect(isOutsideBasePath('/', '/')).toBe(false);
    expect(isOutsideBasePath('/status', '/')).toBe(false);
  });
});
