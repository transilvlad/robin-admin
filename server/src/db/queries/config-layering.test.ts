import { describe, expect, it } from 'vitest';
import { deepMerge, extractDelta, isRecord } from './config-layering.js';

describe('config-layering', () => {
  describe('deepMerge', () => {
    it('overlays override onto base, override wins on scalars', () => {
      expect(deepMerge({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
    });

    it('recurses into nested records', () => {
      expect(deepMerge({ x: { p: 1, q: 2 } }, { x: { q: 9 } })).toEqual({ x: { p: 1, q: 9 } });
    });

    it('replaces (does not merge) arrays and non-record values', () => {
      expect(deepMerge({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] });
      expect(deepMerge({ v: { a: 1 } }, { v: 'plain' })).toEqual({ v: 'plain' });
    });

    it('does not mutate the base object', () => {
      const base = { a: 1, nested: { b: 2 } };
      deepMerge(base, { nested: { b: 5 } });
      expect(base).toEqual({ a: 1, nested: { b: 2 } });
    });
  });

  describe('extractDelta', () => {
    it('keeps only fields that differ from base', () => {
      expect(extractDelta({ a: 1, b: 2, c: 3 }, { a: 1, b: 5, c: 3 })).toEqual({ b: 5 });
    });

    it('drops a field reverted to the base value', () => {
      expect(extractDelta({ level: 'info' }, { level: 'info' })).toEqual({});
    });

    it('recurses so only changed nested leaves are carried', () => {
      expect(extractDelta({ x: { p: 1, q: 2 } }, { x: { p: 1, q: 9 } })).toEqual({ x: { q: 9 } });
    });

    it('omits a nested record with no changes', () => {
      expect(extractDelta({ x: { p: 1 } }, { x: { p: 1 } })).toEqual({});
    });

    it('treats arrays as whole values (changed array is kept verbatim)', () => {
      expect(extractDelta({ list: [1, 2] }, { list: [1, 2, 3] })).toEqual({ list: [1, 2, 3] });
      expect(extractDelta({ list: [1, 2] }, { list: [1, 2] })).toEqual({});
    });
  });

  describe('round-trip', () => {
    it('deepMerge(base, extractDelta(base, effective)) reproduces effective', () => {
      const base = { a: 1, b: 'x', nested: { p: 1, q: 2 }, list: [1] };
      const effective = { a: 1, b: 'y', nested: { p: 1, q: 9 }, list: [1, 2] };
      const delta = extractDelta(base, effective);
      // The delta carries only the changes…
      expect(delta).toEqual({ b: 'y', nested: { q: 9 }, list: [1, 2] });
      // …and re-layering it on base yields the full effective config.
      expect(deepMerge(base, delta)).toEqual(effective);
    });
  });

  describe('isRecord', () => {
    it('is true only for plain objects', () => {
      expect(isRecord({})).toBe(true);
      expect(isRecord([])).toBe(false);
      expect(isRecord(null)).toBe(false);
      expect(isRecord('s')).toBe(false);
    });
  });
});
