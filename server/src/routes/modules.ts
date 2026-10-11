import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin, requireViewer } from '../middleware/rbac.js';
import {
  dispatchModuleInstallerAction,
  getModuleInstallerJob,
  getModuleInstallerStatus,
  ModuleInstallerError,
  type ModuleInstallerAction,
} from '../services/module-installer.js';
import {
  activateModuleLicense,
  finalizeModuleInstallerAction,
  getModuleForUi,
  ModuleAccessError,
  listModulesForUi,
  syncModuleCatalogFromSherif,
  getModuleRegistryCredentials,
  recordModulePurchaseClick,
  refreshModuleLicenseIfNeeded,
} from '../services/modules.js';
import { logger } from '../logger.js';
import { getConfig } from '../db/queries/config.js';
import { routeParam } from './params.js';

const router = Router();

function logError(message: string, error: unknown, moduleSlug?: string) {
  logger.error(message, {
    moduleSlug,
    error: (error as Error).message,
  });
}

const JOB_POLL_INTERVAL_MS = 3_000;
const JOB_POLL_TIMEOUT_MS = 10 * 60_000;

// Job completion is normally recorded when the client polls GET
// /:slug/jobs/:jobId and observes a terminal status (see below). That alone
// is unreliable: if the browser stops polling before the job finishes
// (navigation away, closed tab, dropped connection), the container swap
// still completes on the installer but modules_installed.installed_version
// never gets updated. Track the job to completion server-side too, so the
// record is finalized regardless of whether anyone is still watching it.
function trackInstallerJobToCompletion(jobId: string, moduleSlug: string): void {
  const deadline = Date.now() + JOB_POLL_TIMEOUT_MS;
  const poll = async () => {
    let result;
    try {
      result = await getModuleInstallerJob(jobId);
    } catch (error) {
      if (Date.now() < deadline) {
        setTimeout(() => void poll(), JOB_POLL_INTERVAL_MS);
      } else {
        logError('Gave up tracking installer job to completion', error, moduleSlug);
      }
      return;
    }
    if (!result || typeof result.status !== 'string') {
      if (Date.now() < deadline) {
        setTimeout(() => void poll(), JOB_POLL_INTERVAL_MS);
      }
      return;
    }
    if (result.status === 'succeeded') {
      try {
        await finalizeModuleInstallerAction(result.action, moduleSlug, result.version, result.data);
      } catch (error) {
        logError('Failed to record module installer job result', error, moduleSlug);
      }
      return;
    }
    if (result.status === 'failed') {
      return;
    }
    if (Date.now() < deadline) {
      setTimeout(() => void poll(), JOB_POLL_INTERVAL_MS);
    } else {
      logError('Timed out tracking installer job to completion', new Error(`Job ${jobId} stuck in status ${result.status}`), moduleSlug);
    }
  };
  void poll();
}

router.use(requireAuth);
router.use(requireViewer);
router.use(async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (!(await getConfig()).modulesEnabled) {
      return res.status(403).json({
        success: false,
        error: 'Modules are disabled. Enable Modules under Administration -> Integrations before managing modules.',
      });
    }
    next();
  } catch (error) {
    logError('Failed to verify module capability state', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify module capability state',
    });
  }
});

router.get('/', async (_req: Request, res: Response) => {
  try {
    const modules = await listModulesForUi();
    res.json({
      success: true,
      data: modules,
    });
  } catch (error) {
    logError('Failed to list modules', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list modules',
    });
  }
});

router.post('/sync', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await syncModuleCatalogFromSherif('manual');
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logError('Failed to sync modules', error);
    res.status(502).json({
      success: false,
      error: (error as Error).message || 'Failed to sync modules',
    });
  }
});

router.post('/:slug/activate', requireAdmin, async (req: Request, res: Response) => {
  const moduleSlug = String(routeParam(req, 'slug') || '').trim();
  const licenseKey = typeof req.body?.licenseKey === 'string' ? req.body.licenseKey.trim() : '';

  if (!moduleSlug) {
    return res.status(400).json({
      success: false,
      error: 'Module slug is required',
    });
  }

  if (!licenseKey) {
    return res.status(400).json({
      success: false,
      error: 'licenseKey is required',
    });
  }

  try {
    const moduleState = await activateModuleLicense(moduleSlug, licenseKey);
    res.json({
      success: true,
      data: moduleState,
    });
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes('Unknown module') || message.includes('not installed')) {
      return res.status(400).json({
        success: false,
        error: message,
      });
    }

    logError('Failed to activate module license', error, moduleSlug);
    res.status(502).json({
      success: false,
      error: message || 'Failed to activate module license',
    });
  }
});

router.post('/:slug/refresh-license', requireAdmin, async (req: Request, res: Response) => {
  const slug = String(routeParam(req, 'slug') || '').trim();
  try {
    await refreshModuleLicenseIfNeeded(slug, true);
    const moduleState = await getModuleForUi(slug);
    if (!moduleState) return res.status(404).json({ success: false, error: 'Module not found' });
    res.json({ success: true, data: moduleState });
  } catch (error) {
    logError('Failed to refresh module license', error, slug);
    res.status(502).json({ success: false, error: 'Failed to refresh module license' });
  }
});

async function handleInstallerAction(action: ModuleInstallerAction, req: Request, res: Response) {
  const moduleSlug = String(routeParam(req, 'slug') || '').trim();
  if (!moduleSlug) {
    return res.status(400).json({
      success: false,
      error: 'Module slug is required',
    });
  }

  try {
    const allowedBodyKeys = new Set(['version', 'maintenanceAcknowledged']);
    const unsupportedKey = Object.keys(req.body ?? {}).find((key) => !allowedBodyKeys.has(key));
    if (unsupportedKey) {
      return res.status(400).json({
        success: false,
        error: `Unsupported installer field "${unsupportedKey}"`,
      });
    }
    if (req.body?.maintenanceAcknowledged !== undefined && typeof req.body.maintenanceAcknowledged !== 'boolean') {
      return res.status(400).json({ success: false, error: 'maintenanceAcknowledged must be a boolean.' });
    }
    const moduleState = await getModuleForUi(moduleSlug);
    if (!moduleState || (!moduleState.installed && !moduleState.remoteScope)) {
      return res.status(404).json({
        success: false,
        error: 'Module not found',
      });
    }
    if (!moduleState.installerActions.includes(action)
      || (moduleState.installed && moduleState.installedSource !== 'installer')
      || (action === 'install' ? moduleState.installed : !moduleState.installed)) {
      return res.status(409).json({ success: false, error: 'This action is not available for this module ownership or installer policy.' });
    }
    const requestedVersion = typeof req.body?.version === 'string' ? req.body.version.trim() : '';
    if (action === 'upgrade' && moduleState.installerUpgradeStrategy === 'maintenance'
      && req.body?.maintenanceAcknowledged !== true) {
      return res.status(400).json({ success: false, error: 'Maintenance upgrades require explicit downtime acknowledgement.' });
    }
    const version = requestedVersion || moduleState.latestVersion || moduleState.installedVersion;
    if (!version) {
      return res.status(400).json({
        success: false,
        error: 'Module version is required',
      });
    }

    const result = await dispatchModuleInstallerAction(
      action,
      moduleSlug,
      version,
      action === 'install' || action === 'upgrade'
        ? await getModuleRegistryCredentials(moduleState, version)
        : [],
      req.body?.maintenanceAcknowledged === true,
    );
    trackInstallerJobToCompletion(result.jobId, moduleSlug);
    res.status(202).json({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error instanceof ModuleAccessError) {
      return res.status(error.status).json({
        success: false,
        error: error.message,
      });
    }
    if (error instanceof ModuleInstallerError) {
      return res.status(error.status).json({
        success: false,
        error: error.message,
      });
    }

    logError('Failed to dispatch module installer action', error, moduleSlug);
    res.status(502).json({
      success: false,
      error: (error as Error).message || 'Failed to dispatch module installer action',
    });
  }
}

for (const action of ['install', 'upgrade', 'start', 'stop', 'uninstall'] as const) {
  router.post(`/:slug/${action}`, requireAdmin, (req: Request, res: Response) => {
    void handleInstallerAction(action, req, res);
  });
}

router.post('/:slug/purchase-click', async (req: Request, res: Response) => {
  const moduleSlug = String(routeParam(req, 'slug') || '').trim();
  if (!moduleSlug) {
    return res.status(400).json({ success: false, error: 'Module slug is required' });
  }
  await recordModulePurchaseClick(moduleSlug);
  res.status(202).json({ success: true });
});

router.get('/:slug/status', async (req: Request, res: Response) => {
  const moduleSlug = String(routeParam(req, 'slug') || '').trim();
  try {
    const result = await getModuleInstallerStatus(moduleSlug);
    res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof ModuleInstallerError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    logError('Failed to get module installer status', error, moduleSlug);
    res.status(502).json({ success: false, error: 'Failed to get module installer status' });
  }
});

router.get('/:slug/jobs/:jobId', async (req: Request, res: Response) => {
  const moduleSlug = String(routeParam(req, 'slug') || '').trim();
  try {
    const result = await getModuleInstallerJob(String(routeParam(req, 'jobId') || ''));
    if (result.moduleSlug !== moduleSlug) {
      return res.status(404).json({ success: false, error: 'Installer job not found' });
    }
    if (result.status === 'succeeded') {
      try {
        await finalizeModuleInstallerAction(result.action, moduleSlug, result.version, result.data);
      } catch (error) {
        logError('Failed to record module installer job result', error, moduleSlug);
      }
    }
    res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof ModuleInstallerError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    logError('Failed to poll module installer job', error, moduleSlug);
    res.status(502).json({ success: false, error: 'Failed to poll module installer job' });
  }
});

router.get('/:slug', async (req: Request, res: Response) => {
  const moduleSlug = String(routeParam(req, 'slug') || '').trim();
  if (!moduleSlug) {
    return res.status(400).json({
      success: false,
      error: 'Module slug is required',
    });
  }

  try {
    const moduleState = await getModuleForUi(moduleSlug);
    if (!moduleState) {
      return res.status(404).json({
        success: false,
        error: 'Module not found',
      });
    }

    res.json({
      success: true,
      data: moduleState,
    });
  } catch (error) {
    logError('Failed to get module', error, moduleSlug);
    res.status(500).json({
      success: false,
      error: 'Failed to get module',
    });
  }
});

export default router;
