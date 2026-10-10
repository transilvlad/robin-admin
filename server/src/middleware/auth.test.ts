/**
 * Tests for authentication middleware.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import {
  requireAuth,
  getCurrentAdmin,
} from './auth.js';

// Create mock request with proper typing
function createMockRequest(overrides: Partial<Request> = {}): Partial<Request> {
  return {
    session: {
      admin: undefined,
    },
    headers: {},
    socket: {
      remoteAddress: '192.168.1.1',
    } as any,
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

describe('Authentication Middleware', () => {
  describe('requireAuth', () => {
    it('should call next() when admin session exists', () => {
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

      requireAuth(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should return 401 when no admin session exists', () => {
      const req = createMockRequest({
        session: {
          admin: undefined,
        },
      }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Authentication required',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 when session exists but admin is null', () => {
      const req = createMockRequest({
        session: {
          admin: null,
        },
      }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Authentication required',
      });
      expect(next).not.toHaveBeenCalled();
    });



    it('should work with different admin roles', () => {
      const roles = ['viewer', 'editor', 'admin'] as const;

      for (const role of roles) {
        const req = createMockRequest({
          session: {
            admin: {
              id: 1,
              email: 'user@example.com',
              role,
            },
          },
        }) as Request;
        const res = createMockResponse() as Response;
        const next = createMockNext();

        requireAuth(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      }
    });
  });

  describe('getCurrentAdmin', () => {
    it('should return admin data when session exists', () => {
      const req = createMockRequest({
        session: {
          admin: {
            id: 42,
            uid: 'aee695ef-d8d7-4e15-a27e-e47e9b2b0ce4',
            email: 'test@example.com',
            role: 'editor',
          },
        },
      }) as Request;

      const result = getCurrentAdmin(req);

      expect(result).toEqual({
        adminId: 42,
        uid: 'aee695ef-d8d7-4e15-a27e-e47e9b2b0ce4',
        email: 'test@example.com',
        role: 'editor',
      });
    });

    it('should return null when no admin session exists', () => {
      const req = createMockRequest({
        session: {
          admin: undefined,
        },
      }) as Request;

      const result = getCurrentAdmin(req);

      expect(result).toBeNull();
    });

    it('should return null when admin is null', () => {
      const req = createMockRequest({
        session: {
          admin: null,
        },
      }) as Request;

      const result = getCurrentAdmin(req);

      expect(result).toBeNull();
    });

    it('should return null when session does not exist', () => {
      const req = createMockRequest({
        session: undefined,
      }) as Request;

      const result = getCurrentAdmin(req);

      expect(result).toBeNull();
    });

    it('should preserve all admin fields correctly', () => {
      const req = createMockRequest({
        session: {
          admin: {
            id: 123,
            email: 'admin@company.com',
            role: 'admin',
          },
        },
      }) as Request;

      const result = getCurrentAdmin(req);

      expect(result?.adminId).toBe(123);
      expect(result?.email).toBe('admin@company.com');
      expect(result?.role).toBe('admin');
    });
  });
});
