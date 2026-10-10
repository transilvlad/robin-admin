import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ active: 0, peak: 0, done: 0, release: [] as Array<() => void> }));

vi.mock('../db/queries/config.js', () => ({
  getConfig: vi.fn(async () => ({ reportingAnalysisDebounceMs: 1000, reportingAnalysisConcurrency: 2 })),
}));

vi.mock('./dmarc-intelligence.js', () => ({
  analyzeDmarcIntelligence: vi.fn(async () => {
    state.active += 1;
    state.peak = Math.max(state.peak, state.active);
    await new Promise<void>((resolve) => state.release.push(resolve));
    state.active -= 1;
    state.done += 1;
    return { senders: 0, issues: 0 };
  }),
}));

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { reportingAnalysisLoad, scheduleReportingAnalysis } from './reporting-analysis-scheduler.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('reporting analysis scheduler', () => {
  beforeEach(() => {
    Object.assign(state, { active: 0, peak: 0, done: 0, release: [] });
  });

  it('runs a burst for many domains a few at a time instead of all at once', async () => {
    for (let index = 0; index < 10; index += 1) scheduleReportingAnalysis('dmarc', `domain${index}.example`);
    await wait(1100);

    expect(state.active).toBe(2);
    expect(reportingAnalysisLoad()).toEqual({ running: 2, queued: 8 });

    for (let round = 0; state.done < 10 && round < 30; round += 1) {
      state.release.splice(0).forEach((release) => release());
      await wait(20);
      expect(state.active).toBeLessThanOrEqual(2);
    }
    await wait(20);
    expect(state.done).toBe(10);
    expect(state.peak).toBe(2);
    expect(reportingAnalysisLoad()).toEqual({ running: 0, queued: 0 });
  });

  it('debounces repeat reports for one domain into one analysis', async () => {
    for (let index = 0; index < 5; index += 1) scheduleReportingAnalysis('dmarc', 'Same.example');
    await wait(1100);
    state.release.splice(0).forEach((release) => release());
    await wait(20);
    expect(state.done).toBe(1);
  });
});
