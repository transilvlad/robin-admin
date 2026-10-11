import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/connection.js', () => ({ query: vi.fn(), getClient: vi.fn() }));

const { sumDelta } = await import('./dashboard.js');

describe('sumDelta', () => {
  it('skips zero placeholders stored while a service was unreachable', () => {
    const history = [
      { reachable: true, total: 1000 },
      { reachable: false, total: 0 },
      { reachable: true, total: 1010 },
    ];
    expect(sumDelta(history, (row) => row.total)).toBe(10);
  });

  it('keeps unreachable samples that still carry a value', () => {
    const history = [
      { reachable: true, total: 10 },
      { reachable: false, total: 25 },
    ];
    expect(sumDelta(history, (row) => row.total)).toBe(15);
  });
});
