/**
 * Robin MTA API client for queue operations.
 * 
 * Supports fleet management with instance-aware API calls.
 * When instanceId is provided, config is loaded from the database.
 * Falls back to environment config for the default instance.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import { getInstanceById, RobinInstance } from '../db/queries/fleet-services.js';

interface RobinApiResponse {
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}

export class RobinApiUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Robin MTA API is unavailable');
    this.name = 'RobinApiUnavailableError';
    this.cause = cause;
  }
}

/** Robin answered but refused the request (non-2xx). */
export class RobinApiRejectedError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'RobinApiRejectedError';
  }
}

/** The requested Robin service can't be used: unknown, or disabled in Fleet. */
export class RobinInstanceUnusableError extends Error {
  constructor(readonly instanceId: string, reason: 'not registered' | 'disabled') {
    super(`Robin service ${instanceId} is ${reason}`);
    this.name = 'RobinInstanceUnusableError';
  }
}

export class RobinManagementConfigurationError extends Error {}

export function robinAuthHeaders(apiAuth = config.robin.apiAuth): Record<string, string> {
  return apiAuth ? { Authorization: `Basic ${Buffer.from(apiAuth).toString('base64')}` } : {};
}

/**
 * The HTTP answer for a Robin API failure, or null for any other error:
 * 503 when Robin can't be reached, 502 with Robin's reason when it refused.
 */
export function robinApiFailure(error: unknown, unavailableMessage: string): { status: number; error: string } | null {
  if (error instanceof RobinApiUnavailableError) {
    return { status: 503, error: unavailableMessage };
  }
  if (error instanceof RobinInstanceUnusableError) {
    return { status: 400, error: error.message };
  }
  if (error instanceof RobinManagementConfigurationError) {
    return { status: 400, error: error.message };
  }
  if (error instanceof RobinApiRejectedError) {
    return { status: 502, error: `Robin rejected the request (HTTP ${error.status}): ${error.message}` };
  }
  return null;
}

// Instance config cache (5 minute TTL)
const instanceCache = new Map<string, { instance: RobinInstance; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000;

function assertRobinApiEnabled(): void {
  if (config.robin.enabled === false) {
    throw new RobinApiUnavailableError(new Error('Robin MTA API is disabled by configuration'));
  }
}

/**
 * Get instance config, using cache when available.
 */
async function getInstanceConfig(instanceId?: string): Promise<{ apiUrl: string; apiAuth?: string }> {
  assertRobinApiEnabled();
  // Default instance uses environment config
  if (!instanceId || instanceId === 'default') {
    return {
      apiUrl: config.robin.apiUrl,
      apiAuth: config.robin.apiAuth,
    };
  }

  // Check cache
  const cached = instanceCache.get(instanceId);
  if (cached && cached.expires > Date.now()) {
    return {
      apiUrl: cached.instance.apiUrl,
      apiAuth: cached.instance.apiAuth || undefined,
    };
  }

  // Load from database
  const instance = await getInstanceById(instanceId);
  if (!instance || !instance.enabled) {
    throw new RobinInstanceUnusableError(instanceId, instance ? 'disabled' : 'not registered');
  }

  // Cache it
  instanceCache.set(instanceId, {
    instance,
    expires: Date.now() + CACHE_TTL,
  });

  return {
    apiUrl: instance.apiUrl,
    apiAuth: instance.apiAuth || undefined,
  };
}

/**
 * Clear instance config cache (call when instance is updated).
 */
export function clearInstanceCache(instanceId?: string): void {
  if (instanceId) {
    instanceCache.delete(instanceId);
  } else {
    instanceCache.clear();
  }
}

/**
 * Force Robin to re-pull its database-backed config and hot-reload it.
 *
 * Robin is self-syncing: it reads its own config from the DB via its
 * ConfigStoreSyncManager. `POST /config/reload` triggers that pull + reload
 * The response must explicitly confirm application. This endpoint lives on Robin's **Service API**
 * (ROBIN_METRICS_URL), not the Client API (apiUrl) used for queue/send.
 */
export async function reloadRobinConfig(
  instanceId?: string,
): Promise<{ ok: boolean; status: number; body: unknown; url: string }> {
  return robinManagementRequest('/config/reload', 'POST', instanceId);
}

export async function getRobinConfigStatus(
  instanceId?: string,
): Promise<{ ok: boolean; status: number; body: unknown; url: string }> {
  return robinManagementRequest('/config/status', 'GET', instanceId);
}

async function robinManagementRequest(
  path: '/config/reload' | '/config/status',
  method: 'GET' | 'POST',
  instanceId?: string,
): Promise<{ ok: boolean; status: number; body: unknown; url: string }> {
  assertRobinApiEnabled();
  let base = process.env.ROBIN_METRICS_URL || 'http://localhost:8080';
  let apiAuth = config.robin.apiAuth;
  if (instanceId && instanceId !== 'default') {
    const instance = await getInstanceById(instanceId);
    if (!instance || !instance.enabled) {
      throw new RobinInstanceUnusableError(instanceId, instance ? 'disabled' : 'not registered');
    }
    if (!instance.metricsUrl) {
      throw new RobinManagementConfigurationError('The selected Robin service has no management metrics URL');
    }
    base = instance.metricsUrl;
    apiAuth = instance.apiAuth || undefined;
  }
  if (!apiAuth || !/^[^:]+:.+$/.test(apiAuth)) {
    throw new RobinManagementConfigurationError('Configure ROBIN_API_AUTH to match authenticated Robin management endpoints');
  }
  let endpoint: URL;
  try { endpoint = new URL(base); }
  catch { throw new RobinManagementConfigurationError('Robin management URL must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new RobinManagementConfigurationError('Robin management URL must use HTTP(S) without embedded credentials');
  }
  if (endpoint.search || endpoint.hash) {
    throw new RobinManagementConfigurationError('Robin management base URL must not include a query or fragment');
  }
  const url = `${base.replace(/\/$/, '')}${path}`;
  let res: globalThis.Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...robinAuthHeaders(apiAuth),
      },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
  } catch (error) {
    logger.warn('Robin configuration management request failed', {
      instanceId,
      path,
      error: (error as Error).message,
    });
    throw new RobinApiUnavailableError(error);
  }
  let body: unknown;
  try { body = await res.json(); }
  catch {
    throw new RobinApiRejectedError(res.status, 'Robin returned an invalid management response; application is unconfirmed');
  }
  return { ok: res.ok, status: res.status, body, url };
}

/**
 * Make a request to the Robin API.
 * 
 * @param endpoint - API endpoint (e.g., '/client/queue/retry')
 * @param options - Fetch options
 * @param instanceId - Optional instance ID for fleet-aware routing
 */
async function robinFetch(
  endpoint: string,
  options: RequestInit = {},
  instanceId?: string
): Promise<RobinApiResponse> {
  const instanceConfig = await getInstanceConfig(instanceId);
  const url = `${instanceConfig.apiUrl}${endpoint}`;
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers as Record<string, string>,
  };
  
  // Add basic auth if configured
  if (instanceConfig.apiAuth) {
    Object.assign(headers, robinAuthHeaders(instanceConfig.apiAuth));
  }
  
  let response: globalThis.Response;
  let text: string;
  try {
    response = await fetch(url, {
      ...options,
      headers,
    });
    text = await response.text();
  } catch (error) {
    logger.error('Robin API request failed', {
      endpoint,
      instanceId,
      error: (error as Error).message
    });
    throw new RobinApiUnavailableError(error);
  }

  let data: RobinApiResponse;
  try {
    data = JSON.parse(text);
  } catch {
    data = { success: response.ok, message: text };
  }

  if (!response.ok) {
    const reason = String(data.error || data.message || text || `HTTP ${response.status}`).slice(0, 300);
    logger.warn('Robin API error', {
      endpoint,
      instanceId,
      status: response.status,
      error: reason,
    });
    throw new RobinApiRejectedError(response.status, reason);
  }

  return data;
}

/**
 * Retry a queue item.
 */
export async function retryQueueItem(uid: string, instanceId?: string): Promise<RobinApiResponse> {
  return robinFetch('/client/queue/retry', {
    method: 'POST',
    body: JSON.stringify({ uid }),
  }, instanceId);
}

/**
 * Retry multiple queue items.
 */
export async function retryQueueItems(uids: string[], instanceId?: string): Promise<RobinApiResponse> {
  return robinFetch('/client/queue/retry', {
    method: 'POST',
    body: JSON.stringify({ uids }),
  }, instanceId);
}

/**
 * Delete a queue item.
 */
export async function deleteQueueItem(uid: string, instanceId?: string): Promise<RobinApiResponse> {
  return robinFetch('/client/queue/delete', {
    method: 'POST',
    body: JSON.stringify({ uid }),
  }, instanceId);
}

/**
 * Delete multiple queue items.
 */
export async function deleteQueueItems(uids: string[], instanceId?: string): Promise<RobinApiResponse> {
  return robinFetch('/client/queue/delete', {
    method: 'POST',
    body: JSON.stringify({ uids }),
  }, instanceId);
}

/**
 * Bounce a queue item.
 */
export async function bounceQueueItem(uid: string, instanceId?: string): Promise<RobinApiResponse> {
  return robinFetch('/client/queue/bounce', {
    method: 'POST',
    body: JSON.stringify({ uid }),
  }, instanceId);
}

/**
 * Bounce multiple queue items.
 */
export async function bounceQueueItems(uids: string[], instanceId?: string): Promise<RobinApiResponse> {
  return robinFetch('/client/queue/bounce', {
    method: 'POST',
    body: JSON.stringify({ uids }),
  }, instanceId);
}

/**
 * Check Robin API health for a specific instance.
 */
export async function checkRobinHealth(instanceId?: string): Promise<boolean> {
  try {
    const response = await robinFetch('/health', {}, instanceId);
    return response.success !== false;
  } catch {
    return false;
  }
}

/**
 * Queue an email for delivery via Robin's client/queue endpoint.
 */
export async function queueEmail(casePayload: Record<string, unknown>, instanceId?: string): Promise<RobinApiResponse> {
  return robinFetch('/client/queue', {
    method: 'POST',
    body: JSON.stringify(casePayload),
  }, instanceId);
}

/**
 * Queue a raw RFC822 message for delivery via Robin's client/queue endpoint.
 */
export async function queueRawEmail(input: {
  mail: string;
  rcpt: string[];
  message: string;
  protocol?: string;
}, instanceId?: string): Promise<RobinApiResponse> {
  const params = new URLSearchParams({
    mail: input.mail,
    rcpt: input.rcpt.join(','),
    protocol: input.protocol ?? 'ESMTP',
  });
  return robinFetch(`/client/queue?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: input.message,
  }, instanceId);
}

/**
 * Send an email immediately via Robin's client/send endpoint.
 */
export async function sendEmail(casePayload: Record<string, unknown>, instanceId?: string): Promise<RobinApiResponse> {
  return robinFetch('/client/send', {
    method: 'POST',
    body: JSON.stringify(casePayload),
  }, instanceId);
}
