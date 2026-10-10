/**
 * Tests for role-based access control middleware.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { AdminRole } from '../types/index.js';
import {
  requireRole,
  hasRole,
  requireAdmin,
  requireEditor,
  requireViewer,
} from './rbac.js';

// Create mock request with proper typing
function createMockRequest(overrides: Partial<Request> = {}): Partial<Request> {
  return {
    session: {
      admin: undefined,
    },
    ...overrides,
  };
}

// Create mock response with proper typing
function createMockResponse(): {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

// Create mock next function
function createMockNext(): NextFunction {
  return vi.fn();
}

describe('Role-Based Access Control Middleware', () => {
  describe('requireRole', () => {
    describe('viewer role requirement', () => {
      it('should allow viewer role', () => {
        const req = createMockRequest({
          session: {
            admin: {
              id: 1,
              email: 'viewer@example.com',
              role: 'viewer',
            },
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        const middleware = requireRole('viewer');
        middleware(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
      });

      it('should allow editor role', () => {
        const req = createMockRequest({
          session: {
            admin: {
              id: 2,
              email: 'editor@example.com',
              role: 'editor',
            },
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        const middleware = requireRole('viewer');
        middleware(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
      });

      it('should allow admin role', () => {
        const req = createMockRequest({
          session: {
            admin: {
              id: 3,
              email: 'admin@example.com',
              role: 'admin',
            },
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        const middleware = requireRole('viewer');
        middleware(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
      });
    });

    describe('editor role requirement', () => {
      it('should reject viewer role', () => {
        const req = createMockRequest({
          session: {
            admin: {
              id: 1,
              email: 'viewer@example.com',
              role: 'viewer',
            },
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        const middleware = requireRole('editor');
        middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({
          success: false,
          error: 'Insufficient permissions. Required role: editor',
        });
        expect(next).not.toHaveBeenCalled();
      });

      it('should allow editor role', () => {
        const req = createMockRequest({
          session: {
            admin: {
              id: 2,
              email: 'editor@example.com',
              role: 'editor',
            },
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        const middleware = requireRole('editor');
        middleware(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
      });

      it('should allow admin role', () => {
        const req = createMockRequest({
          session: {
            admin: {
              id: 3,
              email: 'admin@example.com',
              role: 'admin',
            },
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        const middleware = requireRole('editor');
        middleware(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
      });
    });

    describe('admin role requirement', () => {
      it('should reject viewer role', () => {
        const req = createMockRequest({
          session: {
            admin: {
              id: 1,
              email: 'viewer@example.com',
              role: 'viewer',
            },
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        const middleware = requireRole('admin');
        middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({
          success: false,
          error: 'Insufficient permissions. Required role: admin',
        });
        expect(next).not.toHaveBeenCalled();
      });

      it('should reject editor role', () => {
        const req = createMockRequest({
          session: {
            admin: {
              id: 2,
              email: 'editor@example.com',
              role: 'editor',
            },
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        const middleware = requireRole('admin');
        middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({
          success: false,
          error: 'Insufficient permissions. Required role: admin',
        });
        expect(next).not.toHaveBeenCalled();
      });

      it('should allow admin role', () => {
        const req = createMockRequest({
          session: {
            admin: {
              id: 3,
              email: 'admin@example.com',
              role: 'admin',
            },
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        const middleware = requireRole('admin');
        middleware(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
      });
    });

    describe('authentication checks', () => {
      it('should return 401 when no session exists', () => {
        const req = createMockRequest({
          session: undefined,
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        const middleware = requireRole('admin');
        middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({
          success: false,
          error: 'Authentication required',
        });
        expect(next).not.toHaveBeenCalled();
      });

      it('should return 401 when admin session is null', () => {
        const req = createMockRequest({
          session: {
            admin: null,
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        const middleware = requireRole('admin');
        middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({
          success: false,
          error: 'Authentication required',
        });
        expect(next).not.toHaveBeenCalled();
      });

      it('should return 401 when admin session is undefined', () => {
        const req = createMockRequest({
          session: {
            admin: undefined,
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        const middleware = requireRole('viewer');
        middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({
          success: false,
          error: 'Authentication required',
        });
        expect(next).not.toHaveBeenCalled();
      });
    });

    describe('edge cases', () => {
      it('should handle all role combinations consistently', () => {
        const roles: AdminRole[] = ['viewer', 'editor', 'admin'];
        const roleHierarchy: Record<AdminRole, number> = {
          viewer: 1,
          editor: 2,
          admin: 3,
        };

        for (const userRole of roles) {
          for (const requiredRole of roles) {
            const req = createMockRequest({
              session: {
                admin: {
                  id: 1,
                  email: 'user@example.com',
                  role: userRole,
                },
              },
            }) as Request;
            const res = createMockResponse() as Response;
            const next = createMockNext();

            const middleware = requireRole(requiredRole);
            middleware(req, res, next);

            if (roleHierarchy[userRole] >= roleHierarchy[requiredRole]) {
              expect(next).toHaveBeenCalled();
            } else {
              expect(res.status).toHaveBeenCalledWith(403);
            }
          }
        }
      });
    });
  });

  describe('hasRole', () => {
    it('should return true when user has exact role', () => {
      expect(hasRole('admin', 'admin')).toBe(true);
      expect(hasRole('editor', 'editor')).toBe(true);
      expect(hasRole('viewer', 'viewer')).toBe(true);
    });

    it('should return true when user has higher role', () => {
      expect(hasRole('admin', 'editor')).toBe(true);
      expect(hasRole('admin', 'viewer')).toBe(true);
      expect(hasRole('editor', 'viewer')).toBe(true);
    });

    it('should return false when user has lower role', () => {
      expect(hasRole('viewer', 'editor')).toBe(false);
      expect(hasRole('viewer', 'admin')).toBe(false);
      expect(hasRole('editor', 'admin')).toBe(false);
    });

    it('should handle role hierarchy correctly', () => {
      // Role hierarchy: admin (3) > editor (2) > viewer (1)
      expect(hasRole('admin', 'admin')).toBe(true);
      expect(hasRole('admin', 'editor')).toBe(true);
      expect(hasRole('admin', 'viewer')).toBe(true);

      expect(hasRole('editor', 'admin')).toBe(false);
      expect(hasRole('editor', 'editor')).toBe(true);
      expect(hasRole('editor', 'viewer')).toBe(true);

      expect(hasRole('viewer', 'admin')).toBe(false);
      expect(hasRole('viewer', 'editor')).toBe(false);
      expect(hasRole('viewer', 'viewer')).toBe(true);
    });
  });

  describe('Preset middleware', () => {
    describe('requireAdmin', () => {
      it('should allow admin role', () => {
        const req = createMockRequest({
          session: {
            admin: {
              id: 1,
              email: 'admin@example.com',
              role: 'admin',
            },
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        requireAdmin(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
      });

      it('should reject editor role', () => {
        const req = createMockRequest({
          session: {
            admin: {
              id: 1,
              email: 'editor@example.com',
              role: 'editor',
            },
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        requireAdmin(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
      });

      it('should reject viewer role', () => {
        const req = createMockRequest({
          session: {
            admin: {
              id: 1,
              email: 'viewer@example.com',
              role: 'viewer',
            },
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        requireAdmin(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
      });
    });

    describe('requireEditor', () => {
      it('should allow admin role', () => {
        const req = createMockRequest({
          session: {
            admin: {
              id: 1,
              email: 'admin@example.com',
              role: 'admin',
            },
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        requireEditor(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
      });

      it('should allow editor role', () => {
        const req = createMockRequest({
          session: {
            admin: {
              id: 1,
              email: 'editor@example.com',
              role: 'editor',
            },
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        requireEditor(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
      });

      it('should reject viewer role', () => {
        const req = createMockRequest({
          session: {
            admin: {
              id: 1,
              email: 'viewer@example.com',
              role: 'viewer',
            },
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        requireEditor(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
      });
    });

    describe('requireViewer', () => {
      it('should allow admin role', () => {
        const req = createMockRequest({
          session: {
            admin: {
              id: 1,
              email: 'admin@example.com',
              role: 'admin',
            },
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        requireViewer(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
      });

      it('should allow editor role', () => {
        const req = createMockRequest({
          session: {
            admin: {
              id: 1,
              email: 'editor@example.com',
              role: 'editor',
            },
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        requireViewer(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
      });

      it('should allow viewer role', () => {
        const req = createMockRequest({
          session: {
            admin: {
              id: 1,
              email: 'viewer@example.com',
              role: 'viewer',
            },
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        requireViewer(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
      });

      it('should reject unauthenticated requests', () => {
        const req = createMockRequest({
          session: {
            admin: undefined,
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        requireViewer(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
      });
    });
  });
});
