/**
 * Authentication middleware.
 */

import { Request, Response, NextFunction } from 'express';
import type { SessionData } from '../types/index.js';
import { hasApiKeyScope, requiredScopeForRequest } from './security.js';

// Extend Express session
declare module 'express-session' {
  interface SessionData {
    admin?: {
      id: number;
      uid: string;
      name: string;
      email: string;
      role: 'viewer' | 'editor' | 'admin';
      allowedCidrs?: string[];
    };
    authenticatedAt?: number;
    lastSeenAt?: number;
    csrfToken?: string;
  }
}

/**
 * Require authentication middleware.
 * Returns 401 if not authenticated.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.apiKey) {
    const requiredScope = requiredScopeForRequest(req);
    if (!hasApiKeyScope(req, requiredScope)) {
      res.status(403).json({
        success: false,
        error: `API key scope required: ${requiredScope}`,
      });
      return;
    }
    next();
    return;
  }

  if (req.apiKeyAuthError) {
    res.status(401).json({
      success: false,
      error: req.apiKeyAuthError,
    });
    return;
  }

  if (!req.session?.admin) {
    res.status(401).json({
      success: false,
      error: 'Authentication required',
    });
    return;
  }
  next();
}

/**
 * Get the current admin from the session.
 */
export function getCurrentAdmin(req: Request): SessionData | null {
  if (req.apiKey) {
    return {
      adminId: req.apiKey.createdBy ?? 0,
      name: req.apiKey.name,
      email: `api-key:${req.apiKey.name}`,
      role: req.apiKey.role,
    };
  }
  if (!req.session?.admin) {
    return null;
  }
  return {
    adminId: req.session.admin.id,
    uid: req.session.admin.uid,
    name: req.session.admin.name,
    email: req.session.admin.email,
    role: req.session.admin.role,
  };
}
