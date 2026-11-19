import express, { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { acceptModuleAlertEvent, moduleAlertPublisher, parseModuleAlertEvent } from '../services/alerts/module-alerts.js';
import { ModuleAccessError } from '../services/modules.js';
import { routeParam } from './params.js';

const router = Router();

router.post('/:slug/alert-events', requireAuth, (req, res, next) => {
  const publisher = moduleAlertPublisher(routeParam(req, 'slug'));
  if (!req.apiKey?.scopes.includes('module-alerts:publish') || publisher?.apiKeyId !== req.apiKey.id) {
    res.status(403).json({ success: false, error: 'A credential bound to this module publisher is required' });
    return;
  }
  if (!req.is('application/json')) {
    res.status(415).json({ success: false, error: 'Expected JSON' });
    return;
  }
  next();
}, express.json({ limit: '2kb', inflate: false }), async (req, res, next) => {
  const event = parseModuleAlertEvent(req.body);
  if (!event) {
    res.status(400).json({ success: false, error: 'Invalid or expired module alert event' });
    return;
  }
  try {
    await acceptModuleAlertEvent({
      slug: routeParam(req, 'slug'), category: event.category, publisherKeyId: req.apiKey!.id, severity: event.severity,
    }, event);
    res.status(202).json({ success: true });
  } catch (error) {
    if (error instanceof ModuleAccessError) {
      res.status(403).json({ success: false, error: 'Module alert publisher is not authorized' });
      return;
    }
    next(error);
  }
});

export default router;
