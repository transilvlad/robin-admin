import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { logAudit } from '../middleware/audit.js';
import {
  createFleetAgent,
  deleteFleetAgent,
  getFleetAgentById,
  listFleetAgents,
  rotateFleetAgentEnrollmentToken,
} from '../db/queries/fleet-agents.js';
import {
  assignFleetServiceAgent,
  assignFleetServiceConfigAgent,
  assignFleetServiceLogAgent,
  getAgentServiceResponsibilities,
  getFleetServiceById,
} from '../db/queries/fleet-services.js';
import { logger } from '../logger.js';
import { routeParam } from './params.js';
import { invalidateFleetCapabilities } from '../services/service-capabilities.js';
import { toPublicFleetService } from '../services/service-dsn.js';

const router = Router();

// Any change to services or agents can change what the UI may show.
router.use((req, res, next) => {
  if (req.method !== 'GET') res.on('finish', invalidateFleetCapabilities);
  next();
});

router.use(requireAuth);
router.use(requireAdmin);

router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listFleetAgents() });
  } catch (error) {
    logger.error('Failed to list fleet agents', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to list agents' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    const labels = req.body?.labels && typeof req.body.labels === 'object' && !Array.isArray(req.body.labels)
      ? (req.body.labels as Record<string, unknown>)
      : {};
    const ttl = Number.isFinite(req.body?.enrollmentTtlHours) ? Number(req.body.enrollmentTtlHours) : undefined;

    const created = await createFleetAgent({ name, labels, enrollmentTtlHours: ttl });
    await logAudit(req, 'fleet_agent.create', { entityType: 'fleet_agent', entityId: created.agent.agentId });

    res.status(201).json({
      success: true,
      data: {
        agent: created.agent,
        enrollment: { token: created.enrollmentToken, expiresAt: created.enrollmentExpiresAt },
      },
    });
  } catch (error) {
    logger.error('Failed to create fleet agent', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to create agent' });
  }
});

router.get('/:agentId', async (req: Request, res: Response) => {
  try {
    const agent = await getFleetAgentById(routeParam(req, 'agentId'));
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    res.json({ success: true, data: agent });
  } catch (error) {
    logger.error('Failed to fetch fleet agent', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to fetch agent' });
  }
});

router.post('/:agentId/enrollment/rotate', async (req: Request, res: Response) => {
  try {
    const rotated = await rotateFleetAgentEnrollmentToken(routeParam(req, 'agentId'));
    if (!rotated) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    await logAudit(req, 'fleet_agent.enrollment_rotate', { entityType: 'fleet_agent', entityId: routeParam(req, 'agentId') });
    res.json({ success: true, data: { enrollment: { token: rotated.enrollmentToken, expiresAt: rotated.enrollmentExpiresAt } } });
  } catch (error) {
    logger.error('Failed to rotate fleet agent enrollment token', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to rotate enrollment token' });
  }
});

// Everything this agent is responsible for — services it collects metrics/config
// for (collection_mode = 'agent') plus services it only tails logs for
// (log_agent_id) — each carrying collectMetrics/collectConfig/collectLogs flags.
router.get('/:agentId/services', async (req: Request, res: Response) => {
  try {
    const agent = await getFleetAgentById(routeParam(req, 'agentId'));
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    res.json({ success: true, data: (await getAgentServiceResponsibilities(routeParam(req, 'agentId'))).map(toPublicFleetService) });
  } catch (error) {
    logger.error('Failed to list agent services', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to list agent services' });
  }
});

// Assign a service to this agent (switches it to agent collection mode).
router.post('/:agentId/services', async (req: Request, res: Response) => {
  try {
    const agent = await getFleetAgentById(routeParam(req, 'agentId'));
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    const serviceId = typeof req.body?.serviceId === 'string' ? req.body.serviceId.trim() : '';
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    if (!(await getFleetServiceById(serviceId))) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }
    const updated = await assignFleetServiceAgent(serviceId, routeParam(req, 'agentId'));
    await logAudit(req, 'fleet_agent.assign_service', { entityType: 'fleet_service', entityId: serviceId, newValues: { agentId: routeParam(req, 'agentId') } });
    res.json({ success: true, data: updated && toPublicFleetService(updated) });
  } catch (error) {
    logger.error('Failed to assign service to agent', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to assign service' });
  }
});

// Release a service back to direct mode.
router.delete('/:agentId/services/:serviceId', async (req: Request, res: Response) => {
  try {
    const service = await getFleetServiceById(routeParam(req, 'serviceId'));
    if (!service || service.agentId !== routeParam(req, 'agentId')) {
      return res.status(404).json({ success: false, error: 'Service not assigned to this agent' });
    }
    const updated = await assignFleetServiceAgent(routeParam(req, 'serviceId'), null);
    await logAudit(req, 'fleet_agent.release_service', { entityType: 'fleet_service', entityId: routeParam(req, 'serviceId') });
    res.json({ success: true, data: updated && toPublicFleetService(updated) });
  } catch (error) {
    logger.error('Failed to release service from agent', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to release service' });
  }
});

// Assign this agent as a service's LOG agent (ships its logs; metrics/config
// stay in whatever mode they're in — this does NOT switch collection_mode).
router.post('/:agentId/log-services', async (req: Request, res: Response) => {
  try {
    const agent = await getFleetAgentById(routeParam(req, 'agentId'));
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    const serviceId = typeof req.body?.serviceId === 'string' ? req.body.serviceId.trim() : '';
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    if (!(await getFleetServiceById(serviceId))) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }
    const updated = await assignFleetServiceLogAgent(serviceId, routeParam(req, 'agentId'));
    await logAudit(req, 'fleet_agent.assign_log_service', { entityType: 'fleet_service', entityId: serviceId, newValues: { logAgentId: routeParam(req, 'agentId') } });
    res.json({ success: true, data: updated && toPublicFleetService(updated) });
  } catch (error) {
    logger.error('Failed to assign log service to agent', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to assign log service' });
  }
});

// Stop this agent shipping a service's logs (clears log_agent_id).
router.delete('/:agentId/log-services/:serviceId', async (req: Request, res: Response) => {
  try {
    const service = await getFleetServiceById(routeParam(req, 'serviceId'));
    if (!service || service.logAgentId !== routeParam(req, 'agentId')) {
      return res.status(404).json({ success: false, error: 'Service is not log-assigned to this agent' });
    }
    const updated = await assignFleetServiceLogAgent(routeParam(req, 'serviceId'), null);
    await logAudit(req, 'fleet_agent.release_log_service', { entityType: 'fleet_service', entityId: routeParam(req, 'serviceId') });
    res.json({ success: true, data: updated && toPublicFleetService(updated) });
  } catch (error) {
    logger.error('Failed to release log service from agent', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to release log service' });
  }
});

// Assign this agent as a service's CONFIG agent (applies + reloads its managed
// config in-process; metrics/logs stay in whatever mode they're in).
router.post('/:agentId/config-services', async (req: Request, res: Response) => {
  try {
    const agent = await getFleetAgentById(routeParam(req, 'agentId'));
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    const serviceId = typeof req.body?.serviceId === 'string' ? req.body.serviceId.trim() : '';
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    if (!(await getFleetServiceById(serviceId))) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }
    const updated = await assignFleetServiceConfigAgent(serviceId, routeParam(req, 'agentId'));
    await logAudit(req, 'fleet_agent.assign_config_service', { entityType: 'fleet_service', entityId: serviceId, newValues: { configAgentId: routeParam(req, 'agentId') } });
    res.json({ success: true, data: updated && toPublicFleetService(updated) });
  } catch (error) {
    logger.error('Failed to assign config service to agent', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to assign config service' });
  }
});

// Stop this agent applying a service's config (clears config_agent_id).
router.delete('/:agentId/config-services/:serviceId', async (req: Request, res: Response) => {
  try {
    const service = await getFleetServiceById(routeParam(req, 'serviceId'));
    if (!service || service.configAgentId !== routeParam(req, 'agentId')) {
      return res.status(404).json({ success: false, error: 'Service is not config-assigned to this agent' });
    }
    const updated = await assignFleetServiceConfigAgent(routeParam(req, 'serviceId'), null);
    await logAudit(req, 'fleet_agent.release_config_service', { entityType: 'fleet_service', entityId: routeParam(req, 'serviceId') });
    res.json({ success: true, data: updated && toPublicFleetService(updated) });
  } catch (error) {
    logger.error('Failed to release config service from agent', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to release config service' });
  }
});

router.delete('/:agentId', async (req: Request, res: Response) => {
  try {
    const removed = await deleteFleetAgent(routeParam(req, 'agentId'));
    if (!removed) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    await logAudit(req, 'fleet_agent.delete', { entityType: 'fleet_agent', entityId: routeParam(req, 'agentId') });
    res.json({ success: true, data: { deleted: true } });
  } catch (error) {
    logger.error('Failed to delete fleet agent', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to delete agent' });
  }
});

export default router;
