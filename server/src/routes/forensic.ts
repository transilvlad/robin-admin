/**
 * Forensic (AFRF - RFC 6591) report routes.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireIngestionAuth } from '../middleware/security.js';
import {
  listReports,
  getReportDetail,
  getChartData,
  getForensicStats,
  insertReport,
  listFeedbackTypes,
  listAuthFailureTypes,
  ForensicReportInput,
} from '../db/queries/forensic.js';
import { logger } from '../logger.js';
import { scheduleReportingAnalysis } from '../services/reporting-analysis-scheduler.js';
import { routeParam } from './params.js';

const router = Router();

/**
 * POST /api/forensic/reports - Receive forensic report from Robin bot.
 * This endpoint is called by the ForensicBot with ingestion authentication.
 */
router.post('/reports', requireIngestionAuth, async (req: Request, res: Response) => {
  try {
    const report = req.body as ForensicReportInput;

    if (!report.feedbackType) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: feedbackType',
      });
    }

    const id = await insertReport(report);
    logger.info(`Received forensic report: ${report.feedbackType} from ${report.reportedDomain || 'unknown'}`);

    const reportedDomain = report.reportedDomain || undefined;
    scheduleReportingAnalysis('forensic', reportedDomain);

    res.json({ success: true, data: { id } });
  } catch (error) {
    logger.error('Failed to insert forensic report', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to save report' });
  }
});

/**
 * GET /api/forensic/reports - List reports with pagination.
 */
router.get('/reports', requireAuth, async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
    const filters = {
      domain: req.query.domain as string,
      feedbackType: req.query.feedbackType as string,
      authFailure: req.query.authFailure as string,
      sourceIp: req.query.sourceIp as string,
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      sortBy: req.query.sortBy as 'date' | 'type' | 'domain' | 'sourceIp' | 'incidents' | undefined,
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
    logger.error('Failed to list forensic reports', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to load reports' });
  }
});

/**
 * GET /api/forensic/reports/:id - Get report detail.
 */
router.get('/reports/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(routeParam(req, 'id'), 10);
    const report = await getReportDetail(id);

    if (!report) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }

    res.json({
      success: true,
      data: report,
    });
  } catch (error) {
    logger.error('Failed to get forensic report detail', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to load report' });
  }
});

/**
 * GET /api/forensic/chart - Get chart data.
 */
router.get('/chart', requireAuth, async (req: Request, res: Response) => {
  try {
    const startDate = (req.query.startDate as string) || getDefaultStartDate();
    const endDate = (req.query.endDate as string) || new Date().toISOString().split('T')[0];
    const groupBy = (req.query.groupBy as 'date' | 'type' | 'domain') || 'date';

    const data = await getChartData(startDate, endDate, groupBy);

    res.json({ success: true, data });
  } catch (error) {
    logger.error('Failed to get forensic chart data', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to load chart data' });
  }
});

/**
 * GET /api/forensic/feedback-types - List unique feedback types.
 */
router.get('/feedback-types', requireAuth, async (_req: Request, res: Response) => {
  try {
    const types = await listFeedbackTypes();
    res.json({ success: true, data: types });
  } catch (error) {
    logger.error('Failed to list feedback types', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to load feedback types' });
  }
});

/**
 * GET /api/forensic/auth-failure-types - List unique auth failure types.
 */
router.get('/auth-failure-types', requireAuth, async (_req: Request, res: Response) => {
  try {
    const types = await listAuthFailureTypes();
    res.json({ success: true, data: types });
  } catch (error) {
    logger.error('Failed to list auth failure types', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to load auth failure types' });
  }
});

/**
 * GET /api/forensic/stats - Get stats for dashboard.
 */
router.get('/stats', requireAuth, async (_req: Request, res: Response) => {
  try {
    const stats = await getForensicStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Failed to get forensic stats', { error: (error as Error).message });
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
