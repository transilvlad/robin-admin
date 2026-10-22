/**
 * Robin Admin API Server entry point.
 * 
 * This is the main Express server that provides the REST API for Robin Admin.
 * 
 * Architecture:
 * - Express.js with TypeScript
 * - PostgreSQL database (shared with Robin MTA)
 * - Session storage via connect-pg-simple
 * - Session-cookie authentication for browser users
 * - Scoped API-key authentication for automations
 * 
 * Security:
 * - Helmet for security headers
 * - CORS configured for frontend access
 * - Rate limiting and persistent login lockout on sensitive endpoints
 * - CSRF protection for browser writes
 * - Configurable IP restrictions and authenticated report ingestion
 * 
 * Operational notes:
 * - Terminate HTTPS at the reverse proxy.
 * - Set SESSION_SECRET in production.
 * - Report ingestion endpoints (/dmarc, /tlsrpt, /forensic) accept trusted
 *   ingestion CIDRs, reports:ingest API keys, or shared secrets.
 */

import express, { type Request } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import pg from 'pg';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import { config } from './config.js';
import { logger } from './logger.js';
import { testConnection, closePool } from './db/connection.js';
import { initializeSchema } from './db/schema.js';
import { getConfig, startReportingMaintenanceScheduler, stopReportingMaintenanceScheduler } from './db/queries/config.js';
import { attachApiKey, csrfProtection, enforceIpJail, enforceIpRestrictions, enforceSessionPolicy, getTrustedClientIp, isLoopbackConnection, parseList } from './middleware/security.js';
import { requestContext } from './middleware/request-context.js';

// Routes
import authRoutes from './routes/auth.js';
import setupRoutes from './routes/setup.js';
import adminsRoutes from './routes/admins.js';
import usersRoutes from './routes/users.js';
import aliasesRoutes from './routes/aliases.js';
import queueRoutes from './routes/queue.js';
import auditRoutes from './routes/audit.js';
import dashboardRoutes from './routes/dashboard.js';
import dmarcRoutes from './routes/dmarc.js';
import tlsrptRoutes from './routes/tlsrpt.js';
import forensicRoutes from './routes/forensic.js';
import configRoutes from './routes/config.js';
import profileRoutes from './routes/profile.js';
import robinConfigRoutes from './routes/robin-config.js';
import robinRoutes from './routes/robin.js';
import metricsRoutes from './routes/metrics.js';
import fleetServicesRoutes from './routes/fleet-services.js';
import fleetCapabilitiesRoutes from './routes/fleet-capabilities.js';
import fleetAgentRoutes from './routes/fleet-agent.js';
import fleetAgentsRoutes from './routes/fleet-agents.js';
import reportingRoutes from './routes/reporting.js';
import apiKeyRoutes from './routes/api-keys.js';
import ipJailRoutes from './routes/ip-jail.js';
import rspamdRoutes from './routes/rspamd.js';
import clamavRoutes from './routes/clamav.js';
import cyrusRoutes from './routes/cyrus.js';
import dovecotRoutes from './routes/dovecot.js';
import postfixRoutes from './routes/postfix.js';
import redisRoutes from './routes/redis.js';
import postgresRoutes from './routes/postgres.js';
import mariadbRoutes from './routes/mariadb.js';
import logsRoutes from './routes/logs.js';
import modulesRoutes from './routes/modules.js';
import moduleIdentityRoutes from './routes/module-identity.js';
import moduleBackendRoutes, { moduleAssetRoutes } from './routes/module-backends.js';
import moduleDirectoryRoutes from './routes/module-directory.js';
import { moduleRequestBody } from './middleware/module-body.js';
import { requireAuth } from './middleware/auth.js';
import { requireViewer } from './middleware/rbac.js';
import { publishModuleIdentityTrust } from './services/module-identity.js';
import healthRoutes from './routes/health.js';
import alertingRoutes from './routes/alerting.js';
import monitoringRoutes from './routes/monitoring.js';
import monitoringPingRoutes from './routes/monitoring-ping.js';
import statusPageRoutes from './routes/status-page.js';
import telemetryRoutes from './routes/telemetry.js';
import telemetrySettingsRoutes from './routes/telemetry-settings.js';
import emailRoutes from './routes/email.js';

// Services
import { startMetricsPoller, stopMetricsPoller } from './services/metrics-poller.js';
import { startAlertDeliveryWorker, stopAlertDeliveryWorker } from './services/alerts/delivery-worker.js';
import { startAlertScheduler, stopAlertScheduler } from './services/alerts/scheduler.js';
import { startTelemetryRuleScheduler, stopTelemetryRuleScheduler } from './services/alerts/telemetry-rule-scheduler.js';
import { reportIngestionBody } from './middleware/report-ingestion-body.js';
import { startMonitoringScheduler, stopMonitoringScheduler } from './services/monitoring/scheduler.js';
import { startMonitoringHeartbeats, stopMonitoringHeartbeats } from './services/monitoring/heartbeat.js';
import { startConfigChangeListener, stopConfigChangeListener } from './services/config-change-listener.js';
import { startEmailDeliveryWorker, stopEmailDeliveryWorker } from './services/email/delivery-worker.js';
import { warmReportingCache } from './services/reporting-warmup.js';
import { startRspamdMaintenance, stopRspamdMaintenance } from './services/rspamd.js';
import { runAsLeader, releaseLeaderLock } from './services/leader-lock.js';
import { closeRedisClients } from './services/redis.js';
import { closePostgresPools } from './services/postgres.js';
import { closeMariadbPools } from './services/mariadb.js';
import {
  bootstrapInstalledModulesFromConfig,
} from './services/modules.js';
import * as Sentry from '@sentry/node';
import { bootstrapFleetAgentsFromConfig } from './services/fleet-agent-bootstrap.js';
import { bootstrapFleetServicesFromConfig } from './services/fleet-service-bootstrap.js';

const app = express();

// Shipped as the docker-compose.yaml fallback for the bundled suite-agent so
// local/dev deployments work with zero setup — never a real credential, and
// must never be provisioned into a production database.
const KNOWN_DEMO_AGENT_CREDENTIALS = new Set(['dev-suite-agent-credential-6a1f8c3e5b7d2094']);
const DEFAULT_POSTGRES_PASSWORDS = new Set(['', 'robin', 'postgres', 'password', 'changeme', 'change-me']);

function looksLikePlaceholderSecret(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return true;
  return normalized.includes('change-this')
    || normalized.includes('change-me')
    || normalized.includes('replace-with')
    || normalized.includes('placeholder')
    || normalized.includes('example')
    || normalized.includes('dev-secret');
}

function usesKnownDemoAgentCredential(): boolean {
  const raw = process.env.FLEET_AGENTS_BOOTSTRAP_JSON?.trim();
  if (!raw) {
    return false;
  }
  try {
    const entries = JSON.parse(raw);
    return Array.isArray(entries)
      && entries.some((entry) => KNOWN_DEMO_AGENT_CREDENTIALS.has(entry?.credential));
  } catch {
    // Malformed JSON is handled (and logged) by bootstrapFleetAgentsFromConfig.
    return false;
  }
}

function usesPlaceholderAgentCredential(): boolean {
  const raw = process.env.FLEET_AGENTS_BOOTSTRAP_JSON?.trim();
  if (!raw) {
    return process.env.SUITE_AGENT_CREDENTIAL !== undefined
      && looksLikePlaceholderSecret(process.env.SUITE_AGENT_CREDENTIAL);
  }
  try {
    const entries = JSON.parse(raw);
    return Array.isArray(entries)
      && entries.some((entry) => looksLikePlaceholderSecret(entry?.credential));
  } catch {
    // Malformed JSON is handled (and logged) by bootstrapFleetAgentsFromConfig.
    return false;
  }
}

function assertProductionSecrets() {
  if (config.nodeEnv !== 'production') {
    return;
  }

  const missingOrDefault = [
    looksLikePlaceholderSecret(config.sessionSecret)
      ? 'SESSION_SECRET'
      : null,
    DEFAULT_POSTGRES_PASSWORDS.has(config.postgres.password.trim().toLowerCase())
      ? 'DB_PASSWORD'
      : null,
    !config.cookieSecure
      ? 'COOKIE_SECURE'
      : null,
    config.modulesBootstrap.some((moduleEntry) => Boolean(moduleEntry.backendUrl))
      && (Object.keys(config.moduleProxySecrets).length === 0
        || Object.values(config.moduleProxySecrets).some(looksLikePlaceholderSecret))
      ? 'MODULE_PROXY_SECRETS_JSON'
      : null,
    !config.encryptionKeyConfigured
      ? 'ROBIN_ADMIN_ENCRYPTION_KEY'
      : null,
    !process.env.ROBIN_ADMIN_PUBLIC_URL?.trim()
      || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/.test(config.publicBaseUrl)
      ? 'ROBIN_ADMIN_PUBLIC_URL'
      : null,
    usesKnownDemoAgentCredential() || usesPlaceholderAgentCredential() ? 'FLEET_AGENTS_BOOTSTRAP_JSON/SUITE_AGENT_CREDENTIAL' : null,
  ].filter(Boolean);

  if (missingOrDefault.length > 0) {
    throw new Error(`Refusing to start with missing/default production secret(s): ${missingOrDefault.join(', ')}`);
  }
}

async function requireModulesEnabled(_req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    if (!(await getConfig()).modulesEnabled) {
      return res.status(403).json({
        success: false,
        error: 'Modules are disabled. Enable Modules under Administration -> Integrations before loading module assets.',
      });
    }
    next();
  } catch (error) {
    logger.error('Failed to verify module capability state', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to verify module capability state' });
  }
}

// Trust proxy for correct client IP behind reverse proxy
app.set('trust proxy', 1);
app.use(requestContext);
app.use('/health', healthRoutes);
app.use('/api/health', healthRoutes);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: config.nodeEnv === 'production' ? undefined : false,
}));

// CORS configuration
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    if (config.nodeEnv === 'development') {
      callback(null, ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin));
      return;
    }
    getConfig()
      .then((adminConfig) => {
        const allowed = [...config.allowedOrigins, ...parseList(adminConfig.allowedOrigins)];
        callback(null, allowed.includes(origin));
      })
      .catch((error) => {
        logger.error('Failed to evaluate CORS origin', { error: (error as Error).message });
        callback(null, false);
      });
  },
  credentials: true,
}));

// Report ingestion has its own persisted policy, bounded before the general
// parsers. Settings are loaded before listen and apply to subsequent requests.
const REPORT_INGEST_PATHS = ['/api/dmarc/reports', '/api/tlsrpt/reports', '/api/forensic/reports'];
app.use(REPORT_INGEST_PATHS, reportIngestionBody);

// Body parsing
// Routes anyone can call before signing in take small bodies only, so an
// unauthenticated client cannot make the server parse the general allowance.
const PUBLIC_FORM_PATHS = [
  '/api/auth/login',
  '/api/auth/recovery',
  '/api/setup',
  '/api/email/public',
  '/api/fleet/agent/enroll',
];
app.use(PUBLIC_FORM_PATHS, express.json({ limit: '64kb' }));
app.use(PUBLIC_FORM_PATHS, express.urlencoded({ extended: false, limit: '64kb' }));
// Monitoring configuration cannot use the general ingestion-sized allowance.
app.use('/api/monitoring', express.json({ limit: '1mb', inflate: false }));
app.use('/api/monitoring', express.urlencoded({ extended: false, limit: '1mb', inflate: false }));
const generalJson = express.json({ limit: config.bodyLimit });
const generalForm = express.urlencoded({ extended: true, limit: config.bodyLimit });
const isModuleApi = (req: Request) => req.path === '/api/modules' || req.path.startsWith('/api/modules/');
app.use((req, res, next) => isModuleApi(req) ? next() : generalJson(req, res, next));
app.use((req, res, next) => isModuleApi(req) ? next() : generalForm(req, res, next));

// PostgreSQL session store for persistent sessions across restarts
const PgSession = connectPgSimple(session);
const { Pool } = pg;
const sessionPool = new Pool({
  host: config.postgres.host,
  port: config.postgres.port,
  database: config.postgres.database,
  user: config.postgres.user,
  password: config.postgres.password,
  max: Math.max(4, Math.min(10, config.postgres.poolMax)),
  min: 1,
  idleTimeoutMillis: config.postgres.idleTimeoutMillis,
  connectionTimeoutMillis: config.postgres.connectionTimeoutMillis,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  application_name: 'robin-admin-session',
});

sessionPool.on('error', (error) => {
  logger.error('Unexpected session database pool error', {
    error: error.message,
    pool: {
      total: sessionPool.totalCount,
      idle: sessionPool.idleCount,
      waiting: sessionPool.waitingCount,
    },
  });
});

// Session configuration with PostgreSQL store
app.use(session({
  store: new PgSession({
    pool: sessionPool,
    tableName: 'session',
    createTableIfMissing: false, // We create it in schema.ts
    pruneSessionInterval: 60 * 15, // Prune expired sessions every 15 minutes
  }),
  secret: config.sessionSecret,
  name: 'robin.admin.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: config.cookieSecure,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    domain: config.nodeEnv === 'production' ? config.cookieDomain : undefined,
    path: config.cookiePath,
  },
}));

// Rate limiting. Keyed by getTrustedClientIp rather than express-rate-limit's
// own req.ip-based default so this agrees with every other IP-based security
// decision (allowlist, jail, ingestion auth, audit) on the same admin-configured
// trustedProxyCidrs — see enforceIpRestrictions/enforceIpJail for the same helper.
//
// Loopback connections skip the limiter entirely: every report a bot forwards
// (DMARC/TLSRPT/forensic, from any configured producer) arrives here as a
// same-host POST from 127.0.0.1, so they all share one IP bucket. A single
// producer catching up on a backlog is enough to blow through the 100/window
// default meant for arbitrary external API callers and get real reports
// rejected with 429s.
//
// The fleet agent channel gets its own, larger bucket: one agent makes several
// calls per service every 30s plus its command long-poll, and several agents
// can share one NAT address, so the UI-sized default would drop their metrics
// and logs. Enrollment, the one unauthenticated agent route, keeps the default.
// Telemetry ingest shares that bucket: each Vector host pushes a batch every
// few seconds and is authenticated by its API key.
//
// Rate limits run after the session so signed-in admins get their own bucket.
const AGENT_CHANNEL_RATE_MULTIPLIER = 10;
const TELEMETRY_INGEST_PATHS = ['/api/telemetry/write', '/api/telemetry/import'];
const isAgentChannel = (req: Request) =>
  (req.originalUrl.startsWith('/api/fleet/agent/') && !req.originalUrl.startsWith('/api/fleet/agent/enroll'))
  || TELEMETRY_INGEST_PATHS.includes(req.originalUrl.split('?')[0]);

// A signed-in admin is limited per account, not per IP, with a larger budget:
// one page load makes several API calls, and admins behind one office NAT
// would otherwise share (and exhaust) a single bucket.
const SIGNED_IN_RATE_MULTIPLIER = 5;

const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: (req) => (req.session?.admin ? config.rateLimit.maxRequests * SIGNED_IN_RATE_MULTIPLIER : config.rateLimit.maxRequests),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.session?.admin ? `admin:${req.session.admin.id}` : getTrustedClientIp(req)),
  skip: (req) => isLoopbackConnection(req) || isAgentChannel(req),
});
const agentChannelLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests * AGENT_CHANNEL_RATE_MULTIPLIER,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getTrustedClientIp(req),
  skip: (req) => isLoopbackConnection(req) || !isAgentChannel(req),
});
app.use('/api', limiter);
app.use('/api', agentChannelLimiter);

app.use('/api', attachApiKey);
app.use('/api', enforceIpJail);
app.use('/api', enforceIpRestrictions);
app.use('/api', enforceSessionPolicy);
app.use('/api', csrfProtection);
app.use('/api/modules', requireAuth, requireViewer, moduleRequestBody);
app.use('/api/module-host', moduleDirectoryRoutes);
app.use('/modules', requireModulesEnabled, moduleAssetRoutes);

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/setup', setupRoutes);
app.use('/api/admins', adminsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/aliases', aliasesRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/dmarc', dmarcRoutes);
app.use('/api/tlsrpt', tlsrptRoutes);
app.use('/api/forensic', forensicRoutes);
app.use('/api/config', configRoutes);
app.use('/api/module-identity', moduleIdentityRoutes);
app.use('/api/config/telemetry', telemetrySettingsRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/robin-config', robinConfigRoutes);
app.use('/api/robin', robinRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/fleet/agent', fleetAgentRoutes);
app.use('/api/fleet/agents', fleetAgentsRoutes);
app.use('/api/fleet/services', fleetServicesRoutes);
app.use('/api/fleet/capabilities', fleetCapabilitiesRoutes);
app.use('/api/reporting', reportingRoutes);
app.use('/api/api-keys', apiKeyRoutes);
app.use('/api/security/ip-jail', ipJailRoutes);
app.use('/api/rspamd', rspamdRoutes);
app.use('/api/clamav', clamavRoutes);
app.use('/api/cyrus', cyrusRoutes);
app.use('/api/dovecot', dovecotRoutes);
app.use('/api/postfix', postfixRoutes);
app.use('/api/redis', redisRoutes);
app.use('/api/postgres', postgresRoutes);
app.use('/api/mariadb', mariadbRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api', alertingRoutes);
// Push check pings are unauthenticated (the token is the credential), so they
// are mounted ahead of the Monitoring routes, which require a session.
app.use('/api/monitoring/ping', monitoringPingRoutes);
app.use('/api/monitoring', monitoringRoutes);
app.use('/api/status-page', statusPageRoutes);
app.use('/api/telemetry', telemetryRoutes);
app.use('/api/email', emailRoutes);
// The control router (list/activate/status/jobs/sync) must be mounted before
// the module-backend proxy: the proxy claims '/:slug/*', which would otherwise
// shadow control paths like '/:slug/activate' and block paid-module activation.
app.use('/api/modules', requireModulesEnabled, modulesRoutes);
app.use('/api/modules', requireModulesEnabled, moduleBackendRoutes);

app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not found.',
    requestId: req.requestId,
  });
});

// Serve static files in production (unless running in Docker with separate client container)
if (config.nodeEnv === 'production' && process.env.SERVE_STATIC !== 'false') {
  try {
    const path = await import('path');
    const fs = await import('fs');
    const clientDir = path.default.resolve('../client/dist');
    if (fs.default.existsSync(clientDir)) {
      app.use(express.static(clientDir));
      
      // SPA fallback
      app.get('/{*splat}', (_req, res) => {
        res.sendFile('index.html', { root: clientDir });
      });
    }
  } catch {
    // Client directory doesn't exist - running in Docker with separate containers
  }
}

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not found.',
    requestId: req.requestId,
  });
});

// Reports 5xx errors to Sentry when SENTRY_DSN is set; a no-op otherwise.
Sentry.setupExpressErrorHandler(app);

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = typeof (err as Error & { status?: unknown }).status === 'number'
    ? (err as Error & { status: number }).status
    : 500;
  const publicError = status === 413
    ? 'Payload too large'
    : config.nodeEnv === 'development'
      ? err.message
      : 'Internal server error';
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    method: req.method,
    path: req.originalUrl,
    requestId: req.requestId,
    status,
  });
  res.status(status).json({
    success: false,
    error: publicError,
    requestId: req.requestId,
  });
});

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down gracefully...');
  // Let a running metrics cycle finish before the service pools close below.
  await stopMetricsPoller();
  stopAlertScheduler();
  stopTelemetryRuleScheduler();
  stopAlertDeliveryWorker();
  stopEmailDeliveryWorker();
  stopMonitoringScheduler();
  stopMonitoringHeartbeats();
  stopRspamdMaintenance();
  stopReportingMaintenanceScheduler();
  await stopConfigChangeListener();
  await releaseLeaderLock();
  await Promise.all([closeRedisClients(), closePostgresPools(), closeMariadbPools()]);
  await sessionPool.end();
  await closePool();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
async function start() {
  try {
    assertProductionSecrets();

    // Test database connection
    const dbConnected = await testConnection();
    if (!dbConnected) {
      logger.error('Failed to connect to database. Exiting.');
      process.exit(1);
    }

    // Initialize database schema
    await initializeSchema();
    await getConfig();
    await publishModuleIdentityTrust();
    await bootstrapInstalledModulesFromConfig();
    await bootstrapFleetAgentsFromConfig();
    // Services after agents: the axis wiring (agent/log/config) FKs to fleet_agents.
    await bootstrapFleetServicesFromConfig();

    // Singleton background jobs (metrics polling, alert scheduling/delivery,
    // Rspamd DKIM maintenance) must run on exactly one replica at a time — see
    // services/leader-lock.ts. This is a no-op wait when running a single
    // instance: leadership is acquired immediately.
    runAsLeader(() => {
      startMetricsPoller();
      startAlertScheduler();
      startTelemetryRuleScheduler();
      startAlertDeliveryWorker();
      startEmailDeliveryWorker();
      startMonitoringHeartbeats();
      void getConfig()
        .then((adminConfig) => {
          if (adminConfig.monitoringEnabled) {
            startMonitoringScheduler();
          } else {
            logger.info('Monitoring scheduler not started because Monitoring is disabled.');
          }
        })
        .catch((error) => {
          logger.error('Failed to read monitoring capability state', { error: (error as Error).message });
        });
      startRspamdMaintenance();
      startReportingMaintenanceScheduler();
    }, () => {
      void stopMetricsPoller();
      stopAlertScheduler();
      stopTelemetryRuleScheduler();
      stopAlertDeliveryWorker();
      stopEmailDeliveryWorker();
      stopMonitoringScheduler();
      stopMonitoringHeartbeats();
      stopRspamdMaintenance();
      stopReportingMaintenanceScheduler();
    });
    startConfigChangeListener();

    // Start listening
    app.listen(config.port, config.host, () => {
      logger.info(`Robin Admin server started on ${config.host}:${config.port}`);
      logger.info(`Environment: ${config.nodeEnv}`);
      // After the port is open, so warming never delays readiness.
      void warmReportingCache();
    });
  } catch (error) {
    logger.error('Failed to start server', { error: (error as Error).message });
    process.exit(1);
  }
}

start();
