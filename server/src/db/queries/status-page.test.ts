import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../connection.js';
import {
  incidentTimeline,
  incidentTitle,
  listStatusPageComponents,
  planIncidentAssignments,
  resetPublicStatusPageSyncForTests,
  syncAutomaticStatusPageReports,
  syncAutomaticStatusPageReportsForPublicView,
  timelineUpdates,
  type IncidentIssueComponent,
} from './status-page.js';

vi.mock('../connection.js', () => ({
  query: vi.fn(),
}));

function queryResult<T>(rows: T[], rowCount = rows.length) {
  return { rows, rowCount } as never;
}

describe('status page automatic reports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves open automatic reports that no longer have public check mappings', async () => {
    const resolvedAt = new Date('2026-10-10T08:00:00Z');
    vi.mocked(query)
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([{ id: 44, resolved_at: resolvedAt }]))
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([]));

    await syncAutomaticStatusPageReports();

    const cleanupCall = vi.mocked(query).mock.calls[1];
    expect(cleanupCall[0]).toContain("WHERE source = 'automatic'");
    expect(cleanupCall[0]).toContain("AND status = 'open'");
    expect(cleanupCall[0]).toContain('id <> ALL($1::bigint[])');
    expect(cleanupCall[1]).toEqual([[]]);

    const updateCall = vi.mocked(query).mock.calls[2];
    expect(updateCall[0]).toContain('INSERT INTO status_page_report_updates');
    expect(updateCall[1]).toEqual([44, resolvedAt]);
  });

  it('syncs only open and recently closed issues', async () => {
    vi.mocked(query).mockResolvedValue(queryResult([]));

    await syncAutomaticStatusPageReports();

    const linkedIssuesCall = vi.mocked(query).mock.calls[0];
    expect(linkedIssuesCall[0]).toContain("i.status = 'open' OR i.closed_at > CURRENT_TIMESTAMP - INTERVAL '7 days'");
  });

  it('shares one sync between public page views within the interval', async () => {
    resetPublicStatusPageSyncForTests();
    vi.mocked(query).mockResolvedValue(queryResult([]));
    const linkedIssueQueries = () => vi.mocked(query).mock.calls.filter(([sql]) => String(sql).includes('FROM monitoring_issues i')).length;

    await Promise.all([syncAutomaticStatusPageReportsForPublicView(), syncAutomaticStatusPageReportsForPublicView()]);
    await syncAutomaticStatusPageReportsForPublicView();
    expect(linkedIssueQueries()).toBe(1);

    vi.useFakeTimers({ now: Date.now() + 16_000, toFake: ['Date'] });
    await syncAutomaticStatusPageReportsForPublicView();
    vi.useRealTimers();
    expect(linkedIssueQueries()).toBe(2);
  });
});

describe('status page history availability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('excludes certificate-error warnings from component uptime', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce(queryResult([{
        id: 1,
        section_id: 2,
        section_name: 'Web',
        public_name: 'Website',
        description: null,
        position: 0,
        enabled: true,
        show_history: true,
        created_at: new Date(),
        updated_at: new Date(),
      }]))
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([]))
      .mockResolvedValueOnce(queryResult([{ component_id: 1, reachable: '992', total: '1000' }]));

    const components = await listStatusPageComponents(30);

    expect(components[0]?.uptimePercent).toBe(99.2);
    expect(vi.mocked(query).mock.calls[4]?.[0]).toContain('d.warning_count - d.unavailable_warning_count');
  });
});

const at = (time: string) => new Date(`2026-10-10T${time}:00Z`);

describe('automatic incident grouping', () => {
  it('puts issues that open while an incident is open into that incident', () => {
    const plan = planIncidentAssignments(
      [
        { issueId: 2, openedAt: at('10:03'), closedAt: null },
        { issueId: 3, openedAt: at('10:05'), closedAt: at('10:20') },
      ],
      [{ reportId: 7, openedAt: at('10:00'), endAt: null }],
      15,
    );
    expect(plan.map((entry) => entry.reportId)).toEqual([7, 7]);
  });

  it('joins an incident that resolved within the grouping window and not after it', () => {
    const candidates = [{ reportId: 7, openedAt: at('10:00'), endAt: at('10:10') }];
    expect(planIncidentAssignments([{ issueId: 2, openedAt: at('10:20'), closedAt: null }], candidates, 15)[0].reportId).toBe(7);
    const late = planIncidentAssignments([{ issueId: 2, openedAt: at('10:30'), closedAt: null }], candidates, 15)[0];
    expect(late.reportId).toBeNull();
    expect(late.newKey).toBe('new-2');
  });

  it('groups new issues with each other into one new incident', () => {
    const plan = planIncidentAssignments(
      [
        { issueId: 5, openedAt: at('11:01'), closedAt: null },
        { issueId: 4, openedAt: at('11:00'), closedAt: at('11:02') },
      ],
      [],
      15,
    );
    expect(plan.map((entry) => entry.newKey)).toEqual(['new-4', 'new-4']);
    expect(plan.every((entry) => entry.reportId === null)).toBe(true);
  });

  it('gives every issue its own incident when grouping is off', () => {
    const plan = planIncidentAssignments(
      [
        { issueId: 2, openedAt: at('10:03'), closedAt: null },
        { issueId: 3, openedAt: at('10:04'), closedAt: null },
      ],
      [{ reportId: 7, openedAt: at('10:00'), endAt: null }],
      0,
    );
    expect(plan.map((entry) => entry.newKey)).toEqual(['new-2', 'new-3']);
  });
});

describe('automatic incident timeline', () => {
  const row = (overrides: Partial<IncidentIssueComponent>): IncidentIssueComponent => ({
    issueId: 1, open: false, critical: true, openedAt: at('01:02'), closedAt: at('01:24'), componentId: 1, publicName: 'mail.example.com', ...overrides,
  });

  it('describes when each service went down and recovered, resolving on the last recovery', () => {
    const timeline = incidentTimeline([
      row({ issueId: 1, componentId: 1, publicName: 'mail.example.com', openedAt: at('01:02'), closedAt: at('01:24') }),
      row({ issueId: 2, componentId: 2, publicName: 'IMAP mail.example.com:993', openedAt: at('01:03'), closedAt: at('01:24') }),
      row({ issueId: 3, componentId: 3, publicName: 'SMTP mail.example.com:465', openedAt: at('01:03'), closedAt: at('01:25') }),
    ]);
    expect(timeline.title).toBe('mail.example.com, IMAP mail.example.com:993, and 1 other service are down');
    expect(timeline.status).toBe('resolved');
    expect(timeline.resolvedAt).toEqual(at('01:25'));
    const updates = timelineUpdates(timeline, new Set());
    expect(updates.map((update) => [update.status, update.message])).toEqual([
      ['investigating', 'mail.example.com went down.'],
      ['investigating', 'IMAP mail.example.com:993 and SMTP mail.example.com:465 went down.'],
      ['monitoring', 'IMAP mail.example.com:993 and mail.example.com recovered.'],
      ['resolved', 'SMTP mail.example.com:465 recovered.'],
    ]);
  });

  it('stays open while any issue is open and posts each event once', () => {
    const timeline = incidentTimeline([
      row({ issueId: 1, componentId: 1, openedAt: at('02:00'), closedAt: at('02:05') }),
      row({ issueId: 2, componentId: 2, publicName: 'IMAP', open: true, closedAt: null, openedAt: at('02:10') }),
    ]);
    expect(timeline.status).toBe('open');
    expect(timeline.resolvedAt).toBeNull();
    const first = timelineUpdates(timeline, new Set());
    expect(first.map((update) => update.status)).toEqual(['investigating', 'monitoring', 'investigating']);
    const posted = new Set(first.flatMap((update) => update.eventKeys));
    expect(timelineUpdates(timeline, posted)).toEqual([]);
  });

  it('treats overlapping issues on one service as a single outage', () => {
    const timeline = incidentTimeline([
      row({ issueId: 1, openedAt: at('03:00'), closedAt: at('03:10') }),
      row({ issueId: 2, openedAt: at('03:05'), closedAt: at('03:20'), critical: false }),
    ]);
    expect(timeline.events.map((event) => [event.kind, event.at])).toEqual([['down', at('03:00')], ['up', at('03:20')]]);
    expect(timeline.impact).toBe('outage');
  });

  it('names one, two and many services in the title', () => {
    expect(incidentTitle(['A'], 'outage')).toBe('A is down');
    expect(incidentTitle(['A', 'B'], 'degraded')).toBe('A and B are degraded');
    expect(incidentTitle(['A', 'B', 'C', 'D'], 'outage')).toBe('A, B, and 2 other services are down');
    expect(incidentTitle(['x'.repeat(200), 'y'.repeat(200)], 'outage')).toHaveLength(255);
  });
});
