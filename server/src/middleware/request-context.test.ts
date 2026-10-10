import { describe, expect, it, vi } from 'vitest';
import { requestContext } from './request-context.js';
import { logger } from '../logger.js';

describe('requestContext', () => {
  it('accepts safe request IDs and emits structured completion metadata', () => {
    let finish: (() => void) | undefined;
    const req = {
      header: vi.fn().mockReturnValue('edge-request-123'),
      method: 'GET',
      originalUrl: '/api/users?secret=hidden',
    } as any;
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      on: vi.fn((_event, callback) => { finish = callback; }),
    } as any;
    const next = vi.fn();

    requestContext(req, res, next);
    finish?.();

    expect(req.requestId).toBe('edge-request-123');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', 'edge-request-123');
    expect(logger.info).toHaveBeenCalledWith('HTTP request completed', expect.objectContaining({
      requestId: 'edge-request-123',
      path: '/api/users',
      status: 200,
    }));
    expect(next).toHaveBeenCalledOnce();
  });

  it('replaces unsafe request IDs', () => {
    const req = {
      header: vi.fn().mockReturnValue('unsafe request id'),
      method: 'GET',
      originalUrl: '/health/live',
    } as any;
    const res = { statusCode: 200, setHeader: vi.fn(), on: vi.fn() } as any;

    requestContext(req, res, vi.fn());

    expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs slow requests as warnings, except the agent command long-poll', () => {
    const run = (path: string) => {
      let finish: (() => void) | undefined;
      const req = { header: vi.fn().mockReturnValue(undefined), method: 'GET', originalUrl: path } as any;
      const res = { statusCode: 200, setHeader: vi.fn(), on: vi.fn((_event, callback) => { finish = callback; }) } as any;
      const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(25_000);
      requestContext(req, res, vi.fn());
      finish?.();
      now.mockRestore();
    };
    vi.mocked(logger.warn).mockClear();

    run('/api/fleet/agent/commands?actions=a&ack=');
    expect(logger.warn).not.toHaveBeenCalled();

    run('/api/users');
    expect(logger.warn).toHaveBeenCalledWith('HTTP request completed', expect.objectContaining({ path: '/api/users', durationMs: 25_000 }));
  });
});
