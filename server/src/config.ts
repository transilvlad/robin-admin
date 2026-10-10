/**
 * Environment configuration for Robin Admin server.
 */

export interface Config {
  // Database
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    poolMax: number;
    poolMin: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
    statementTimeoutMillis: number;
    idleInTransactionSessionTimeoutMillis: number;
  };
  // Robin API
  robin: {
    enabled: boolean;
    apiUrl: string;
    apiAuth?: string;
  };
  // Server
  port: number;
  host: string;
  nodeEnv: string;
  /** Trusted browser-facing origin/path used in links sent by email. */
  publicBaseUrl: string;
  // Session
  sessionSecret: string;
  cookieDomain: string;
  cookiePath: string;
  cookieSecure: boolean;
  allowedOrigins: string[];
  bodyLimit: string;
  // Rate limiting
  rateLimit: {
    windowMs: number;
    maxRequests: number;
    loginMaxRequests: number;
  };
  /** ROBIN_ADMIN_ENCRYPTION_KEY is set: every stored secret needs it. */
  encryptionKeyConfigured: boolean;
  // Logging
  logLevel: string;
  // 'external' when the host rotates the log files (logrotate); 'size'
  // (default) when the app rotates them itself at 5 MB.
  logFileRotation: 'size' | 'external';
  // Robin Sheriff
  sheriff: {
    baseUrl: string;
    rootPublicKeyPem: string;
  };
  telemetry: {
    storeUrl: string;
  };
  moduleInstaller: {
    url: string;
    signingSecret: string;
  };
  moduleProxySecrets: Record<string, string>;
  // Bootstrap-installed modules provided by deployment config
  modulesBootstrap: Array<{
    moduleSlug: string;
    remoteEntryUrl: string;
    install?: boolean;
    installedVersion?: string;
    probeUrl?: string;
    backendUrl?: string;
    assetBaseUrl?: string;
    remoteScope?: string;
    exposedModule?: string;
    installedSource?: string;
    notes?: string;
    displayName?: string;
    description?: string;
    vendorName?: string;
    tier?: 'free' | 'paid';
    latestVersion?: string;
    remoteEntryPath?: string;
    routeSlug?: string;
    iconName?: string;
    sortOrder?: number;
    metadata?: Record<string, unknown>;
    moduleDefinition?: Record<string, unknown>;
  }>;
}

const sessionSecret = getEnv('SESSION_SECRET', 'dev-secret-change-in-production');

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid integer for environment variable: ${key}`);
  }
  return parsed;
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  return value.toLowerCase() === 'true' || value === '1';
}

function getEnvOptional(key: string): string | undefined {
  return process.env[key];
}

function getSheriffUrl(): string {
  const url = new URL(getEnv('SHERIFF_BASE_URL', 'https://sheriff.robinmta.com'));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('SHERIFF_BASE_URL must be an HTTP(S) origin without credentials, query, or path.');
  }
  return url.origin;
}

function getCookiePath(): string {
  const path = getEnv('COOKIE_PATH', '/');
  if (!path.startsWith('/')) {
    throw new Error('COOKIE_PATH must start with "/"');
  }
  return path;
}

function getPublicBaseUrl(): string {
  const value = getEnv('ROBIN_ADMIN_PUBLIC_URL', 'https://localhost:3443').trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('ROBIN_ADMIN_PUBLIC_URL must be an absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('ROBIN_ADMIN_PUBLIC_URL must use http or https');
  }
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

function getEnvJsonArray<T>(key: string): T[] {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch (error) {
    throw new Error(`Invalid JSON array for environment variable: ${key} (${(error as Error).message})`);
  }
}

function getEnvJsonRecord(key: string): Record<string, string> {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON object for environment variable: ${key} (${(error as Error).message})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${key} must be a JSON object`);
  }

  const result: Record<string, string> = {};
  for (const [moduleSlug, secret] of Object.entries(parsed)) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(moduleSlug) || typeof secret !== 'string' || secret.length < 32) {
      throw new Error(`${key} contains an invalid module slug or a secret shorter than 32 characters`);
    }
    result[moduleSlug] = secret;
  }
  return result;
}

export const config: Config = {
  postgres: {
    host: getEnv('DB_HOST', 'localhost'),
    port: getEnvInt('DB_PORT', 5432),
    database: getEnv('DB_NAME', 'robin'),
    user: getEnv('DB_USER', 'robin'),
    password: getEnv('DB_PASSWORD', 'robin'),
    poolMax: getEnvInt('DB_POOL_MAX', 30),
    poolMin: getEnvInt('DB_POOL_MIN', 4),
    idleTimeoutMillis: getEnvInt('DB_IDLE_TIMEOUT_MS', 60000),
    connectionTimeoutMillis: getEnvInt('DB_CONNECTION_TIMEOUT_MS', 10000),
    // Backstop against a stuck/runaway query or an abandoned open transaction
    // silently holding a pool slot forever (a hung statement never released
    // the client back to the pool because nothing ever errored it out).
    statementTimeoutMillis: getEnvInt('DB_STATEMENT_TIMEOUT_MS', 30000),
    idleInTransactionSessionTimeoutMillis: getEnvInt('DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', 30000),
  },
  robin: {
    enabled: getEnvBool('ROBIN_API_ENABLED', true),
    apiUrl: getEnv('ROBIN_API_URL', 'http://localhost:8090'),
    apiAuth: process.env.ROBIN_API_AUTH,
  },
  port: getEnvInt('PORT', 3000),
  // Preserves current behavior (0.0.0.0) for every deployment that doesn't
  // set HOST — Docker in particular needs it to stay reachable through the
  // container's port mapping. Deployments that front this with a reverse
  // proxy on the same host can set HOST=127.0.0.1 to stop relying on the
  // firewall alone to keep the admin API off the public interface.
  host: getEnv('HOST', '0.0.0.0'),
  nodeEnv: getEnv('NODE_ENV', 'development'),
  publicBaseUrl: getPublicBaseUrl(),
  sessionSecret,
  cookieDomain: getEnv('COOKIE_DOMAIN', 'localhost'),
  cookiePath: getCookiePath(),
  cookieSecure: getEnvBool('COOKIE_SECURE', (process.env.NODE_ENV || 'development') === 'production'),
  allowedOrigins: getEnv('ALLOWED_ORIGINS', '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  bodyLimit: getEnv('BODY_LIMIT', '50mb'),
  rateLimit: {
    windowMs: getEnvInt('RATE_LIMIT_WINDOW_MS', 60000),
    maxRequests: getEnvInt('RATE_LIMIT_MAX_REQUESTS', 100),
    loginMaxRequests: getEnvInt('LOGIN_RATE_LIMIT_MAX', 5),
  },
  encryptionKeyConfigured: (getEnvOptional('ROBIN_ADMIN_ENCRYPTION_KEY')?.trim().length ?? 0) >= 32,
  logLevel: getEnv('LOG_LEVEL', 'info'),
  logFileRotation: getEnv('LOG_FILE_ROTATION', 'size') === 'external' ? 'external' : 'size',
  sheriff: {
    baseUrl: getSheriffUrl(),
    rootPublicKeyPem: getEnv('SHERIFF_ROOT_PUBLIC_KEY_PEM', '').replace(/\\n/g, '\n').trim(),
  },
  telemetry: {
    // Infrastructure coordinate of the bundled VictoriaMetrics store (role alias
    // metrics-backend). Trusted like DB_HOST: host-networked installs set a
    // loopback address here.
    storeUrl: getEnv('TELEMETRY_STORE_URL', 'http://metrics-backend:8428').trim().replace(/\/+$/, ''),
  },
  moduleInstaller: {
    url: getEnv('MODULE_INSTALLER_URL', 'http://installer-backend:3041'),
    signingSecret: getEnvOptional('MODULE_INSTALLER_SIGNING_SECRET') ?? '',
  },
  moduleProxySecrets: getEnvJsonRecord('MODULE_PROXY_SECRETS_JSON'),
  modulesBootstrap: getEnvJsonArray<Config['modulesBootstrap'][number]>('MODULES_BOOTSTRAP_JSON'),
};
