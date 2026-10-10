import { Router, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { AuditActions, logAudit } from '../middleware/audit.js';
import { ConnectionConflictError, getStoreConnection, parseConnectionUpdate, publicConnection, saveStoreConnection } from '../services/telemetry/connection.js';
import { checkTelemetryStore, TelemetryStoreUnavailableError } from '../services/telemetry/store-client.js';
import { createSnapshot, deleteSnapshot, listSnapshots, SnapshotUnavailableError } from '../services/telemetry/snapshots.js';

const router = Router();
router.use(requireAuth, requireAdmin);

router.get('/connection', async (_req, res) => {
  res.json({ success: true, data: publicConnection(await getStoreConnection()) });
});

for (const action of ['test', 'save'] as const) {
  router.post(`/connection/${action}`, async (req, res) => {
    try {
      const next = parseConnectionUpdate(req.body, await getStoreConnection());
      if (next.mode !== 'disabled') await checkTelemetryStore(next);
      if (action === 'test') { res.json({ success: true, data: { reachable: next.mode !== 'disabled' } }); return; }
      const saved = await saveStoreConnection(next);
      await logAudit(req, AuditActions.CONFIG_UPDATE, { entityType: 'telemetry-connection', newValues: {
        mode: saved.mode, auth: saved.auth, allowPrivate: saved.allowPrivate, secretConfigured: saved.secretConfigured,
      } });
      res.json({ success: true, data: saved });
    } catch (error) {
      const status = error instanceof ConnectionConflictError ? 409 : error instanceof TelemetryStoreUnavailableError ? 503 : 400;
      res.status(status).json({ success: false, error: error instanceof Error ? error.message : 'Connection operation failed' });
    }
  });
}

router.get('/storage/snapshots', async (_req, res) => {
  try { res.json({ success: true, data: await listSnapshots() }); }
  catch (error) { snapshotError(res, error); }
});

router.post('/storage/snapshots', async (req, res) => {
  try {
    const snapshot = await createSnapshot();
    await logAudit(req, AuditActions.CONFIG_UPDATE, { entityType: 'telemetry-snapshot', entityId: snapshot.name, newValues: { action: 'create' } });
    res.status(201).json({ success: true, data: snapshot });
  } catch (error) { snapshotError(res, error); }
});

router.delete('/storage/snapshots/:name', async (req, res) => {
  const name = String(req.params.name);
  try {
    await deleteSnapshot(name);
    await logAudit(req, AuditActions.CONFIG_UPDATE, { entityType: 'telemetry-snapshot', entityId: name, newValues: { action: 'delete' } });
    res.json({ success: true });
  } catch (error) { snapshotError(res, error); }
});

function snapshotError(res: Response, error: unknown) {
  if (error instanceof RangeError) { res.status(400).json({ success: false, error: error.message }); return; }
  res.status(error instanceof SnapshotUnavailableError ? 409 : 500).json({ success: false, error: error instanceof SnapshotUnavailableError ? error.message : 'Snapshot operation failed' });
}

export default router;
