/**
 * Reporting API v2 — every endpoint scoped to one explicit timeframe.
 *
 * The timeframe is resolved once per request from the same parameters and
 * returned in the response, so clients can show exactly what period each result
 * describes.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireEditor } from '../middleware/rbac.js';
import {
  resolveTimeframe,
  getTotals,
  getDomainAggregates,
  getDomainAggregate,
  getReporterAggregates,
  getRecords,
  getTrend,
  type AggregateScope,
  type DomainSort,
  type RecordSort,
  type SortDirection,
  type TimeframeInfo,
} from '../services/reporting-aggregate.js';
import type { ComplianceClass } from '../services/dmarc-taxonomy.js';
import {
  getSourceAggregates,
  setSourceReview,
  type SourceBucket,
  type SourceReviewState,
  type SourceSort,
} from '../services/reporting-sources.js';
import { backfillIdentities } from '../services/source-identity.js';
import { ReportingCapacityError } from '../services/reporting-capacity.js';
import { createAuditEntry } from '../db/queries/audit.js';
import { routeParam } from './params.js';

const router = Router();

router.use(requireAuth);

const SOURCE_BUCKETS: readonly (SourceBucket | 'all')[] = [
  'all',
  'capable',
  'non_compliant',
  'forwarder',
  'threat_unknown',
];
const REVIEW_STATES: readonly SourceReviewState[] = ['pending', 'authorized', 'forwarder', 'threat'];
const DOMAIN_SORTS: readonly DomainSort[] = ['volume', 'compliance', 'actionable', 'domain'];
const SOURCE_SORTS: readonly SourceSort[] = ['volume', 'compliance', 'actionable', 'domains', 'name'];
const RECORD_SORTS: readonly RecordSort[] = ['volume', 'date', 'domain', 'source'];
const RECORD_CLASSES: readonly ComplianceClass[] = [
  'compliant',
  'authenticated_unaligned',
  'failed',
];

/** Tri-state: absent means "no filter", which is not the same as false. */
function bool(value: unknown): boolean | undefined {
  const text = str(value)?.toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return undefined;
}

function str(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : undefined;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const text = str(value);
  return text && (allowed as readonly string[]).includes(text) ? (text as T) : undefined;
}

function direction(value: unknown): SortDirection {
  return str(value) === 'asc' ? 'asc' : 'desc';
}

function scopeFrom(req: Request): AggregateScope {
  return {
    domain: str(req.query.domain) ?? null,
    sourceIp: str(req.query.sourceIp) ?? null,
    reporter: str(req.query.reporter) ?? null,
  };
}

function timeframeFrom(req: Request) {
  return resolveTimeframe({
    from: str(req.query.from) ?? null,
    to: str(req.query.to) ?? null,
    days: str(req.query.days) ? int(req.query.days, 30, 1, 3650) : null,
  });
}

/**
 * Serialise the timeframe for the client. `stale` and `dataAgeDays` are always
 * present so the UI can say "the newest report is 108 days old" instead of
 * rendering an empty dashboard that reads as good news.
 */
function timeframePayload(timeframe: TimeframeInfo) {
  return {
    from: timeframe.from.toISOString(),
    to: timeframe.to.toISOString(),
    dataFrom: timeframe.dataFrom?.toISOString() ?? null,
    dataTo: timeframe.dataTo?.toISOString() ?? null,
    dataAgeDays: timeframe.dataAgeDays,
    empty: timeframe.empty,
    stale: timeframe.stale,
    defaulted: timeframe.defaulted,
  };
}

function fail(res: Response, error: unknown): void {
  if (error instanceof ReportingCapacityError) {
    res.setHeader('Retry-After', '1');
    res.status(503).json({ success: false, error: error.message });
    return;
  }
  res.status(500).json({ success: false, error: (error as Error).message });
}

/**
 * GET /api/reporting/timeframe
 * The true extent of the report data, plus the resolved window.
 */
router.get('/timeframe', async (req: Request, res: Response) => {
  try {
    const timeframe = await timeframeFrom(req);
    res.json({ success: true, data: timeframePayload(timeframe) });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * GET /api/reporting/overview
 * Headline figures, taxonomy breakdown, source buckets and trend.
 */
router.get('/overview', async (req: Request, res: Response) => {
  try {
    const timeframe = await timeframeFrom(req);
    const scope = scopeFrom(req);

    // One source scan and one domain scan serve the whole screen. Overview used
    // to ask for bucket counts here while the page separately fetched sources
    // and domains, so opening it ran the most expensive scan three times.
    const [totals, sources, domains, trend, reporters] = await Promise.all([
      getTotals(timeframe, scope),
      getSourceAggregates(timeframe, scope, {
        bucket: 'all',
        sort: 'actionable',
        direction: 'desc',
        limit: 8,
      }),
      getDomainAggregates(timeframe, scope, { sort: 'actionable', direction: 'desc', limit: 8 }),
      getTrend(timeframe, scope),
      getReporterAggregates(timeframe, scope, { limit: 8 }),
    ]);

    res.json({
      success: true,
      data: {
        timeframe: timeframePayload(timeframe),
        totals,
        sourceBuckets: sources.bucketCounts,
        topSources: sources.items,
        topDomains: domains.items,
        trend,
        reporters,
      },
    });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * GET /api/reporting/sources
 * The core screen: sending services across all domains.
 */
router.get('/sources', async (req: Request, res: Response) => {
  try {
    const timeframe = await timeframeFrom(req);
    const scope = scopeFrom(req);

    const page = await getSourceAggregates(timeframe, scope, {
      limit: int(req.query.limit, 50, 1, 500),
      offset: int(req.query.offset, 0, 0, 100000),
      sort: oneOf(req.query.sort, SOURCE_SORTS),
      direction: direction(req.query.direction),
      bucket: oneOf(req.query.bucket, SOURCE_BUCKETS),
      search: str(req.query.search),
    });

    res.json({
      success: true,
      data: page.items,
      pagination: { total: page.total, limit: page.limit, offset: page.offset },
      meta: { timeframe: timeframePayload(timeframe), buckets: page.bucketCounts },
    });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * POST /api/reporting/sources/:key/review
 * Record an operator decision about a sending service. The decision is held
 * against the service, so approving one covers every domain it sends for.
 */
router.post('/sources/:key/review', requireEditor, async (req: Request, res: Response) => {
  try {
    const key = decodeURIComponent(routeParam(req, 'key') ?? '').trim();
    const state = oneOf(req.body?.state, REVIEW_STATES);

    if (!key) {
      res.status(400).json({ success: false, error: 'Source key is required' });
      return;
    }
    if (!state) {
      res.status(400).json({
        success: false,
        error: `state must be one of: ${REVIEW_STATES.join(', ')}`,
      });
      return;
    }

    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 2000) : null;
    const actor = req.session?.admin?.email ?? 'unknown';

    await setSourceReview(key, state, actor, note);
    await createAuditEntry(
      req.session?.admin?.id ?? null,
      'reporting.source.review',
      'reporting_source',
      key,
      null,
      { state, note },
      req.ip ?? null
    ).catch(() => {
      // Audit failure must not lose the operator's decision.
    });

    res.json({ success: true, data: { key, state, note } });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * GET /api/reporting/domains
 * Fleet view: one row per domain, ordered by whatever the operator cares about.
 */
router.get('/domains', async (req: Request, res: Response) => {
  try {
    const timeframe = await timeframeFrom(req);
    // Fleet baseline comes out with the page so the client's metric cards don't
    // re-issue getOverview on every sort/search/paging change. Both reads share
    // the reporting cache when the timeframe matches.
    const [page, fleet] = await Promise.all([
      getDomainAggregates(timeframe, scopeFrom(req), {
        limit: int(req.query.limit, 50, 1, 500),
        offset: int(req.query.offset, 0, 0, 100000),
        sort: oneOf(req.query.sort, DOMAIN_SORTS),
        direction: direction(req.query.direction),
        search: str(req.query.search),
      }),
      getTotals(timeframe),
    ]);

    res.json({
      success: true,
      data: page.items,
      pagination: { total: page.total, limit: page.limit, offset: page.offset },
      meta: {
        timeframe: timeframePayload(timeframe),
        fleet: {
          complianceRate: fleet.complianceRate,
          totalVolume: fleet.breakdown.totalVolume,
          actionableFailureVolume: fleet.breakdown.actionableFailureVolume,
        },
      },
    });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * GET /api/reporting/domains/:domain
 * One domain's workspace: its figures, its sources, its trend.
 */
router.get('/domains/:domain', async (req: Request, res: Response) => {
  try {
    const domain = decodeURIComponent(routeParam(req, 'domain') ?? '').trim().toLowerCase();
    if (!domain) {
      res.status(400).json({ success: false, error: 'Domain is required' });
      return;
    }

    const timeframe = await timeframeFrom(req);
    const scope: AggregateScope = { domain };

    const [aggregate, sources, trend, reporters] = await Promise.all([
      getDomainAggregate(timeframe, domain),
      getSourceAggregates(timeframe, scope, { limit: 100, sort: 'volume' }),
      getTrend(timeframe, scope),
      getReporterAggregates(timeframe, scope, { limit: 8 }),
    ]);

    res.json({
      success: true,
      data: {
        timeframe: timeframePayload(timeframe),
        domain: aggregate,
        sources: sources.items,
        trend,
        reporters,
      },
    });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * POST /api/reporting/sources/resolve
 * Refresh IP-to-service identification. Safe to call repeatedly; it only works
 * on addresses whose cached identity is missing or stale.
 */
router.post('/sources/resolve', requireEditor, async (req: Request, res: Response) => {
  try {
    const result = await backfillIdentities({ limit: int(req.body?.limit, 1000, 1, 5000) });
    res.json({ success: true, data: result });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * GET /api/reporting/records
 * The Detail Viewer: record-level evidence with the full filter set.
 *
 * This exists because it is what the operator actually trusts — the raw rows —
 * and every established product ships an equivalent (dmarcian calls it the
 * Detail Viewer). Making it a first-class screen inside reporting, rather than
 * a separate "raw data" area, is the point.
 */
router.get('/records', async (req: Request, res: Response) => {
  try {
    const timeframe = await timeframeFrom(req);
    const page = await getRecords(timeframe, scopeFrom(req), {
      limit: int(req.query.limit, 100, 1, 1000),
      offset: int(req.query.offset, 0, 0, 100000),
      complianceClass: oneOf(req.query.class, RECORD_CLASSES),
      disposition: str(req.query.disposition),
      reasonType: str(req.query.reason),
      spfAligned: bool(req.query.spfAligned),
      dkimAligned: bool(req.query.dkimAligned),
      search: str(req.query.search),
      sort: oneOf(req.query.sort, RECORD_SORTS),
      direction: direction(req.query.direction),
    });

    res.json({
      success: true,
      data: page.items,
      pagination: { total: page.total, limit: page.limit, offset: page.offset },
      meta: { timeframe: timeframePayload(timeframe) },
    });
  } catch (error) {
    fail(res, error);
  }
});

export default router;
