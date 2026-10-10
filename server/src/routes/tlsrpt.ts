/**
 * TLSRPT (TLS Reporting - RFC 8460) routes.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireIngestionAuth } from '../middleware/security.js';
import {
  listReports,
  getReportDetail,
  getChartData,
  getTlsrptStats,
  insertReport,
  listDomains,
  TlsrptReportInput,
} from '../db/queries/tlsrpt.js';
import { logger } from '../logger.js';
import { scheduleReportingAnalysis } from '../services/reporting-analysis-scheduler.js';
import { routeParam } from './params.js';

const router = Router();

/**
 * POST /api/tlsrpt/reports - Receive TLSRPT report from Robin bot.
 * This endpoint is called by the TlsrptBot with ingestion authentication.
 */
router.post('/reports', requireIngestionAuth, async (req: Request, res: Response) => {
  try {
    const report = req.body as TlsrptReportInput;

    if (!report.reportId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: reportId',
      });
    }

    const id = await insertReport(report);
    logger.info(`Received TLSRPT report: ${report.reportId} from ${report.organizationName || 'unknown'}`);

    const policyDomain = report.policies?.[0]?.policyDomain;
    scheduleReportingAnalysis('tlsrpt', policyDomain);

    res.json({ success: true, data: { id } });
  } catch (error) {
    logger.error('Failed to insert TLSRPT report', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to save report' });
  }
});

/**
 * GET /api/tlsrpt/reports - List reports with pagination.
 */
router.get('/reports', requireAuth, async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
    const filters = {
      domain: req.query.domain as string,
      organization: req.query.organization as string,
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      sortBy: req.query.sortBy as 'date' | 'organization' | 'success' | 'failure' | 'report' | undefined,
      sortOrder: req.query.sortOrder as 'asc' | 'desc' | undefined,
    };

    const { reports, total } = await listReports(page, limit, filters);

    res.json({
      success: true,
      data: reports,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('Failed to list TLSRPT reports', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to load reports' });
  }
});

/**
 * GET /api/tlsrpt/reports/:id - Get report detail.
 */
router.get('/reports/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(routeParam(req, 'id'), 10);
    const { report, policies } = await getReportDetail(id);

    if (!report) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }

    res.json({
      success: true,
      data: {
        report,
        policies,
      },
    });
  } catch (error) {
    logger.error('Failed to get TLSRPT report detail', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to load report' });
  }
});

/**
 * GET /api/tlsrpt/chart - Get chart data.
 */
router.get('/chart', requireAuth, async (req: Request, res: Response) => {
  try {
    const startDate = (req.query.startDate as string) || getDefaultStartDate();
    const endDate = (req.query.endDate as string) || new Date().toISOString().split('T')[0];
    const domain = req.query.domain as string;

    const data = await getChartData(startDate, endDate, domain);

    res.json({ success: true, data });
  } catch (error) {
    logger.error('Failed to get TLSRPT chart data', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to load chart data' });
  }
});

/**
 * GET /api/tlsrpt/domains - List unique domains.
 */
router.get('/domains', requireAuth, async (_req: Request, res: Response) => {
  try {
    const domains = await listDomains();
    res.json({ success: true, data: domains });
  } catch (error) {
    logger.error('Failed to list TLSRPT domains', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to load domains' });
  }
});

/**
 * GET /api/tlsrpt/stats - Get stats for dashboard.
 */
router.get('/stats', requireAuth, async (_req: Request, res: Response) => {
  try {
    const stats = await getTlsrptStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Failed to get TLSRPT stats', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to load stats' });
  }
});

/**
 * Get default start date (30 days ago).
 */
function getDefaultStartDate(): string {
  const date = new Date();
  date.setDate(date.getDate() - 30);
  return date.toISOString().split('T')[0];
}

export default router;
