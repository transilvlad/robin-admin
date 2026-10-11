import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../logger.js';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

// The agent command channel is a long-poll: it is meant to wait ~25s.
const LONG_POLL_PATHS = new Set(['/api/fleet/agent/commands']);

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.header('x-request-id')?.trim();
  req.requestId = supplied && SAFE_REQUEST_ID.test(supplied) ? supplied : crypto.randomUUID();
  res.setHeader('X-Request-ID', req.requestId);

  const startedAt = Date.now();
  res.on('finish', () => {
    const metadata = {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    };
    const slow = metadata.durationMs >= 1000 && !LONG_POLL_PATHS.has(metadata.path);
    if (res.statusCode >= 500 || slow) {
      logger.warn('HTTP request completed', metadata);
    } else {
      logger.info('HTTP request completed', metadata);
    }
  });

  next();
}
