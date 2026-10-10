import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  CAPABILITY_RULES,
  SETUP_CHOICES,
  evaluateCapabilities,
  setupFacts,
} from '../services/capability-rules.js';
import { getFleetCapabilities } from '../services/service-capabilities.js';
import { FLEET_SERVICE_TYPES } from '../services/service-types.js';

const router = Router();

router.use(requireAuth);

// GET /api/fleet/capabilities — what each registered service can do in its
// setup, and per type what at least one enabled service can do.
router.get('/', async (_req: Request, res: Response) => {
  res.json({ success: true, data: await getFleetCapabilities() });
});

// GET /api/fleet/capabilities/matrix — the same rules evaluated for every
// setup, for the Fleet docs page.
router.get('/matrix', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      rules: CAPABILITY_RULES.map(({ id, label, surface, types }) => ({ id, label, surface, types })),
      setups: SETUP_CHOICES,
      matrix: Object.fromEntries(FLEET_SERVICE_TYPES.map((type) => [
        type,
        SETUP_CHOICES.map((setup) => ({ setup, features: evaluateCapabilities(setupFacts(type, setup)) })),
      ])),
    },
  });
});

export default router;
