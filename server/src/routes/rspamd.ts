import express, { Router, type NextFunction, type Request, type Response } from 'express';
import {
  createDkimDomain,
  getTrainingImport,
  getTrainingSample,
  listDkimDomains,
  listDkimSelectors,
  updateDkimDomain,
  toPublicRspamdSettings,
} from '../db/queries/rspamd.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { AuditActions, logAudit } from '../middleware/audit.js';
import {
  getRspamdClassifierSummary,
  getRspamdScanHistoryDetail,
  createOrRotateDkimKey,
  deleteTrainingSampleAndFile,
  fuzzyRspamdScan,
  getRspamdConfigState,
  getRspamdStatus,
  listRspamdScanHistory,
  learnRspamdScan,
  getTrainingCorpus,
  importDkimKey,
  listRspamdConfigScopes,
  resetRspamdManagedFile,
  importTrainingBinary,
  replayRspamdScan,
  relabelAndRelearnTrainingSample,
  relearnTrainingSample,
  reloadRspamd,
  RspamdNotConfiguredError,
  revokeDkimSelector,
  runRspamdScan,
  runRspamdScanFile,
  saveRspamdClassifierSettings,
  saveRspamdManagedConfig,
  saveRspamdManagedFile,
  saveRspamdSettings,
} from '../services/rspamd.js';
import {
  getRspamdRulesState,
  previewRspamdRules,
  saveRspamdRules,
  type RspamdRulesFileManagement,
} from '../services/rspamd-rules.js';
import { routeParam } from './params.js';

const router = Router();

router.use(requireAuth);
router.use(requireAdmin);

function sendRspamdError(res: Response, error: unknown, fallback: string, status = 500): void {
  res.status(status).json({
    success: false,
    error: error instanceof Error ? error.message : fallback,
  });
}

function getServiceId(req: Request): string | undefined {
  return typeof req.query.serviceId === 'string' && req.query.serviceId.trim() !== ''
    ? req.query.serviceId.trim()
    : typeof req.body?.serviceId === 'string' && req.body.serviceId.trim() !== ''
      ? req.body.serviceId.trim()
      : undefined;
}

function parseRecipients(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => typeof item === 'string' ? item.split(/[,\n]/) : [])
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function getScanMetadata(req: Request) {
  const body = (typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body) ? req.body : {}) as Record<string, unknown>;
  return {
    envelopeFrom: typeof body.envelopeFrom === 'string' ? body.envelopeFrom.trim() : '',
    recipients: parseRecipients(body.recipients),
    clientIp: typeof body.clientIp === 'string' ? body.clientIp.trim() : '',
    helo: typeof body.helo === 'string' ? body.helo.trim() : '',
    hostname: typeof body.hostname === 'string' ? body.hostname.trim() : '',
    authenticatedUser: typeof body.authenticatedUser === 'string' ? body.authenticatedUser.trim() : '',
    settingsId: typeof body.settingsId === 'string' ? body.settingsId.trim() : '',
    queueId: typeof body.queueId === 'string' ? body.queueId.trim() : '',
  };
}

function getBinaryScanMetadata(req: Request) {
  const metadataHeader = typeof req.headers['x-rspamd-scan-metadata'] === 'string'
    ? req.headers['x-rspamd-scan-metadata']
    : null;
  let parsed: Record<string, unknown> = {};
  if (metadataHeader) {
    try {
      const value = JSON.parse(metadataHeader);
      if (typeof value === 'object' && value !== null) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
  }
  return {
    envelopeFrom: typeof parsed.envelopeFrom === 'string' ? parsed.envelopeFrom.trim() : '',
    recipients: parseRecipients(parsed.recipients),
    clientIp: typeof parsed.clientIp === 'string' ? parsed.clientIp.trim() : '',
    helo: typeof parsed.helo === 'string' ? parsed.helo.trim() : '',
    hostname: typeof parsed.hostname === 'string' ? parsed.hostname.trim() : '',
    authenticatedUser: typeof parsed.authenticatedUser === 'string' ? parsed.authenticatedUser.trim() : '',
    settingsId: typeof parsed.settingsId === 'string' ? parsed.settingsId.trim() : '',
    queueId: typeof parsed.queueId === 'string' ? parsed.queueId.trim() : '',
  };
}

router.get('/status', async (req: Request, res: Response) => {
  const serviceId = getServiceId(req);
  if (serviceId) {
    const state = await getRspamdConfigState(serviceId);
    res.json({ success: true, data: state.status });
    return;
  }

  res.json({ success: true, data: await getRspamdStatus() });
});

router.get('/settings', async (req: Request, res: Response) => {
  const state = await getRspamdConfigState(getServiceId(req));
  res.json({ success: true, data: { settings: state.settings, status: state.status } });
});

router.put('/settings', async (req: Request, res: Response) => {
  try {
    const settings = await saveRspamdSettings(req.body ?? {});
    const publicSettings = toPublicRspamdSettings(settings);
    await logAudit(req, AuditActions.RSPAMD_SETTINGS_UPDATE, {
      entityType: 'rspamd_settings',
      newValues: publicSettings as unknown as Record<string, unknown>,
    });
    res.json({ success: true, data: { settings: publicSettings, status: await getRspamdStatus(settings) } });
  } catch (error) {
    sendRspamdError(res, error, 'Failed to save Rspamd settings', 400);
  }
});

router.get('/config', async (req: Request, res: Response) => {
  res.json({ success: true, data: await getRspamdConfigState(getServiceId(req)) });
});

router.put('/config', async (req: Request, res: Response) => {
  try {
    const data = req.body?.managedConfig ?? req.body ?? {};
    const serviceId = getServiceId(req);
    const state = await saveRspamdManagedConfig(data, {
      manageDkimFile: req.body?.fileManagement?.dkim,
      manageBayesFile: req.body?.fileManagement?.bayes,
    }, serviceId);
    await logAudit(req, AuditActions.RSPAMD_CONFIG_UPDATE, {
      entityType: 'rspamd_config',
      entityId: serviceId,
      newValues: {
        serviceId: serviceId ?? null,
        managedConfig: data,
        fileManagement: req.body?.fileManagement ?? null,
      },
    });
    res.json({ success: true, data: state });
  } catch (error) {
    sendRspamdError(res, error, 'Failed to save Rspamd config', 400);
  }
});

// Per-file managed configs (redis.conf, logging.inc, actions.conf, …): save one
// file's typed values; the server normalizes, stores them, renders the UCL, and
// the agent applies it. Returns the updated entry.
router.put('/config/files/:key', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    const key = routeParam(req, 'key');
    const entry = await saveRspamdManagedFile(key, req.body?.values ?? req.body ?? {}, serviceId);
    await logAudit(req, AuditActions.RSPAMD_CONFIG_UPDATE, {
      entityType: 'rspamd_config_file',
      entityId: `${serviceId ?? 'default'}:${entry.fileName}`,
      newValues: { serviceId: serviceId ?? null, file: entry.fileName, values: entry.values },
    });
    res.json({ success: true, data: entry });
  } catch (error) {
    sendRspamdError(res, error, 'Failed to save Rspamd config file', 400);
  }
});

// Config scopes: the 'default' base plus every per-instance override owner.
router.get('/config/scopes', async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listRspamdConfigScopes() });
  } catch (error) {
    sendRspamdError(res, error, 'Failed to list Rspamd config scopes');
  }
});

// Reset an instance's override for one file back to the base.
router.delete('/config/files/:key', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    const key = routeParam(req, 'key');
    const state = await resetRspamdManagedFile(key, serviceId);
    await logAudit(req, AuditActions.RSPAMD_CONFIG_UPDATE, {
      entityType: 'rspamd_config_file',
      entityId: `${serviceId ?? 'default'}:${key}`,
      newValues: { serviceId: serviceId ?? null, file: key, action: 'reset-to-base' },
    });
    res.json({ success: true, data: state });
  } catch (error) {
    sendRspamdError(res, error, 'Failed to reset Rspamd config file', 400);
  }
});

router.post('/reload', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    const response = await reloadRspamd(serviceId);
    await logAudit(req, AuditActions.RSPAMD_CONFIG_UPDATE, {
      entityType: 'rspamd_runtime',
      entityId: serviceId ?? 'default',
      newValues: { action: 'reload', response },
    });
    res.json({ success: true, data: { response } });
  } catch (error) {
    sendRspamdError(res, error, 'Failed to reload Rspamd', 400);
  }
});

router.get('/rules', async (req: Request, res: Response) => {
  res.json({ success: true, data: await getRspamdRulesState(getServiceId(req)) });
});

router.post('/rules/preview', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    const state = await previewRspamdRules(
      req.body?.document ?? {},
      req.body?.fileManagement as Partial<RspamdRulesFileManagement> | undefined,
      serviceId,
    );
    res.json({ success: true, data: state });
  } catch (error) {
    sendRspamdError(res, error, 'Failed to preview Rspamd rules', 400);
  }
});

router.put('/rules', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    const state = await saveRspamdRules(
      req.body?.document ?? {},
      req.body?.fileManagement as Partial<RspamdRulesFileManagement> | undefined,
      serviceId,
    );
    await logAudit(req, AuditActions.RSPAMD_RULES_UPDATE, {
      entityType: 'rspamd_rules',
      entityId: serviceId,
      newValues: {
        serviceId: serviceId ?? null,
        document: req.body?.document ?? {},
        fileManagement: req.body?.fileManagement ?? null,
      },
    });
    res.json({ success: true, data: state });
  } catch (error) {
    sendRspamdError(res, error, 'Failed to save Rspamd rules', 400);
  }
});

router.get('/classifiers', async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getRspamdClassifierSummary(getServiceId(req)) });
  } catch (error) {
    sendRspamdError(res, error, 'Failed to load classifier summary', 400);
  }
});

router.put('/classifiers', async (req: Request, res: Response) => {
  try {
    const state = await saveRspamdClassifierSettings({
      defaultTransport: req.body?.defaultTransport,
      defaultClassifier: req.body?.defaultClassifier,
      fuzzyPresets: Array.isArray(req.body?.fuzzyPresets) ? req.body.fuzzyPresets : undefined,
    }, getServiceId(req));
    await logAudit(req, AuditActions.RSPAMD_CLASSIFIERS_UPDATE, {
      entityType: 'rspamd_classifiers',
      entityId: getServiceId(req),
      newValues: {
        serviceId: getServiceId(req) ?? null,
        defaultTransport: req.body?.defaultTransport ?? null,
        defaultClassifier: req.body?.defaultClassifier ?? null,
        fuzzyPresets: req.body?.fuzzyPresets ?? null,
      },
    });
    res.json({ success: true, data: state });
  } catch (error) {
    sendRspamdError(res, error, 'Failed to save classifier settings', 400);
  }
});

router.post('/scan', async (req: Request, res: Response) => {
  try {
    const rawMessage = typeof req.body?.rawMessage === 'string' ? req.body.rawMessage : '';
    const result = await runRspamdScan({
      serviceId: getServiceId(req),
      transport: req.body?.transport === 'checkv3' ? 'checkv3' : req.body?.transport === 'checkv2' ? 'checkv2' : undefined,
      rawMessage,
      fileName: typeof req.body?.fileName === 'string' ? req.body.fileName : null,
      metadata: getScanMetadata(req),
    }, req.session.admin?.id ?? req.apiKey?.createdBy ?? null);
    await logAudit(req, AuditActions.RSPAMD_SCAN_RUN, {
      entityType: 'rspamd_scan_run',
      entityId: String(result.id),
      newValues: {
        serviceId: result.serviceId,
        transport: result.transport,
        sourceMode: result.sourceMode,
        summaryAction: result.summaryAction,
        summaryScore: result.summaryScore,
      },
    });
    res.json({ success: true, data: result });
  } catch (error) {
    sendRspamdError(res, error, 'Failed to scan message', 400);
  }
});

router.post(
  '/scan-file',
  express.raw({ type: 'application/octet-stream', limit: process.env.RSPAMD_SCAN_UPLOAD_LIMIT || '25mb' }),
  async (req: Request, res: Response) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ success: false, error: 'request body must contain RFC822 message bytes' });
        return;
      }
      const transport = req.query.transport === 'checkv3' ? 'checkv3' : req.query.transport === 'checkv2' ? 'checkv2' : undefined;
      const fileName = typeof req.query.fileName === 'string'
        ? req.query.fileName
        : (typeof req.headers['x-rspamd-scan-filename'] === 'string' ? req.headers['x-rspamd-scan-filename'] : null);
      const result = await runRspamdScanFile({
        serviceId: getServiceId(req),
        transport,
        fileName,
        metadata: getBinaryScanMetadata(req),
        content: req.body,
      }, req.session.admin?.id ?? req.apiKey?.createdBy ?? null);
      await logAudit(req, AuditActions.RSPAMD_SCAN_RUN, {
        entityType: 'rspamd_scan_run',
        entityId: String(result.id),
        newValues: {
          serviceId: result.serviceId,
          transport: result.transport,
          sourceMode: result.sourceMode,
          sourceFileName: result.sourceFileName,
          summaryAction: result.summaryAction,
          summaryScore: result.summaryScore,
        },
      });
      res.json({ success: true, data: result });
    } catch (error) {
      sendRspamdError(res, error, 'Failed to scan uploaded message', 400);
    }
  }
);

router.get('/scans', async (req: Request, res: Response) => {
  try {
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 20);
    const result = await listRspamdScanHistory({
      serviceId: getServiceId(req),
      page,
      limit,
    });
    res.json({
      success: true,
      data: result.runs,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: Math.ceil(result.total / result.limit),
      },
    });
  } catch (error) {
    sendRspamdError(res, error, 'Failed to load scan history', 400);
  }
});

router.get('/scans/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(routeParam(req, 'id'));
    if (!Number.isFinite(id)) {
      res.status(400).json({ success: false, error: 'invalid scan id' });
      return;
    }
    const detail = await getRspamdScanHistoryDetail(id, getServiceId(req));
    if (!detail) {
      res.status(404).json({ success: false, error: 'scan not found' });
      return;
    }
    res.json({ success: true, data: detail });
  } catch (error) {
    sendRspamdError(res, error, 'Failed to load scan detail', 400);
  }
});

router.post('/scans/:id/replay', async (req: Request, res: Response) => {
  try {
    const id = Number(routeParam(req, 'id'));
    if (!Number.isFinite(id)) {
      res.status(400).json({ success: false, error: 'invalid scan id' });
      return;
    }
    const result = await replayRspamdScan(id, getServiceId(req), req.session.admin?.id ?? req.apiKey?.createdBy ?? null);
    if (!result) {
      res.status(404).json({ success: false, error: 'scan not found' });
      return;
    }
    await logAudit(req, AuditActions.RSPAMD_SCAN_REPLAY, {
      entityType: 'rspamd_scan_run',
      entityId: String(result.id),
      newValues: {
        parentRunId: result.parentRunId,
        transport: result.transport,
      },
    });
    res.json({ success: true, data: result });
  } catch (error) {
    sendRspamdError(res, error, 'Failed to replay scan', 400);
  }
});

router.post('/scans/:id/learn', async (req: Request, res: Response) => {
  try {
    const id = Number(routeParam(req, 'id'));
    const label = req.body?.label;
    const classifier = typeof req.body?.classifier === 'string' ? req.body.classifier.trim() : '';
    if (!Number.isFinite(id)) {
      res.status(400).json({ success: false, error: 'invalid scan id' });
      return;
    }
    if (label !== 'spam' && label !== 'ham') {
      res.status(400).json({ success: false, error: 'label must be spam or ham' });
      return;
    }
    const action = await learnRspamdScan(
      id,
      label,
      req.session.admin?.id ?? req.apiKey?.createdBy ?? null,
      getServiceId(req),
      classifier || null,
    );
    if (!action) {
      res.status(404).json({ success: false, error: 'scan not found' });
      return;
    }
    await logAudit(req, AuditActions.RSPAMD_SCAN_LEARN, {
      entityType: 'rspamd_scan_action',
      entityId: String(action.id),
      newValues: {
        runId: action.runId,
        actionType: action.actionType,
        classifier: classifier || null,
      },
    });
    res.json({ success: true, data: action });
  } catch (error) {
    sendRspamdError(res, error, 'Failed to learn scan message', 400);
  }
});

router.post('/scans/:id/fuzzy', async (req: Request, res: Response) => {
  try {
    const id = Number(routeParam(req, 'id'));
    const operation = req.body?.operation === 'remove' ? 'remove' : req.body?.operation === 'add' ? 'add' : null;
    if (!Number.isFinite(id)) {
      res.status(400).json({ success: false, error: 'invalid scan id' });
      return;
    }
    if (!operation) {
      res.status(400).json({ success: false, error: 'operation must be add or remove' });
      return;
    }
    const action = await fuzzyRspamdScan(
      id,
      operation,
      req.session.admin?.id ?? req.apiKey?.createdBy ?? null,
      getServiceId(req),
      typeof req.body?.presetId === 'string' ? req.body.presetId : undefined,
      Number.isFinite(Number(req.body?.flag)) ? Number(req.body.flag) : undefined,
      Number.isFinite(Number(req.body?.weight)) ? Number(req.body.weight) : undefined,
    );
    if (!action) {
      res.status(404).json({ success: false, error: 'scan not found' });
      return;
    }
    await logAudit(req, AuditActions.RSPAMD_SCAN_FUZZY, {
      entityType: 'rspamd_scan_action',
      entityId: String(action.id),
      newValues: {
        runId: action.runId,
        actionType: action.actionType,
        details: action.details,
      },
    });
    res.json({ success: true, data: action });
  } catch (error) {
    sendRspamdError(res, error, 'Failed to update fuzzy storage', 400);
  }
});

router.get('/dkim/domains', async (_req: Request, res: Response) => {
  res.json({ success: true, data: await listDkimDomains() });
});

router.post('/dkim/domains', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const domain = String(body.domain || '').trim().toLowerCase();
  const signDomain = String(body.signDomain || domain).trim().toLowerCase();
  if (!domain) {
    res.status(400).json({ success: false, error: 'domain is required' });
    return;
  }

  const created = await createDkimDomain({
    domain,
    signDomain,
    enabled: body.enabled !== false,
    autoRotateEnabled: Boolean(body.autoRotateEnabled),
    rotateIntervalDays: body.rotateIntervalDays === null || body.rotateIntervalDays === undefined ? null : Number(body.rotateIntervalDays),
    retainOldDays: Number(body.retainOldDays ?? 30),
  });
  await logAudit(req, AuditActions.RSPAMD_DKIM_DOMAIN_CREATE, {
    entityType: 'rspamd_dkim_domain',
    entityId: String(created.id),
    newValues: created as unknown as Record<string, unknown>,
  });
  res.json({ success: true, data: created });
});

router.put('/dkim/domains/:id', async (req: Request, res: Response) => {
  const id = Number(routeParam(req, 'id'));
  if (!Number.isFinite(id)) {
    res.status(400).json({ success: false, error: 'invalid domain id' });
    return;
  }
  const updated = await updateDkimDomain(id, {
    domain: req.body?.domain,
    signDomain: req.body?.signDomain,
    enabled: req.body?.enabled,
    autoRotateEnabled: req.body?.autoRotateEnabled,
    rotateIntervalDays: req.body?.rotateIntervalDays,
    retainOldDays: req.body?.retainOldDays,
  });
  if (!updated) {
    res.status(404).json({ success: false, error: 'domain not found' });
    return;
  }
  await logAudit(req, AuditActions.RSPAMD_DKIM_DOMAIN_UPDATE, {
    entityType: 'rspamd_dkim_domain',
    entityId: String(updated.id),
    newValues: updated as unknown as Record<string, unknown>,
  });
  res.json({ success: true, data: updated });
});

router.get('/dkim/domains/:id/selectors', async (req: Request, res: Response) => {
  const id = Number(routeParam(req, 'id'));
  if (!Number.isFinite(id)) {
    res.status(400).json({ success: false, error: 'invalid domain id' });
    return;
  }
  res.json({ success: true, data: await listDkimSelectors(id) });
});

router.post('/dkim/domains/:id/keys', async (req: Request, res: Response) => {
  const id = Number(routeParam(req, 'id'));
  if (!Number.isFinite(id)) {
    res.status(400).json({ success: false, error: 'invalid domain id' });
    return;
  }
  const selector = await createOrRotateDkimKey(id, 'initial');
  await logAudit(req, AuditActions.RSPAMD_DKIM_KEY_CREATE, {
    entityType: 'rspamd_dkim_selector',
    entityId: String(selector.id),
    newValues: selector as unknown as Record<string, unknown>,
  });
  res.json({ success: true, data: selector });
});

router.post('/dkim/domains/:id/rotate', async (req: Request, res: Response) => {
  const id = Number(routeParam(req, 'id'));
  if (!Number.isFinite(id)) {
    res.status(400).json({ success: false, error: 'invalid domain id' });
    return;
  }
  const selector = await createOrRotateDkimKey(id, 'rotate');
  await logAudit(req, AuditActions.RSPAMD_DKIM_KEY_ROTATE, {
    entityType: 'rspamd_dkim_selector',
    entityId: String(selector.id),
    newValues: selector as unknown as Record<string, unknown>,
  });
  res.json({ success: true, data: selector });
});

router.post('/dkim/domains/:id/import', async (req: Request, res: Response) => {
  const id = Number(routeParam(req, 'id'));
  if (!Number.isFinite(id)) {
    res.status(400).json({ success: false, error: 'invalid domain id' });
    return;
  }

  const privateKey = typeof req.body?.privateKey === 'string' ? req.body.privateKey.trim() : '';
  const selectorName = typeof req.body?.selector === 'string' ? req.body.selector : undefined;
  if (!privateKey) {
    res.status(400).json({ success: false, error: 'privateKey is required' });
    return;
  }

  try {
    const selector = await importDkimKey(id, privateKey, selectorName);
    await logAudit(req, AuditActions.RSPAMD_DKIM_KEY_CREATE, {
      entityType: 'rspamd_dkim_selector',
      entityId: String(selector.id),
      newValues: {
        ...selector,
        import: true,
      } as unknown as Record<string, unknown>,
    });
    res.json({ success: true, data: selector });
  } catch (error) {
    sendRspamdError(res, error, 'Failed to import DKIM key', 400);
  }
});

router.post('/dkim/selectors/:id/revoke', async (req: Request, res: Response) => {
  const id = Number(routeParam(req, 'id'));
  if (!Number.isFinite(id)) {
    res.status(400).json({ success: false, error: 'invalid selector id' });
    return;
  }
  const success = await revokeDkimSelector(id);
  if (!success) {
    res.status(400).json({ success: false, error: 'selector could not be revoked' });
    return;
  }
  await logAudit(req, AuditActions.RSPAMD_DKIM_KEY_REVOKE, {
    entityType: 'rspamd_dkim_selector',
    entityId: String(id),
  });
  res.json({ success: true });
});

router.get('/training/imports/:id', async (req: Request, res: Response) => {
  const id = Number(routeParam(req, 'id'));
  const job = await getTrainingImport(id);
  if (!job) {
    res.status(404).json({ success: false, error: 'import not found' });
    return;
  }
  res.json({ success: true, data: job });
});

router.get('/training/samples', async (req: Request, res: Response) => {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 25);
  const label = req.query.label === 'spam' || req.query.label === 'ham'
    ? req.query.label
    : undefined;
  const status = req.query.status === 'pending' || req.query.status === 'learned' || req.query.status === 'failed'
    ? req.query.status
    : undefined;
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;
  const result = await getTrainingCorpus({ page, limit, label, status, search });
  res.json({
    success: true,
    data: result.samples,
    pagination: {
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: Math.ceil(result.total / result.limit),
    },
  });
});

router.get('/training/samples/:id', async (req: Request, res: Response) => {
  const id = Number(routeParam(req, 'id'));
  const sample = await getTrainingSample(id);
  if (!sample) {
    res.status(404).json({ success: false, error: 'sample not found' });
    return;
  }
  res.json({ success: true, data: sample });
});

router.post(
  '/training/import-file',
  express.raw({ type: 'application/octet-stream', limit: process.env.RSPAMD_TRAINING_UPLOAD_LIMIT || '100mb' }),
  async (req: Request, res: Response) => {
    const label = req.query.label === 'spam' || req.query.label === 'ham'
      ? req.query.label
      : (typeof req.headers['x-rspamd-training-label'] === 'string' ? req.headers['x-rspamd-training-label'] : undefined);
    const fileName = typeof req.query.fileName === 'string'
      ? req.query.fileName
      : (typeof req.headers['x-rspamd-training-filename'] === 'string' ? req.headers['x-rspamd-training-filename'] : undefined);

    if (label !== 'spam' && label !== 'ham') {
      res.status(400).json({ success: false, error: 'label must be spam or ham' });
      return;
    }
    if (!fileName) {
      res.status(400).json({ success: false, error: 'fileName is required' });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ success: false, error: 'request body must contain file bytes' });
      return;
    }

    const result = await importTrainingBinary({
      name: fileName,
      content: req.body,
    }, label, req.session.admin?.id ?? null, getServiceId(req));

    await logAudit(req, AuditActions.RSPAMD_TRAINING_IMPORT, {
      entityType: 'rspamd_training_import',
      entityId: result.job ? String(result.job.id) : undefined,
      newValues: {
        label,
        fileName,
        rawUpload: true,
        sampleCount: result.samples.length,
        skipped: result.skipped.length,
      },
    });

    res.json({ success: true, data: result });
  }
);

router.post('/training/samples/:id/learn', async (req: Request, res: Response) => {
  const id = Number(routeParam(req, 'id'));
  const classifier = typeof req.body?.classifier === 'string' ? req.body.classifier.trim() : '';
  const sample = await relearnTrainingSample(id, getServiceId(req), classifier || null);
  if (!sample) {
    res.status(404).json({ success: false, error: 'sample not found' });
    return;
  }
  await logAudit(req, AuditActions.RSPAMD_TRAINING_LEARN, {
    entityType: 'rspamd_training_sample',
    entityId: String(sample.id),
    newValues: { classifier: classifier || null },
  });
  res.json({ success: true, data: sample });
});

router.post('/training/samples/:id/relabel', async (req: Request, res: Response) => {
  const id = Number(routeParam(req, 'id'));
  const label = req.body?.label;
  if (label !== 'spam' && label !== 'ham') {
    res.status(400).json({ success: false, error: 'label must be spam or ham' });
    return;
  }
  const classifier = typeof req.body?.classifier === 'string' ? req.body.classifier.trim() : '';
  const sample = await relabelAndRelearnTrainingSample(id, label, getServiceId(req), classifier || null);
  if (!sample) {
    res.status(404).json({ success: false, error: 'sample not found' });
    return;
  }
  await logAudit(req, AuditActions.RSPAMD_TRAINING_RELABEL, {
    entityType: 'rspamd_training_sample',
    entityId: String(sample.id),
    newValues: { label, classifier: classifier || null },
  });
  res.json({ success: true, data: sample });
});

router.delete('/training/samples/:id', async (req: Request, res: Response) => {
  const id = Number(routeParam(req, 'id'));
  const sample = await deleteTrainingSampleAndFile(id, getServiceId(req));
  if (!sample) {
    res.status(404).json({ success: false, error: 'sample not found' });
    return;
  }
  await logAudit(req, AuditActions.RSPAMD_TRAINING_DELETE, {
    entityType: 'rspamd_training_sample',
    entityId: String(sample.id),
  });
  res.json({ success: true, data: sample });
});

// A route that needs an unset Rspamd directory answers with what is missing.
router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof RspamdNotConfiguredError) {
    res.status(400).json({ success: false, error: error.message });
    return;
  }
  next(error);
});

export default router;
