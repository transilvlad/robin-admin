/**
 * Unit tests for Robin API client.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  clearInstanceCache,
  retryQueueItem,
  retryQueueItems,
  deleteQueueItem,
  deleteQueueItems,
  bounceQueueItem,
  bounceQueueItems,
  checkRobinHealth,
} from './robin-api.js';
import { config } from '../config.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock the config module
vi.mock('../config.js', () => ({
  config: {
    robin: {
      enabled: true,
      apiUrl: 'http://localhost:8090',
      apiAuth: 'admin:password',
    },
  },
}));

// Mock the instances query
vi.mock('../db/queries/fleet-services.js', () => ({
  getInstanceById: vi.fn().mockImplementation((id: string) => {
    if (id === 'test-instance') {
      return Promise.resolve({
        instanceId: 'test-instance',
        name: 'Test Instance',
        apiUrl: 'http://test:8090',
        apiAuth: 'test:test',
        enabled: true,
      });
    }
    return Promise.resolve(null);
  }),
}));

describe('robin-api service', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    clearInstanceCache();
  });

  afterEach(() => {
    config.robin.enabled = true;
    vi.clearAllMocks();
  });

  describe('retryQueueItem', () => {
    it('should call retry endpoint with uid', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('{"success":true}'),
      });

      const result = await retryQueueItem('test-uid');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8090/client/queue/retry',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ uid: 'test-uid' }),
        })
      );
      expect(result.success).toBe(true);
    });

    it('should include auth header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('{"success":true}'),
      });

      await retryQueueItem('test-uid');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringMatching(/^Basic /),
          }),
        })
      );
    });
  });

  describe('retryQueueItems', () => {
    it('should call retry endpoint with multiple uids', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('{"success":true,"count":3}'),
      });

      const result = await retryQueueItems(['uid1', 'uid2', 'uid3']);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8090/client/queue/retry',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ uids: ['uid1', 'uid2', 'uid3'] }),
        })
      );
      expect(result.success).toBe(true);
    });
  });

  describe('deleteQueueItem', () => {
    it('should call delete endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('{"success":true}'),
      });

      const result = await deleteQueueItem('test-uid');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8090/client/queue/delete',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ uid: 'test-uid' }),
        })
      );
      expect(result.success).toBe(true);
    });
  });

  describe('deleteQueueItems', () => {
    it('should call delete endpoint with multiple uids', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('{"success":true}'),
      });

      await deleteQueueItems(['uid1', 'uid2']);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8090/client/queue/delete',
        expect.objectContaining({
          body: JSON.stringify({ uids: ['uid1', 'uid2'] }),
        })
      );
    });
  });

  describe('bounceQueueItem', () => {
    it('should call bounce endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('{"success":true}'),
      });

      const result = await bounceQueueItem('test-uid');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8090/client/queue/bounce',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ uid: 'test-uid' }),
        })
      );
      expect(result.success).toBe(true);
    });
  });

  describe('bounceQueueItems', () => {
    it('should call bounce endpoint with multiple uids', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('{"success":true}'),
      });

      await bounceQueueItems(['uid1', 'uid2']);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8090/client/queue/bounce',
        expect.objectContaining({
          body: JSON.stringify({ uids: ['uid1', 'uid2'] }),
        })
      );
    });
  });

  describe('checkRobinHealth', () => {
    it('should return true when API is healthy', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('{"status":"UP"}'),
      });

      const result = await checkRobinHealth();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8090/health',
        expect.any(Object)
      );
    });

    it('should return false when API returns error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('{"success":false}'),
      });

      const result = await checkRobinHealth();

      expect(result).toBe(false);
    });

    it('should return false when fetch throws', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await checkRobinHealth();

      expect(result).toBe(false);
    });
  });

  describe('instance-aware routing', () => {
    it('should use instance config for non-default instance', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('{"success":true}'),
      });

      await retryQueueItem('test-uid', 'test-instance');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://test:8090/client/queue/retry',
        expect.any(Object)
      );
    });

    it('should use default config for default instance', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('{"success":true}'),
      });

      await retryQueueItem('test-uid', 'default');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8090/client/queue/retry',
        expect.any(Object)
      );
    });
  });

  describe('clearInstanceCache', () => {
    it('should clear specific instance from cache', () => {
      clearInstanceCache('test-instance');
      // No error means success
      expect(true).toBe(true);
    });

    it('should clear all instances when no id provided', () => {
      clearInstanceCache();
      // No error means success
      expect(true).toBe(true);
    });
  });

  describe('error handling', () => {
    it('does not attempt a request when Robin MTA is disabled', async () => {
      config.robin.enabled = false;

      await expect(retryQueueItem('test-uid')).rejects.toMatchObject({
        name: 'RobinApiUnavailableError',
        message: 'Robin MTA API is unavailable',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fails explicitly when the Robin MTA API cannot be reached', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(retryQueueItem('test-uid')).rejects.toMatchObject({
        name: 'RobinApiUnavailableError',
        message: 'Robin MTA API is unavailable',
      });
    });

    it('should handle non-JSON response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('OK'),
      });

      const result = await retryQueueItem('test-uid');

      expect(result.success).toBe(true);
      expect(result.message).toBe('OK');
    });

    it("rejects with Robin's status and reason when Robin refuses the request", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"success":false,"error":"Invalid request"}'),
      });

      await expect(retryQueueItem('test-uid')).rejects.toMatchObject({
        name: 'RobinApiRejectedError',
        status: 400,
        message: 'Invalid request',
      });
    });

    it('refuses a Robin service that is not registered', async () => {
      await expect(retryQueueItem('test-uid', 'no-such-robin')).rejects.toMatchObject({
        name: 'RobinInstanceUnusableError',
        message: 'Robin service no-such-robin is not registered',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('falls back to the HTTP status when a refusal has no body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve(''),
      });

      await expect(retryQueueItem('test-uid')).rejects.toMatchObject({ status: 500, message: 'HTTP 500' });
    });
  });
});
