import express, { type Request, type Response, type NextFunction } from 'express';
import { getModuleHostPolicy } from '../services/module-host-policy.js';

const bodies = new WeakMap<object, Buffer>();
export function getModuleRequestBody(req: Request): Buffer {
  return bodies.get(req) ?? Buffer.alloc(0);
}
export async function moduleRequestBody(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (['GET', 'HEAD'].includes(req.method)) { next(); return; }
  const slug = req.path.split('/')[1];
  const policy = await getModuleHostPolicy(slug);
  const options = { limit: policy.maxBodyMiB * 1024 * 1024, inflate: false,
    verify: (request: object, _response: object, buffer: Buffer) => { bodies.set(request, buffer); } };
  if (req.is('application/json') || req.is('application/*+json')) {
    express.json({ ...options, type: ['application/json', 'application/*+json'] })(req, res, next);
  } else if (req.is(['text/*', 'application/octet-stream', 'application/dns', 'application/csv', 'multipart/form-data'])) {
    express.raw({ ...options, type: () => true })(req, res, next);
  } else if (!req.headers['content-type'] && !req.headers['transfer-encoding'] && Number(req.headers['content-length'] ?? 0) === 0) {
    next();
  } else {
    res.status(415).json({ success: false, error: 'Unsupported module request content type' });
  }
}
