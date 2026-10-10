/**
 * Role-based access control middleware.
 */

import { Request, Response, NextFunction } from 'express';
import type { AdminRole } from '../types/index.js';
import { hasApiKeyRole } from './security.js';

// Role hierarchy: admin > editor > viewer
const roleHierarchy: Record<AdminRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
};

/**
 * Require a minimum role level.
 */
export function requireRole(minRole: AdminRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.apiKey) {
      if (!hasApiKeyRole(req, minRole)) {
        res.status(403).json({
          success: false,
          error: `Insufficient API key role. Required role: ${minRole}`,
        });
        return;
      }
      next();
      return;
    }

    if (!req.session?.admin) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
      return;
    }

    const userRoleLevel = roleHierarchy[req.session.admin.role];
    const requiredRoleLevel = roleHierarchy[minRole];

    if (userRoleLevel < requiredRoleLevel) {
      res.status(403).json({
        success: false,
        error: `Insufficient permissions. Required role: ${minRole}`,
      });
      return;
    }

    next();
  };
}

/**
 * Check if user has at least the specified role.
 */
export function hasRole(userRole: AdminRole, requiredRole: AdminRole): boolean {
  return roleHierarchy[userRole] >= roleHierarchy[requiredRole];
}

/**
 * Require admin role.
 */
export const requireAdmin = requireRole('admin');

/**
 * Require editor role or above.
 */
export const requireEditor = requireRole('editor');

/**
 * Require viewer role or above (any authenticated user).
 */
export const requireViewer = requireRole('viewer');
