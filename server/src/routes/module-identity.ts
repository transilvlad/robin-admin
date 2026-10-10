import { Router, type NextFunction, type Request, type Response } from 'express';
import { getTrustedClientIp } from '../middleware/security.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { logger } from '../logger.js';
import {
  acknowledgeModuleIdentityTrust,
  activateModuleIdentityRotation,
  cancelModuleIdentityRotation,
  getModuleIdentityRotationStatus,
  ModuleIdentityRotationError,
  prepareModuleIdentityRetirement,
  prepareModuleIdentityRotation,
  retireModuleIdentityKey,
  rollbackModuleIdentityRotation,
  type ModuleIdentityActor,
} from '../services/module-identity.js';

const router = Router();

router.use(requireAuth);
router.use(requireAdmin);

function requireBrowserAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.apiKey || req.session?.admin?.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Module identity rotation requires an administrator browser session.' });
    return;
  }
  next();
}

router.use(requireBrowserAdmin);

function actorFor(req: Request, ipAddress: string): ModuleIdentityActor {
  const adminId = req.session?.admin?.id;
  if (!adminId) throw new ModuleIdentityRotationError('Administrator session is unavailable.', 401);
  return { adminId, ipAddress };
}

function bodyHasOnly(req: Request, allowed: readonly string[]): boolean {
  return Object.keys(req.body ?? {}).every((key) => allowed.includes(key));
}

async function runMutation(
  req: Request,
  res: Response,
  action: (actor: ModuleIdentityActor) => Promise<void>,
): Promise<void> {
  try {
    const actor = actorFor(req, await getTrustedClientIp(req));
    await action(actor);
    res.json({ success: true, data: await getModuleIdentityRotationStatus() });
  } catch (error) {
    if (error instanceof ModuleIdentityRotationError) {
      res.status(error.status).json({ success: false, error: error.message });
      return;
    }
    logger.error('Module identity rotation operation failed', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Module identity rotation operation failed.' });
  }
}

router.get('/', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: await getModuleIdentityRotationStatus() });
  } catch (error) {
    logger.error('Failed to read module identity rotation state', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to read module identity rotation state.' });
  }
});

router.post('/prepare', async (req, res) => {
  if (!bodyHasOnly(req, [])) {
    res.status(400).json({ success: false, error: 'Unsupported module identity rotation fields.' });
    return;
  }
  await runMutation(req, res, prepareModuleIdentityRotation);
});

router.post('/acknowledgements', async (req, res) => {
  if (!bodyHasOnly(req, ['phase', 'moduleSlug', 'evidence'])
      || !['activation', 'retirement'].includes(req.body?.phase)
      || typeof req.body?.moduleSlug !== 'string'
      || typeof req.body?.evidence !== 'string') {
    res.status(400).json({ success: false, error: 'phase, moduleSlug, and evidence are required.' });
    return;
  }
  await runMutation(req, res, (actor) =>
    acknowledgeModuleIdentityTrust(actor, req.body.phase, req.body.moduleSlug, req.body.evidence));
});

router.post('/activate', async (req, res) => {
  if (!bodyHasOnly(req, [])) {
    res.status(400).json({ success: false, error: 'Unsupported module identity rotation fields.' });
    return;
  }
  await runMutation(req, res, activateModuleIdentityRotation);
});

router.post('/cancel', async (req, res) => {
  if (!bodyHasOnly(req, [])) {
    res.status(400).json({ success: false, error: 'Unsupported module identity rotation fields.' });
    return;
  }
  await runMutation(req, res, cancelModuleIdentityRotation);
});

router.post('/retirement/prepare', async (req, res) => {
  if (!bodyHasOnly(req, [])) {
    res.status(400).json({ success: false, error: 'Unsupported module identity rotation fields.' });
    return;
  }
  await runMutation(req, res, prepareModuleIdentityRetirement);
});

router.post('/retire', async (req, res) => {
  if (!bodyHasOnly(req, [])) {
    res.status(400).json({ success: false, error: 'Unsupported module identity rotation fields.' });
    return;
  }
  await runMutation(req, res, retireModuleIdentityKey);
});

router.post('/rollback', async (req, res) => {
  if (!bodyHasOnly(req, ['acknowledge']) || req.body?.acknowledge !== true) {
    res.status(400).json({ success: false, error: 'Explicit rollback acknowledgement is required.' });
    return;
  }
  await runMutation(req, res, rollbackModuleIdentityRotation);
});

export default router;
