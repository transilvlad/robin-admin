import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}));

vi.mock('../connection.js', () => ({
  query: mockQuery,
}));

import {
  upsertIssue,
  createRemediation,
} from './reporting.js';

function buildIssueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 12,
    domain: 'example.com',
    issue_type: 'spoofing_detected',
    severity: 'critical',
    title: 'Spoofing detected',
    description: 'Investigate unauthorized sender',
    evidence: { senderIps: ['203.0.113.25'], metrics: { totalVolume: 42 } },
    affected_senders: ['203.0.113.25'],
    affected_volume: '42',
    first_detected: '2026-05-01T00:00:00.000Z',
    last_detected: '2026-05-03T00:00:00.000Z',
    status: 'open',
    resolved_at: null,
    resolution_notes: null,
    muted_until: null,
    sender_ids: [7],
    created_at: '2026-05-01T00:00:00.000Z',
    status_history: [],
    ...overrides,
  };
}

function buildRemediationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 55,
    issue_id: 12,
    domain: 'example.com',
    suggestion_type: 'dns_fix',
    priority: 1,
    title: 'Publish strict DMARC',
    description: 'Move to quarantine once aligned sources are stable.',
    action_steps: [],
    dns_changes: [],
    verification_steps: [],
    estimated_impact: 'Reduces spoofing exposure',
    created_at: '2026-05-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('reporting queries', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('creates fingerprinted issues with derived sender impact', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [buildIssueRow()] });

    const { issue } = await upsertIssue(
      'example.com',
      'spoofing_detected',
      'critical',
      'Spoofing detected',
      'Investigate unauthorized sender',
      { senderIps: ['203.0.113.25'], metrics: { totalVolume: 42 } },
      [7]
    );

    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('WHERE issue_fingerprint = $1'),
      [expect.any(String)]
    );

    const insertParams = mockQuery.mock.calls[1][1] as unknown[];
    expect(mockQuery.mock.calls[1][0]).toContain('INSERT INTO reporting_issues');
    expect(insertParams[6]).toMatch(/^[a-f0-9]{40}$/);
    expect(insertParams[9]).toBe(42);
    expect(JSON.parse(insertParams[10] as string)).toEqual([
      expect.objectContaining({ status: 'open', source: 'detector', note: 'detected' }),
    ]);
    expect(issue.affectedVolume).toBe(42);
    expect(issue.status).toBe('open');
  });

  it('reopens previously resolved issues instead of inserting duplicates', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        buildIssueRow({
          status: 'resolved',
          resolved_at: '2026-05-02T00:00:00.000Z',
          status_history: [{ status: 'resolved', source: 'operator', note: 'closed' }],
        }),
      ],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [
        buildIssueRow({
          status: 'open',
          resolved_at: null,
        }),
      ],
    });

    const { issue } = await upsertIssue(
      'example.com',
      'spoofing_detected',
      'critical',
      'Spoofing detected',
      'Investigate unauthorized sender',
      { senderIps: ['203.0.113.25'], metrics: { totalVolume: 42 } },
      [7]
    );

    expect(mockQuery.mock.calls[1][0]).toContain('UPDATE reporting_issues');

    const updateParams = mockQuery.mock.calls[1][1] as unknown[];
    expect(mockQuery.mock.calls[1][0]).toContain('status = $9::varchar(20)');
    expect(mockQuery.mock.calls[1][0]).toContain("resolved_at = CASE WHEN $9::text = 'open'");
    expect(updateParams[8]).toBe('open');
    expect(JSON.parse(updateParams[10] as string)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'open',
          source: 'detector',
          note: 'reopened from detector evidence',
        }),
      ])
    );
    expect(issue.status).toBe('open');
    expect(issue.resolvedAt).toBeNull();
  });

  it('refreshes an existing remediation suggestion instead of duplicating it', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [buildRemediationRow()] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        buildRemediationRow({
          title: 'Publish p=quarantine after validating aligned mail streams',
        }),
      ],
    });

    const remediation = await createRemediation({
      issueId: 12,
      domain: 'example.com',
      suggestionType: 'dns_fix',
      priority: 1,
      title: 'Publish p=quarantine after validating aligned mail streams',
      description: 'Harden enforcement once false positives are understood.',
      actionSteps: [],
      dnsChanges: [],
      verificationSteps: [],
      estimatedImpact: 'Reduces spoofing exposure',
    });

    expect(mockQuery.mock.calls[1][0]).toContain('UPDATE remediation_suggestions');
    expect(remediation.id).toBe(55);
    expect(remediation.title).toContain('p=quarantine');
  });
});
