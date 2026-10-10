/**
 * Robin configuration API routes.
 * Provides CRUD operations for Robin's configuration stored in the database.
 * 
 * This module manages Robin MTA's JSON5 configuration files via database
 * storage, supporting multi-server deployments with config overrides.
 * 
 * Endpoints:
 * - GET /files - List available config files
 * - GET /servers - List server IDs with configs
 * - GET /servers/:serverId/files/:fileName - Get config (merged or raw)
 * - PUT /servers/:serverId/files/:fileName - Update config
 * - DELETE /servers/:serverId/files/:fileName - Delete config override
 * - GET /diff/:fileName - Compare default vs override configs
 * 
 * Config Resolution:
 * 1. 'default' server provides base configuration
 * 2. Server-specific configs override default values
 * 3. Use ?merged=true to get final merged config
 * 
 * SHA256 hashes are computed for change detection.
 * Deleting 'default' config falls back to an empty object.
 * Config is stored as JSON in the configured Robin config-store table.
 * JSON5 parsing happens in the UI, not here.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { query } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { logAudit, AuditActions } from '../middleware/audit.js';
import { logger } from '../logger.js';
import { getRobinConfigTableSqlIdentifier } from '../db/queries/robin-config-meta.js';
import {
  deleteRobinClamavServiceLink,
  getEffectiveRobinClamavServiceLink,
  upsertRobinClamavServiceLink,
} from '../db/queries/robin-clamav-links.js';
import { getFleetServiceById } from '../db/queries/fleet-services.js';
import { reloadRobinConfig, robinApiFailure } from '../services/robin-api.js';
import { routeParam } from './params.js';

const router = Router();

interface ConfigRow {
  server_id: string;
  file_name: string;
  payload_json: object;
  updated_epoch: number;
  sha256: string;
}

/**
 * Compute SHA256 hash of canonical JSON.
 */
function computeSha256(obj: object): string {
  const canonical = JSON.stringify(obj);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Get all unique server IDs.
 * GET /api/robin-config/server-ids
 */
router.get('/server-ids', requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await query<{ server_id: string }>(`
      SELECT DISTINCT server_id FROM ${await getRobinConfigTableSqlIdentifier()} ORDER BY server_id
    `);
    res.json({
      success: true,
      data: result.rows.map(r => r.server_id),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Force Robin to re-pull config from its configured shared store and hot-reload it.
 * This is Robin's "sync": robin-admin writes the DB, Robin pulls it. Applied/
 * skipped counts land in Robin's own logs (Robin Logs page).
 * POST /api/robin-config/reload  { serverId?: string }
 */
router.post('/reload', requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const serverId = typeof req.body?.serverId === 'string' && req.body.serverId.trim()
      ? req.body.serverId.trim()
      : undefined;
    const result = await reloadRobinConfig(serverId);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'robin-config-reload',
      entityId: serverId ?? 'default',
      newValues: { ok: result.ok, status: result.status },
    });
    if (!result.ok) {
      const body = result.body as { error?: unknown; message?: unknown } | null;
      const reason = body?.error || body?.message;
      return res.status(502).json({
        success: false,
        error: `Robin reload failed (HTTP ${result.status})${reason ? `: ${String(reason).slice(0, 300)}` : ''}`,
      });
    }
    logger.info('Robin config reload triggered', { serverId: serverId ?? 'default' });
    res.json({ success: true, data: result.body });
  } catch (error) {
    const failure = robinApiFailure(error, 'Robin MTA API is unavailable. Configuration was saved but could not be reloaded.');
    if (failure) {
      res.status(failure.status).json({ success: false, error: failure.error });
      return;
    }
    next(error);
  }
});

/**
 * Get grouped configuration files.
 * GET /api/robin-config/files
 * Returns list of unique file names with their server IDs.
 */
router.get('/files', requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await query<{ file_name: string; server_ids: string[]; updated_at: string }>(`
      SELECT 
        file_name,
        array_agg(server_id ORDER BY server_id) as server_ids,
        MAX(to_timestamp(updated_epoch)) as updated_at
      FROM ${await getRobinConfigTableSqlIdentifier()}
      GROUP BY file_name
      ORDER BY file_name
    `);
    res.json({
      success: true,
      data: result.rows.map(r => ({
        fileName: r.file_name,
        serverIds: r.server_ids,
        updatedAt: r.updated_at,
      })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Get all configuration entries.
 * GET /api/robin-config
 */
router.get('/', requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await query<ConfigRow>(`
      SELECT server_id, file_name, payload_json, updated_epoch, sha256
      FROM ${await getRobinConfigTableSqlIdentifier()}
      ORDER BY server_id, file_name
    `);

    res.json({
      success: true,
      data: result.rows.map((row: ConfigRow) => ({
        serverId: row.server_id,
        fileName: row.file_name,
        config: row.payload_json,
        updatedAt: new Date(row.updated_epoch * 1000).toISOString(),
        sha256: row.sha256,
      })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Get a specific configuration file with optional base merge.
 * GET /api/robin-config/file/:fileName
 * Query params: serverId (optional, defaults to 'default')
 */
router.get('/file/:fileName', requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const fileName = routeParam(req, 'fileName');
    const serverId = (req.query.serverId as string) || 'default';
    const tableName = await getRobinConfigTableSqlIdentifier();

    // Get base config
    const baseResult = await query<ConfigRow>(`
      SELECT server_id, file_name, payload_json, updated_epoch, sha256
      FROM ${tableName}
      WHERE server_id = 'default' AND file_name = $1
    `, [fileName]);

    // Get override config if serverId is not 'default'
    let overrideResult = null;
    if (serverId !== 'default') {
      overrideResult = await query<ConfigRow>(`
        SELECT server_id, file_name, payload_json, updated_epoch, sha256
        FROM ${tableName}
        WHERE server_id = $1 AND file_name = $2
      `, [serverId, fileName]);
    }

    if (baseResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Configuration not found',
      });
    }

    const base = baseResult.rows[0];
    const override = overrideResult?.rows[0] || null;

    res.json({
      success: true,
      data: {
        fileName: base.file_name,
        base: {
          config: base.payload_json,
          updatedAt: new Date(base.updated_epoch * 1000).toISOString(),
          sha256: base.sha256,
        },
        override: override ? {
          serverId: override.server_id,
          config: override.payload_json,
          updatedAt: new Date(override.updated_epoch * 1000).toISOString(),
          sha256: override.sha256,
        } : null,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/clamav-link/:serverId', requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const serverId = routeParam(req, 'serverId');
    const result = await getEffectiveRobinClamavServiceLink(serverId);

    res.json({
      success: true,
      data: {
        serverId,
        serviceId: result.link?.clamavServiceId ?? null,
        sourceServerId: result.link?.serverId ?? null,
        inherited: result.inherited,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.put('/clamav-link/:serverId', requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const serverId = routeParam(req, 'serverId');
    const rawServiceId = typeof req.body?.serviceId === 'string' ? req.body.serviceId.trim() : '';

    if (!rawServiceId) {
      await deleteRobinClamavServiceLink(serverId);
      await logAudit(req, AuditActions.CONFIG_UPDATE, {
        entityType: 'robin_clamav_link',
        entityId: serverId,
        newValues: { serviceId: null },
      });
      return res.json({
        success: true,
        data: {
          serverId,
          serviceId: null,
          sourceServerId: null,
          inherited: false,
        },
      });
    }

    const service = await getFleetServiceById(rawServiceId);
    if (!service || service.serviceType !== 'clamav') {
      return res.status(400).json({
        success: false,
        error: 'Linked service must be an existing ClamAV fleet service',
      });
    }

    const link = await upsertRobinClamavServiceLink(serverId, rawServiceId);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'robin_clamav_link',
      entityId: serverId,
      newValues: { serviceId: rawServiceId },
    });

    res.json({
      success: true,
      data: {
        serverId,
        serviceId: link.clamavServiceId,
        sourceServerId: link.serverId,
        inherited: false,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Get a specific configuration file by serverId and fileName.
 * GET /api/robin-config/:serverId/:fileName
 */
router.get('/:serverId/:fileName', requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const serverId = routeParam(req, 'serverId');
    const fileName = routeParam(req, 'fileName');

    const result = await query<ConfigRow>(`
      SELECT server_id, file_name, payload_json, updated_epoch, sha256
      FROM ${await getRobinConfigTableSqlIdentifier()}
      WHERE server_id = $1 AND file_name = $2
    `, [serverId, fileName]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Configuration not found',
      });
    }

    const row = result.rows[0];
    res.json({
      success: true,
      data: {
        serverId: row.server_id,
        fileName: row.file_name,
        config: row.payload_json,
        updatedAt: new Date(row.updated_epoch * 1000).toISOString(),
        sha256: row.sha256,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Update or create a configuration file.
 * PUT /api/robin-config/:serverId/:fileName
 */
router.put('/:serverId/:fileName', requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const serverId = routeParam(req, 'serverId');
    const fileName = routeParam(req, 'fileName');
    const { config } = req.body;

    if (!config || typeof config !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Config must be a valid object',
      });
    }

    // Validate fileName pattern
    if (!/^[a-zA-Z0-9._-]+\.json5$/.test(fileName)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid file name',
      });
    }

    // Exclude config.json5 (bootstrap config)
    if (fileName === 'config.json5') {
      return res.status(400).json({
        success: false,
        error: 'Cannot modify bootstrap config',
      });
    }

    const sha256 = computeSha256(config);
    const updatedEpoch = Math.floor(Date.now() / 1000);

    await query(`
      INSERT INTO ${await getRobinConfigTableSqlIdentifier()} (server_id, file_name, payload_json, updated_epoch, sha256)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (server_id, file_name) DO UPDATE SET
        payload_json = $3,
        updated_epoch = $4,
        sha256 = $5
    `, [serverId, fileName, JSON.stringify(config), updatedEpoch, sha256]);

    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'robin-config',
      entityId: `${serverId}/${fileName}`,
      newValues: { serverId, fileName },
    });

    logger.info('Robin config updated', { serverId, fileName, sha256 });

    res.json({
      success: true,
      data: {
        serverId,
        fileName,
        config,
        updatedAt: new Date(updatedEpoch * 1000).toISOString(),
        sha256,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Delete a server-specific override.
 * DELETE /api/robin-config/:serverId/:fileName
 */
router.delete('/:serverId/:fileName', requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const serverId = routeParam(req, 'serverId');
    const fileName = routeParam(req, 'fileName');

    // Don't allow deleting 'default' configs
    if (serverId === 'default') {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete base configuration. Use PUT to update instead.',
      });
    }

    const result = await query(`
      DELETE FROM ${await getRobinConfigTableSqlIdentifier()}
      WHERE server_id = $1 AND file_name = $2
      RETURNING server_id
    `, [serverId, fileName]);

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'Configuration not found',
      });
    }

    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'robin-config',
      entityId: `${serverId}/${fileName}`,
      newValues: { action: 'delete', serverId, fileName },
    });

    logger.info('Robin config override deleted', { serverId, fileName });

    res.json({
      success: true,
      message: 'Configuration deleted',
    });
  } catch (error) {
    next(error);
  }
});

export default router;
