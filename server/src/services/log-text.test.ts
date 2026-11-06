import { describe, expect, it } from 'vitest';
import { normalizeLogText, truncateLogText } from './log-text.js';

describe('normalizeLogText', () => {
  it('replaces unsupported characters without damaging adjacent surrogate pairs', () => {
    const text = 'a\uD800\uD800\uDC00\uDC00\u0000z';
    const normalized = 'a\uFFFD\uD800\uDC00\uFFFD\uFFFDz';
    expect(normalizeLogText(text)).toBe(normalized);
    expect(normalizeLogText(normalized)).toBe(normalized);
  });
});

describe('truncateLogText', () => {
  it('preserves a complete replacement character at the boundary', () => {
    expect(truncateLogText('aa\uFFFDmore', 8)).toBe('aa\uFFFD…');
  });

  it('never leaves an incomplete UTF-8 character', () => {
    expect(truncateLogText('aaaa\uD83D\uDE00more', 8)).toBe('aaaa…');
    expect(truncateLogText('a\uD83D\uDE00b', 8)).toBe('a\uD83D\uDE00b');
  });

  it('rejects limits too small for the truncation marker', () => {
    expect(() => truncateLogText('text', 2)).toThrow(RangeError);
  });
});
