import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { AuditActions, logAudit } from '../middleware/audit.js';
import {
  analyzeMariadbTable,
  getMariadbConfigState,
  getMariadbProcesslist,
  getMariadbSchemas,
  getMariadbStatements,
  getMariadbStatus,
  getMariadbTables,
  getMariadbTransactions,
  killMariadbConnection,
  listMariadbConfigScopes,
  reapplyMariadbConfig,
  renderMariadbConfig,
  resetMariadbConfig,
  resetMariadbStats,
  saveMariadbManagedConfig,
} from '../services/mariadb.js';

const router = Router();

router.use(requireAuth);
router.use(requireAdmin);

function getServiceId(req: Request): string | undefined {
  const value = typeof req.query.serviceId === 'string' ? req.query.serviceId : req.body?.serviceId;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function getLimit(req: Request): number | undefined {
  const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined;
  return Number.isInteger(limit) && (limit as number) > 0 ? limit : undefined;
}

type Audit = { entityType: 'mariadb_config' | 'mariadb_runtime'; newValues: Record<string, unknown> };

/**
 * One handler shape for every endpoint: a serviceId is required, failures are
 * a 400 with the message, and a mutation is audited after it succeeds.
 */
function handle<T>(
  failure: string,
  run: (serviceId: string, req: Request) => Promise<T>,
  audit?: (req: Request, result: T) => Audit
) {
  return async (req: Request, res: Response) => {
    try {
      const serviceId = getServiceId(req);
      if (!serviceId) {
        return res.status(400).json({ success: false, error: 'serviceId is required' });
      }
      const result = await run(serviceId, req);
      if (audit) {
        const { entityType, newValues } = audit(req, result);
        await logAudit(req, AuditActions.CONFIG_UPDATE, { entityType, entityId: serviceId, newValues });
      }
      res.json({ success: true, data: result });
    } catch (error) {
      res.status(400).json({ success: false, error: error instanceof Error ? error.message : failure });
    }
  };
}

router.get('/config', handle('Failed to load MariaDB config', (serviceId) => getMariadbConfigState(serviceId)));

router.put('/config', handle(
  'Failed to save MariaDB config',
  (serviceId, req) => {
    const { serviceId: _ignored, ...values } = req.body ?? {};
    return saveMariadbManagedConfig(serviceId, values);
  },
  (req) => ({ entityType: 'mariadb_config', newValues: req.body ?? {} })
));

router.get('/config/scopes', async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listMariadbConfigScopes() });
  } catch (error) {
    res.status(400).json({ success: false, error: error instanceof Error ? error.message : 'Failed to list MariaDB config scopes' });
  }
});

router.delete('/config', handle(
  'Failed to reset MariaDB config',
  (serviceId) => resetMariadbConfig(serviceId),
  () => ({ entityType: 'mariadb_config', newValues: { action: 'reset-to-base' } })
));

router.get('/config/rendered', handle('Failed to render MariaDB config', async (serviceId) => ({
  managed: renderMariadbConfig((await getMariadbConfigState(serviceId)).managed),
})));

router.get('/status', handle('Failed to load MariaDB status', (serviceId) => getMariadbStatus(serviceId)));

// MariaDB has no config reload; this re-applies the managed variables.
router.post('/reload', handle(
  'Failed to apply MariaDB config',
  async (serviceId) => ({ response: await reapplyMariadbConfig(serviceId) }),
  (_req, result) => ({ entityType: 'mariadb_runtime', newValues: { action: 'reapply', response: result.response } })
));

router.get('/processes', handle('Failed to load MariaDB processes', (serviceId, req) => getMariadbProcesslist(serviceId, getLimit(req))));

router.post('/processes/kill', handle(
  'Failed to kill MariaDB connection',
  async (serviceId, req) => {
    const scope = req.body?.scope === 'connection' ? 'connection' : 'query';
    await killMariadbConnection(serviceId, req.body?.id, scope);
    return { killed: true, scope };
  },
  (req, result) => ({ entityType: 'mariadb_runtime', newValues: { action: `kill_${result.scope}`, id: req.body?.id } })
));

router.get('/transactions', handle('Failed to load MariaDB transactions', (serviceId) => getMariadbTransactions(serviceId)));

router.get('/schemas', handle('Failed to load MariaDB schemas', (serviceId, req) => getMariadbSchemas(serviceId, getLimit(req))));

router.get('/tables', handle('Failed to load MariaDB tables', (serviceId, req) => getMariadbTables(serviceId, {
  schema: typeof req.query.schema === 'string' && req.query.schema ? req.query.schema : undefined,
  limit: getLimit(req),
})));

router.post('/analyze', handle(
  'Failed to analyze MariaDB table',
  async (serviceId, req) => ({ response: await analyzeMariadbTable(serviceId, req.body?.table) }),
  (req, result) => ({ entityType: 'mariadb_runtime', newValues: { action: 'analyze', table: req.body?.table, response: result.response } })
));

router.get('/statements', handle('Failed to load MariaDB statements', (serviceId, req) => getMariadbStatements(serviceId, getLimit(req))));

router.post('/stats/reset', handle(
  'Failed to reset MariaDB status counters',
  async (serviceId) => ({ response: await resetMariadbStats(serviceId) }),
  (_req, result) => ({ entityType: 'mariadb_runtime', newValues: { action: 'stats_reset', response: result.response } })
));

export default router;
