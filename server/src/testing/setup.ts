/**
 * Test setup file.
 * Runs before all tests to configure mocks and global state.
 */

import { vi } from 'vitest';

// Mock environment variables
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-key-for-testing-only';
process.env.ROBIN_ADMIN_ENCRYPTION_KEY = 'test-encryption-key-for-testing-only-0123456789';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ROBIN_API_URL = 'http://localhost:8090';

// Mock logger to avoid noise in tests
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));
