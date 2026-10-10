import { describe, expect, it } from 'vitest';
import { normalizeBasePath, prefixAppPath } from './basePath';

describe('base path helpers', () => {
  it('normalizes root and path-prefixed deployment bases', () => {
    expect(normalizeBasePath()).toBe('/');
    expect(normalizeBasePath('/admin')).toBe('/admin/');
    expect(normalizeBasePath('/admin/')).toBe('/admin/');
  });

  it('prefixes root-relative hosted module assets without changing absolute URLs', () => {
    expect(prefixAppPath('/modules/robin-tools/remoteEntry.js', '/admin/'))
      .toBe('/admin/modules/robin-tools/remoteEntry.js');
    expect(prefixAppPath('/modules/robin-tools/remoteEntry.js', '/'))
      .toBe('/modules/robin-tools/remoteEntry.js');
    expect(prefixAppPath('https://modules.example.test/remoteEntry.js', '/admin/'))
      .toBe('https://modules.example.test/remoteEntry.js');
  });

  it('rejects a relative deployment base', () => {
    expect(() => normalizeBasePath('admin')).toThrow('Base path must start with "/"');
  });
});
