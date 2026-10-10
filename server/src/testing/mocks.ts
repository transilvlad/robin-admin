/**
 * Mock database utilities for testing.
 */

import { vi } from 'vitest';

export interface MockQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

interface MockPool {
  query: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

/**
 * Create a mock pool with configurable query responses.
 */
export function createMockPool(
  responses: Map<string, MockQueryResult> = new Map(),
): MockPool {
  const mockQuery = vi.fn(async (sql: string, _params?: unknown[]) => {
    // Find a matching response by checking if query contains key
    for (const [key, result] of responses) {
      if (sql.toLowerCase().includes(key.toLowerCase())) {
        return result;
      }
    }
    return { rows: [], rowCount: 0 };
  });

  return {
    query: mockQuery,
    connect: vi.fn().mockResolvedValue({
      query: mockQuery,
      release: vi.fn(),
    }),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Mock request object for route testing.
 */
export function createMockRequest(overrides: Partial<{
  body: Record<string, unknown>;
  params: Record<string, string>;
  query: Record<string, string>;
  session: Record<string, unknown>;
  user: { id: number; email: string; role: string };
}> = {}) {
  return {
    body: {},
    params: {},
    query: {},
    session: { userId: 1 },
    user: { id: 1, email: 'admin@example.com', role: 'admin' },
    ...overrides,
  };
}

/**
 * Mock response object for route testing.
 */
export function createMockResponse() {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.cookie = vi.fn().mockReturnValue(res);
  res.clearCookie = vi.fn().mockReturnValue(res);
  return res as {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    cookie: ReturnType<typeof vi.fn>;
    clearCookie: ReturnType<typeof vi.fn>;
  };
}
