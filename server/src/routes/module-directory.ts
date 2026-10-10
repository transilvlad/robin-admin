import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { query } from '../db/connection.js';
import { sameSecret } from '../services/module-identity-protocol.js';
import { getModuleHostPolicy } from '../services/module-host-policy.js';
import { assertModuleRuntimeAccess } from '../services/modules.js';
import { getConfig } from '../db/queries/config.js';
import { routeParam } from './params.js';

const router = Router();
router.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
router.use('/:slug', async (req, res, next) => {
  const slug = routeParam(req, 'slug');
  const secret = req.get('x-robin-module-secret') ?? '';
  if (!Object.hasOwn(config.moduleProxySecrets, slug) || !sameSecret(config.moduleProxySecrets[slug], secret)) {
    res.status(401).json({ success: false, error: 'Module authentication required' }); return;
  }
  if (!(await getConfig()).modulesEnabled) {
    res.status(403).json({ success: false, error: 'Modules are disabled' }); return;
  }
  await assertModuleRuntimeAccess(slug);
  const policy = await getModuleHostPolicy(slug);
  const allowed = req.path === '/events' ? policy.lifecycleRead : policy.directoryRead;
  if (!allowed) { res.status(403).json({ success: false, error: 'Module directory capability is not approved' }); return; }
  res.setHeader('cache-control', 'no-store');
  next();
});
function decimal(value: unknown, fallback: string): string | null {
  return value === undefined ? fallback : typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value)
    && BigInt(value) <= 9223372036854775807n ? value : null;
}
function pageSize(value: unknown): number | null {
  const raw = decimal(value, '100');
  return raw !== null && Number(raw) >= 1 && Number(raw) <= 200 ? Number(raw) : null;
}
router.get('/:slug/events', async (req, res) => {
  const after = decimal(req.query.after, '0');
  const limit = pageSize(req.query.limit);
  if (after === null || limit === null) { res.status(400).json({ success: false, error: 'Invalid cursor or limit' }); return; }
  const result = await query<{ revision: string; uid: string; kind: string; disabled: boolean; createdAt: Date }>(
    `SELECT revision::text, uid, kind, disabled, created_at AS "createdAt" FROM admin_directory_events
      WHERE revision > $1::bigint ORDER BY revision LIMIT $2`, [after, limit],
  );
  res.json({ success: true, data: result.rows, nextCursor: result.rows.at(-1)?.revision ?? after });
});
router.get('/:slug/admins', async (req, res) => {
  const limit = pageSize(req.query.limit);
  const after = req.query.after ?? '00000000-0000-0000-0000-000000000000';
  const search = req.query.search ?? '';
  if (limit === null || typeof after !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(after)
      || typeof search !== 'string' || search.length > 200) {
    res.status(400).json({ success: false, error: 'Invalid directory query' }); return;
  }
  const result = await query<{ uid: string; name: string; email: string; role: string; disabled: boolean }>(
    `SELECT uid, name, email, role, disabled FROM admins WHERE uid > $1::uuid
      AND ($2 = '' OR strpos(lower(name || ' ' || email), lower($2)) > 0) ORDER BY uid LIMIT $3`,
    [after, search, limit],
  );
  res.json({ success: true, data: result.rows, nextCursor: result.rows.at(-1)?.uid ?? null });
});
router.get('/:slug/admins/:uid', async (req, res) => {
  const uid = routeParam(req, 'uid');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uid)) {
    res.status(400).json({ success: false, error: 'Invalid administrator UUID' }); return;
  }
  const result = await query('SELECT uid, name, email, role, disabled FROM admins WHERE uid = $1', [uid]);
  res.status(result.rows[0] ? 200 : 404).json({ success: !!result.rows[0], data: result.rows[0] ?? null });
});
export default router;
