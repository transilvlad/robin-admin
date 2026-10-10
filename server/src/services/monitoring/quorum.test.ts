import { describe, expect, it } from 'vitest';
import { combineLocationVerdicts, type LocationVerdict } from './quorum.js';

const locations = (...statuses: LocationVerdict['status'][]): LocationVerdict[] =>
  statuses.map((status, index) => ({
    locationId: index + 1,
    locationName: `Location ${index + 1}`,
    status,
    errorCode: null,
    observedAt: new Date('2026-10-06T00:00:00Z'),
  }));

describe('combineLocationVerdicts', () => {
  it.each([
    [1, ['up'], 0, 'up'],
    [1, ['down'], 0, 'down'],
    [2, ['down', 'up'], 0, 'warning'],
    [2, ['down', 'down'], 0, 'down'],
    [3, ['down', 'down', 'up'], 0, 'down'],
    [3, ['warning', 'up', 'up'], 0, 'warning'],
    [3, ['up', 'up', 'up'], 0, 'up'],
    [3, ['down', 'up'], 0, 'warning'],
    [3, ['down', 'up'], 2, 'warning'],
    [3, ['down', 'up'], 3, 'unknown'],
    [0, [], 0, 'unknown'],
  ] as const)('combines %i assigned locations (%s) with quorum %i as %s', (assigned, statuses, quorum, expected) => {
    expect(combineLocationVerdicts(assigned, locations(...statuses), quorum).status).toBe(expected);
  });
});
