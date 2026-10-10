import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, mockUpsertIssue, mockRecordObservation, mockCountObservations, mockCountAbsences } =
  vi.hoisted(() => ({
    mockQuery: vi.fn(),
    mockUpsertIssue: vi.fn(),
    mockRecordObservation: vi.fn(),
    mockCountObservations: vi.fn(),
    mockCountAbsences: vi.fn(),
  }));

vi.mock('../db/connection.js', () => ({ query: mockQuery }));

vi.mock('../db/queries/reporting.js', () => ({
  buildIssueFingerprint: (domain: string, issueType: string) => `${domain}|${issueType}`,
  upsertIssue: mockUpsertIssue,
}));

vi.mock('../db/queries/analysis-runs.js', () => ({
  recordObservation: mockRecordObservation,
  countConsecutiveObservations: mockCountObservations,
  countConsecutiveAbsences: mockCountAbsences,
}));

import {
  autoResolveClearedIssues,
  GRACE_RUNS,
  isDeterministic,
  raiseIssue,
  REQUIRED_RUNS,
} from './detection-policy.js';

function ctx() {
  return {
    kind: 'dmarc' as const,
    runId: 1,
    windowStart: new Date('2026-05-01T00:00:00Z'),
    windowEnd: new Date('2026-05-08T00:00:00Z'),
    counters: {
      domainsProcessed: 0,
      issuesOpened: 0,
      issuesRefreshed: 0,
      issuesResolved: 0,
      issuesPending: 0,
    },
  };
}

const baseInput = {
  domain: 'example.com',
  issueType: 'unknown_sender' as const,
  severity: 'medium' as const,
  title: 'Unknown sender',
  description: 'Unclassified volume',
  evidence: { metrics: { totalVolume: 500 } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRecordObservation.mockResolvedValue(undefined);
  mockUpsertIssue.mockResolvedValue({ issue: { id: 9 }, created: true });
  // Default: issue not already tracked.
  mockQuery.mockResolvedValue({ rows: [{ exists: false }], rowCount: 0 });
});

describe('persistence gate', () => {
  it('withholds a statistical issue on the first observation', async () => {
    mockCountObservations.mockResolvedValue(1);
    const c = ctx();

    const result = await raiseIssue(c, baseInput);

    expect(result.pending).toBe(true);
    expect(result.issue).toBeNull();
    expect(mockUpsertIssue).not.toHaveBeenCalled();
    // The observation is still recorded, otherwise no streak could ever build.
    expect(mockRecordObservation).toHaveBeenCalledTimes(1);
    expect(c.counters.issuesPending).toBe(1);
    expect(c.counters.issuesOpened).toBe(0);
  });

  it('opens the issue once the streak reaches REQUIRED_RUNS', async () => {
    mockCountObservations.mockResolvedValue(REQUIRED_RUNS);
    const c = ctx();

    const result = await raiseIssue(c, baseInput);

    expect(result.pending).toBe(false);
    expect(result.created).toBe(true);
    expect(mockUpsertIssue).toHaveBeenCalledTimes(1);
    expect(c.counters.issuesOpened).toBe(1);
  });

  it('refreshes an already-tracked issue even when the streak is short', async () => {
    mockCountObservations.mockResolvedValue(1);
    mockQuery.mockResolvedValue({ rows: [{ exists: true }], rowCount: 1 });
    mockUpsertIssue.mockResolvedValue({ issue: { id: 9 }, created: false });
    const c = ctx();

    const result = await raiseIssue(c, baseInput);

    expect(result.pending).toBe(false);
    expect(c.counters.issuesRefreshed).toBe(1);
  });

  it('fires deterministic config issues immediately', async () => {
    mockCountObservations.mockResolvedValue(0);
    const c = ctx();

    const result = await raiseIssue(c, {
      ...baseInput,
      issueType: 'dmarc_none_policy',
      severity: 'high',
    });

    expect(result.pending).toBe(false);
    expect(mockUpsertIssue).toHaveBeenCalledTimes(1);
    // Never consults the streak for deterministic types.
    expect(mockCountObservations).not.toHaveBeenCalled();
  });

  it('classifies config readings as deterministic and aggregates as statistical', () => {
    expect(isDeterministic('dmarc_none_policy')).toBe(true);
    expect(isDeterministic('dmarc_subdomain_policy_gap')).toBe(true);
    expect(isDeterministic('reports_missing')).toBe(true);
    expect(isDeterministic('spoofing_detected')).toBe(false);
    expect(isDeterministic('unknown_sender')).toBe(false);
  });

  it('records the trigger with the window and streak so the UI can explain the issue', async () => {
    mockCountObservations.mockResolvedValue(REQUIRED_RUNS);
    const c = ctx();

    await raiseIssue(c, {
      ...baseInput,
      trigger: { metric: 'totalVolume', value: 500, threshold: 50, comparator: '>' },
    });

    const evidence = mockUpsertIssue.mock.calls[0][5];
    expect(evidence.trigger).toMatchObject({
      metric: 'totalVolume',
      value: 500,
      threshold: 50,
      comparator: '>',
      consecutiveRuns: REQUIRED_RUNS,
      requiredRuns: REQUIRED_RUNS,
      windowStart: '2026-05-01T00:00:00.000Z',
      windowEnd: '2026-05-08T00:00:00.000Z',
    });
  });
});

describe('auto-resolve grace period', () => {
  it('does not resolve while absences are below the grace period', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 3, issue_fingerprint: 'example.com|unknown_sender' }],
      rowCount: 1,
    });
    mockCountAbsences.mockResolvedValue(GRACE_RUNS - 1);
    const c = ctx();

    const resolved = await autoResolveClearedIssues(c, 'example.com', ['unknown_sender'], 'cleared');

    expect(resolved).toBe(0);
    expect(c.counters.issuesResolved).toBe(0);
    // Only the SELECT ran; no UPDATE was issued.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('resolves once the condition has been absent for GRACE_RUNS runs', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 3, issue_fingerprint: 'example.com|unknown_sender' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockCountAbsences.mockResolvedValue(GRACE_RUNS);
    const c = ctx();

    const resolved = await autoResolveClearedIssues(c, 'example.com', ['unknown_sender'], 'cleared');

    expect(resolved).toBe(1);
    expect(c.counters.issuesResolved).toBe(1);
    const updateSql = mockQuery.mock.calls[1][0] as string;
    expect(updateSql).toContain("status = 'resolved'");
  });

  it('is a no-op when no issue types are supplied', async () => {
    const resolved = await autoResolveClearedIssues(ctx(), 'example.com', [], 'cleared');
    expect(resolved).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
