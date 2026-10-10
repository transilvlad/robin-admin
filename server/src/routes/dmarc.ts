/**
 * DMARC report routes.
 * 
 * Handles DMARC aggregate report storage and retrieval.
 * Reports are received from Robin's DmarcBot via POST /reports.
 * 
 * Endpoints:
 * - POST /reports - Ingest report (bot auth required)
 * - GET /reports - List reports with pagination and filters
 * - GET /reports/:id - Get report detail with records
 * - GET /chart - Get chart data for visualization
 * - GET /reporters - List unique reporting organizations
 * - GET /stats - Get dashboard statistics
 * 
 * POST /reports is bot-facing and requires either a reports:ingest API key or
 * the shared ingestion secret when ingestion auth is enabled.
 * Report records are stored in dmarc_records and linked by report_id.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireIngestionAuth } from '../middleware/security.js';
import {
  listReports,
  getReportDetail,
  getChartData,
  listReporters,
  getDmarcStats,
  insertReport,
  DmarcReportInput,
} from '../db/queries/dmarc.js';
import { logger } from '../logger.js';
import { scheduleReportingAnalysis } from '../services/reporting-analysis-scheduler.js';
import { routeParam } from './params.js';

const router = Router();

/**
 * POST /api/dmarc/reports - Receive DMARC report from Robin bot.
 * This endpoint is called by the DmarcBot with ingestion authentication.
 */
router.post('/reports', requireIngestionAuth, async (req: Request, res: Response) => {
  try {
    const report = req.body as DmarcReportInput;

    if (!report.reportId || !report.domain) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: reportId, domain',
      });
    }

    const id = await insertReport(report);
    logger.info(`Received DMARC report: ${report.reportId} for domain ${report.domain}`);

    scheduleReportingAnalysis('dmarc', report.domain);

    res.json({ success: true, data: { id } });
  } catch (error) {
    logger.error('Failed to insert DMARC report', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to save report' });
  }
});

/**
 * GET /api/dmarc/reports - List reports with pagination.
 */
router.get('/reports', requireAuth, async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
    const filters = {
      domain: req.query.domain as string,
      reporterId: req.query.reporterId ? parseInt(req.query.reporterId as string, 10) : undefined,
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      sortBy: req.query.sortBy as 'date' | 'reporter' | 'domain' | 'total' | 'errors' | 'policy' | undefined,
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
    logger.error('Failed to list DMARC reports', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to load reports' });
  }
});

/**
 * GET /api/dmarc/reports/:id - Get report detail.
 */
router.get('/reports/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(routeParam(req, 'id'), 10);
    const { report, records, summary } = await getReportDetail(id);

    if (!report) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }

    res.json({
      success: true,
      data: {
        report,
        records,
        summary,
      },
    });
  } catch (error) {
    logger.error('Failed to get DMARC report detail', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to load report' });
  }
});

/**
 * GET /api/dmarc/chart - Get chart data.
 */
router.get('/chart', requireAuth, async (req: Request, res: Response) => {
  try {
    const startDate = (req.query.startDate as string) || getDefaultStartDate();
    const endDate = (req.query.endDate as string) || new Date().toISOString().split('T')[0];
    const domain = req.query.domain as string;

    const data = await getChartData(startDate, endDate, domain);

    res.json({ success: true, data });
  } catch (error) {
    logger.error('Failed to get DMARC chart data', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to load chart data' });
  }
});

/**
 * GET /api/dmarc/reporters - List reporters.
 */
router.get('/reporters', requireAuth, async (_req: Request, res: Response) => {
  try {
    const reporters = await listReporters();
    res.json({ success: true, data: reporters });
  } catch (error) {
    logger.error('Failed to list DMARC reporters', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to load reporters' });
  }
});

/**
 * GET /api/dmarc/stats - Get stats for dashboard.
 */
router.get('/stats', requireAuth, async (_req: Request, res: Response) => {
  try {
    const stats = await getDmarcStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Failed to get DMARC stats', { error: (error as Error).message });
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
