import { Router, type Request, type Response } from 'express';
import { getCurrentAdmin, requireAuth } from '../middleware/auth.js';
import { requireViewer } from '../middleware/rbac.js';
import { assertModuleRuntimeAccess, getLocalInstanceFingerprint, ModuleAccessError } from '../services/modules.js';
import { logger } from '../logger.js';
import type { SessionData } from '../types/index.js';
import { config } from '../config.js';
import { routeParam } from './params.js';
import { signModuleIdentity } from '../services/module-identity.js';
import { getModuleHostPolicy } from '../services/module-host-policy.js';
import { getModuleRequestBody } from '../middleware/module-body.js';

const router = Router();
export const moduleAssetRoutes = Router();

const ALLOWED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-unmodified-since',
  'range',
  'user-agent',
  'x-request-id',
]);
const MAX_MODULE_BACKEND_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_MODULE_ASSET_RESPONSE_BYTES = 25 * 1024 * 1024;

function getForwardPath(req: Request): string {
  // Express 5 hands a named wildcard over as decoded path segments; re-encode
  // each so an encoded slash inside a segment stays inside it.
  const segments = req.params.path;
  const wildcard = Array.isArray(segments) && segments.length > 0 ? `/${segments.map(encodeURIComponent).join('/')}` : '';
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  return `${wildcard}${query}`;
}

export function isModuleAssetRequest(req: Request): boolean {
  const segments = req.params.path;
  if (!Array.isArray(segments) || segments.length === 0) {
    return false;
  }

  const lastSegment = segments.at(-1) ?? '';
  return lastSegment.includes('.');
}

export function buildModuleProxyHeaders(
  requestHeaders: Request['headers'],
  currentAdmin: SessionData | null,
  moduleProxySecret: string,
  instanceFingerprint?: string,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(requestHeaders)) {
    if (!value || !ALLOWED_REQUEST_HEADERS.has(key.toLowerCase())) {
      continue;
    }

    if (Array.isArray(value)) {
      headers.set(key, value.join(', '));
    } else {
      headers.set(key, value);
    }
  }

  headers.set('x-robin-module-secret', moduleProxySecret);
  // Lets module backends recognise which licenses/resources belong to THIS
  // robin-admin deployment (e.g. Sheriff's "used here" flag).
  if (instanceFingerprint) {
    headers.set('x-robin-instance-fingerprint', instanceFingerprint);
  }
  if (currentAdmin) {
    headers.set('x-robin-admin-id', String(currentAdmin.adminId));
    if (currentAdmin.uid) {
      headers.set('x-robin-admin-uid', currentAdmin.uid);
    }
    headers.set('x-robin-admin-role', currentAdmin.role);
    headers.set('x-robin-admin-email', currentAdmin.email);
    headers.set('x-robin-admin-name', currentAdmin.name);
  }
  return headers;
}

function assertContentLengthAllowed(response: globalThis.Response, maxBytes: number): void {
  const rawLength = response.headers.get('content-length');
  if (!rawLength) return;
  const length = Number(rawLength);
  if (Number.isFinite(length) && length > maxBytes) {
    throw new ModuleAccessError('Module response is too large.', 502);
  }
}

async function readLimitedResponse(response: globalThis.Response, maxBytes: number): Promise<Buffer> {
  assertContentLengthAllowed(response, maxBytes);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ModuleAccessError('Module response is too large.', 502);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function proxyModuleRequest(moduleSlug: string, req: Request, res: Response) {
  const moduleSummary = await assertModuleRuntimeAccess(moduleSlug);

  const currentAdmin = getCurrentAdmin(req);
  const targetBase = moduleSummary.backendUrl;
  if (!targetBase) {
    throw new ModuleAccessError('Module backend target is not configured.', 404);
  }

  const moduleProxySecret = config.moduleProxySecrets[moduleSlug];
  if (!moduleProxySecret) {
    throw new ModuleAccessError('Module backend credential is not configured.', 503);
  }
  const instanceFingerprint = await getLocalInstanceFingerprint().catch(() => undefined);
  const headers = buildModuleProxyHeaders(req.headers, currentAdmin, moduleProxySecret, instanceFingerprint);

  const method = req.method.toUpperCase();
  const unsafe = !['GET', 'HEAD'].includes(method);
  const body = unsafe ? getModuleRequestBody(req) : Buffer.alloc(0);
  const targetUrl = new URL(`${targetBase}${getForwardPath(req)}`);
  const target = targetUrl.pathname + targetUrl.search;
  if (unsafe && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!currentAdmin) throw new ModuleAccessError('Authentication required.', 401);
  headers.set('x-robin-module-identity', await signModuleIdentity(moduleSlug, currentAdmin, req.apiKey?.id, method, target, body, headers));
  const policy = await getModuleHostPolicy(moduleSlug);
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(policy.timeoutSeconds * 1000),
    redirect: 'error',
  };

  if (unsafe) {
    init.body = new Uint8Array(body);
  }

  const response = await fetch(targetUrl, init);
  const contentType = response.headers.get('content-type');
  if (contentType) {
    res.setHeader('content-type', contentType);
  }
  res.status(response.status);

  res.send(await readLimitedResponse(response, MAX_MODULE_BACKEND_RESPONSE_BYTES));
}

async function proxyModuleAsset(moduleSlug: string, req: Request, res: Response) {
  const moduleSummary = await assertModuleRuntimeAccess(moduleSlug);

  if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  const targetBase = moduleSummary.assetBaseUrl;
  if (!targetBase) {
    res.status(404).json({ success: false, error: 'Module asset target is not configured' });
    return;
  }

  const policy = await getModuleHostPolicy(moduleSlug);
  const response = await fetch(new URL(req.originalUrl, targetBase), {
    method: req.method,
    headers: {
      accept: req.get('accept') ?? '*/*',
      'user-agent': req.get('user-agent') ?? 'robin-admin',
    },
    signal: AbortSignal.timeout(policy.timeoutSeconds * 1000),
    redirect: 'error',
  });

  for (const header of ['content-type', 'etag', 'last-modified']) {
    const value = response.headers.get(header);
    if (value) {
      res.setHeader(header, value);
    }
  }

  res.setHeader('cache-control', 'private, no-store');
  res.status(response.status);

  if (req.method.toUpperCase() === 'HEAD') {
    res.end();
    return;
  }

  res.send(await readLimitedResponse(response, MAX_MODULE_ASSET_RESPONSE_BYTES));
}

function handleModuleError(res: Response, error: unknown, fallback: string) {
  if (error instanceof ModuleAccessError) {
    res.status(error.status).json({
      success: false,
      error: error.message,
    });
    return;
  }

  logger.error(fallback, {
    error: error instanceof Error ? error.message : String(error),
  });
  res.status(502).json({
    success: false,
    error: fallback,
  });
}

router.use(requireAuth);
router.use(requireViewer);

router.use('/:slug/*path', async (req: Request, res: Response) => {
  try {
    await proxyModuleRequest(routeParam(req, 'slug'), req, res);
  } catch (error) {
    handleModuleError(res, error, 'Module backend is unavailable');
  }
});

moduleAssetRoutes.use(requireAuth);
moduleAssetRoutes.use(requireViewer);

moduleAssetRoutes.use('/:slug/*path', async (req: Request, res: Response, next) => {
  if (!isModuleAssetRequest(req)) {
    next();
    return;
  }

  try {
    await proxyModuleAsset(routeParam(req, 'slug'), req, res);
  } catch (error) {
    handleModuleError(res, error, 'Module assets are unavailable');
  }
});

export default router;
