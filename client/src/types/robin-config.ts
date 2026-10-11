/**
 * Robin configuration type definitions.
 * Based on the JSON5 configuration files in robin/cfg/
 */

// Port configuration shared by SMTP, Secure, and Submission ports
export interface PortConfig {
  backlog: number;
  minimumPoolSize: number;
  maximumPoolSize: number;
  threadKeepAliveTime: number;
  transactionsLimit: number;
  recipientsLimit: number;
  envelopeLimit: number;
  messageSizeLimit: number;
  errorLimit: number;
  dosProtectionEnabled: boolean;
  maxConnectionsPerIp: number;
  maxTotalConnections: number;
  rateLimitWindowSeconds: number;
  maxConnectionsPerWindow: number;
  maxCommandsPerMinute: number;
  minDataRateBytesPerSecond: number;
  maxDataTimeoutSeconds: number;
  tarpitDelayMillis: number;
}

// RBL configuration
export interface RblConfig {
  enabled: boolean;
  rejectEnabled: boolean;
  providers: string[];
  timeoutSeconds: number;
}

// Endpoint configuration (service/api)
export interface EndpointConfig {
  port: number;
  authType: 'none' | 'basic' | 'bearer';
  authValue: string;
  allowList: string[];
}

// Server configuration (server.json5)
export interface ServerConfig {
  hostname: string;
  bind: string;
  smtpPort: number;
  securePort: number;
  submissionPort: number;
  smtpConfig: PortConfig;
  secureConfig: PortConfig;
  submissionConfig: PortConfig;
  auth: boolean;
  starttls: boolean;
  chunking: boolean;
  pemCert: string;
  pemKey: string;
  keystore: string;
  keystorepassword: string;
  truststore: string;
  truststorepassword: string;
  allowSelfSigned: boolean;
  service: EndpointConfig;
  api: EndpointConfig;
  rbl: RblConfig;
  emailSizeLimit: number;
  envelopesLimit: number;
  chaosHeaders: boolean;
  xclientEnabled: boolean;
  dnsNegativeTtl: number;
}

// MapDB queue backend
export interface QueueMapDBConfig {
  enabled?: boolean;
  queueFile?: string;
  concurrencyScale?: number;
}

// Redis queue backend
export interface QueueRedisConfig {
  enabled?: boolean;
  host?: string;
  port?: number;
  queueKey?: string;
}

// MariaDB queue backend
export interface QueueMariaDBConfig {
  enabled?: boolean;
  jdbcUrl?: string;
  username?: string;
  password?: string;
  tableName?: string;
}

// PostgreSQL queue backend
export interface QueuePgSQLConfig {
  enabled?: boolean;
  jdbcUrl?: string;
  username?: string;
  password?: string;
  tableName?: string;
}

// Queue configuration (queue.json5)
export interface QueueConfig {
  queueInitialDelay?: number;
  queueInterval?: number;
  maxDequeuePerTick?: number;
  queueMapDB?: QueueMapDBConfig;
  queueRedis?: QueueRedisConfig;
  queueMariaDB?: QueueMariaDBConfig;
  queuePgSQL?: QueuePgSQLConfig;
}

// RocksDB storage
export interface StorageRocksDBConfig {
  enabled?: boolean;
  path?: string;
  inboxFolder?: string;
  sentFolder?: string;
}

// Storage configuration (storage.json5)
export interface StorageConfig {
  enabled?: boolean;
  autoDelete?: boolean;
  localMailbox?: boolean;
  disableRenameHeader?: boolean;
  path?: string;
  inboundFolder?: string;
  outboundFolder?: string;
  clean?: boolean;
  rocksdb?: StorageRocksDBConfig;
  patterns?: string[];
}

// IP pool address
export interface IpPoolAddress {
  ip: string;
  weight: number;
}

// IP pool
export interface IpPool {
  name: string;
  default: boolean;
  addresses: IpPoolAddress[];
}

// Relay configuration (relay.json5)
export interface RelayConfig {
  enabled: boolean;
  outboundEnabled: boolean;
  outboundMxEnabled: boolean;
  disableRelayHeader: boolean;
  host: string;
  port: number;
  protocol: 'SMTP' | 'LMTP' | 'ESMTP' | 'DOVECOT-LDA';
  tls: boolean;
  bounce: boolean;
  maxRetryCount: number;
  ipPools?: IpPool[];
}

// Dovecot auth socket
export interface DovecotAuthSocketConfig {
  enabled?: boolean;
  client?: string;
  userdb?: string;
}

// Dovecot SQL auth
export interface DovecotAuthSqlConfig {
  enabled?: boolean;
  jdbcUrl?: string;
  user?: string;
  password?: string;
  passwordQuery?: string;
  userQuery?: string;
  usersQuery?: string;
  domainQuery?: string;
  aliasQuery?: string;
}

// Dovecot LMTP save
export interface DovecotSaveLmtpConfig {
  enabled?: boolean;
  servers?: string[];
  port?: number;
  tls?: boolean;
  connectionPoolSize?: number;
  connectionPoolTimeoutSeconds?: number;
  connectionIdleTimeoutSeconds?: number;
  connectionMaxLifetimeSeconds?: number;
  connectionMaxMessagesPerConnection?: number;
}

// Dovecot LDA save
export interface DovecotSaveLdaConfig {
  enabled?: boolean;
  inline?: boolean;
  ldaBinary?: string;
  inboxFolder?: string;
  sentFolder?: string;
  maxConcurrency?: number;
  ldaTimeoutSeconds?: number;
}

// Dovecot configuration (dovecot.json5)
export interface DovecotConfig {
  auth?: boolean;
  userLookup?: boolean;
  authSocket?: DovecotAuthSocketConfig;
  authSql?: DovecotAuthSqlConfig;
  saveLmtp?: DovecotSaveLmtpConfig;
  saveLda?: DovecotSaveLdaConfig;
  inlineSaveMaxAttempts?: number;
  inlineSaveRetryDelay?: number;
  failureBehaviour?: 'retry' | 'bounce';
  maxRetryCount?: number;
}

// ClamAV configuration (clamav.json5)
export interface ClamavConfig {
  enabled: boolean;
  scanAttachments: boolean;
  host: string;
  port: number;
  timeout: number;
  onVirus: 'reject' | 'discard';
}

export interface RobinClamavLinkState {
  serverId: string;
  serviceId: string | null;
  sourceServerId: string | null;
  inherited: boolean;
}

// DKIM signing configuration
export interface DkimSigningConfig {
  enabled?: boolean;
  backend?: 'rspamd' | 'native';
  jdbcUrl?: string;
  user?: string;
  password?: string;
  keyPath?: string;
  signingQuery?: string;
}

// Rspamd configuration (rspamd.json5)
export interface RspamdConfig {
  enabled?: boolean;
  host?: string;
  port?: number;
  timeout?: number;
  spfScanEnabled?: boolean;
  dkimScanEnabled?: boolean;
  dmarcScanEnabled?: boolean;
  rejectThreshold?: number;
  discardThreshold?: number;
  dkimSigning?: DkimSigningConfig;
}

// Bot definition
export interface BotDefinition {
  addressPattern: string;
  allowedIps: string[];
  allowedTokens: string[];
  botName: string;
  endpoint?: string;
  insecure?: boolean;
}

// Bots configuration (bots.json5)
export interface BotsConfig {
  bots: BotDefinition[];
}

// Webhook configuration
export interface WebhookConfig {
  enabled: boolean;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  timeout: number;
  waitForResponse: boolean;
  ignoreErrors: boolean;
  direction: 'inbound' | 'outbound' | 'both';
  authType: 'none' | 'basic' | 'bearer';
  authValue: string;
  includeSession?: boolean;
  includeEnvelope?: boolean;
  includeVerb?: boolean;
  base64?: boolean;
  headers: Record<string, string>;
}

// Webhooks configuration (webhooks.json5)
export interface WebhooksConfig {
  ehlo?: WebhookConfig;
  starttls?: WebhookConfig;
  auth?: WebhookConfig;
  mail?: WebhookConfig;
  rcpt?: WebhookConfig;
  data?: WebhookConfig;
  bdat?: WebhookConfig;
  raw?: WebhookConfig;
  rset?: WebhookConfig;
  help?: WebhookConfig;
  quit?: WebhookConfig;
  lhlo?: WebhookConfig;
}

// Whitelist configuration (whitelist.json5)
export interface WhitelistConfig {
  enabled: boolean;
  entries: string[];
}

// Blocklist configuration (blocklist.json5)
export interface BlocklistConfig {
  enabled: boolean;
  entries: string[];
}

// Blackhole rule
export interface BlackholeRule {
  ip?: string;
  ehlo?: string;
  mail?: string;
  rcpt?: string;
}

// Blackhole configuration (blackhole.json5)
export interface BlackholeConfig {
  enabled: boolean;
  rules: BlackholeRule[];
}

// GeoIP configuration (geoip.json5)
export interface GeoIpConfig {
  enabled: boolean;
  databasePath: string;
  defaultAction: 'allow' | 'block' | 'limit';
  countries: Record<string, 'allow' | 'block' | 'limit'>;
}

// Prometheus configuration (prometheus.json5)
export interface PrometheusConfig {
  enabled: boolean;
  remoteWriteUrl: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  compress: boolean;
  include: string[];
  exclude: string[];
  labels: Record<string, string>;
  headers: Record<string, string>;
  bearerToken: string;
  basicAuthUser: string;
  basicAuthPassword: string;
  tenantHeaderName: string;
  tenantHeaderValue: string;
}

// Distributed rate limiting (distributed-rate.json5)
export interface DistributedRateConfig {
  enabled: boolean;
  host: string;
  port: number;
  password: string;
  keyPrefix: string;
  poolMaxTotal: number;
  keyTtlSeconds: number;
}

// Client configuration (client.json5)
export interface ClientConfig {
  mx?: string[];
  port?: number;
  tls?: boolean;
  protocols?: string[];
  ciphers?: string[];
  ehlo?: string;
  mail?: string;
  rcpt?: string[];
  assertions?: {
    protocolFails?: boolean;
    verifyFails?: boolean;
  };
}

// Properties auto-reload configuration
export interface PropertiesAutoReloadConfig {
  enabled?: boolean;
  delaySeconds?: number;
  intervalSeconds?: number;
}

// Logging configuration
export interface PropertiesLoggingConfig {
  data?: boolean;
  textPartBody?: boolean;
}

// HTTP request configuration
export interface PropertiesRequestConfig {
  connectTimeout?: number;
  writeTimeout?: number;
  readTimeout?: number;
}

// Humio configuration
export interface PropertiesHumioConfig {
  auth?: string;
  url?: string;
  connectTimeout?: number;
  writeTimeout?: number;
  readTimeout?: number;
}

// Properties configuration (properties.json5)
export interface PropertiesConfig {
  localLogsDir?: string;
  uidPattern?: string;
  rsetBetweenEnvelopes?: boolean;
  propertiesAutoReload?: PropertiesAutoReloadConfig;
  serverAutoReload?: PropertiesAutoReloadConfig;
  logging?: PropertiesLoggingConfig;
  request?: PropertiesRequestConfig;
  humio?: PropertiesHumioConfig;
  imapClientDebug?: string;
}

export interface UsersConfigEntry {
  name: string;
  pass: string;
}

export interface UsersConfig {
  listEnabled?: boolean;
  list?: UsersConfigEntry[];
}

export interface ProxyRuleConfig {
  ip?: string;
  ehlo?: string;
  mail?: string;
  rcpt?: string;
  hosts?: string[];
  port?: number;
  protocol?: 'smtp' | 'esmtp' | 'lmtp';
  tls?: boolean;
  direction?: 'both' | 'inbound' | 'outbound';
  action?: 'accept' | 'reject' | 'none';
  authUsername?: string;
  authPassword?: string;
  authMechanism?: string;
}

export interface ProxyConfig {
  enabled?: boolean;
  rules?: ProxyRuleConfig[];
}

export interface StalwartConfig {
  enabled?: boolean;
  inline?: boolean;
  baseUrl?: string;
  managementBaseUrl?: string;
  username?: string;
  password?: string;
  connectTimeoutSeconds?: number;
  readTimeoutSeconds?: number;
  writeTimeoutSeconds?: number;
  lookupCacheTtlSeconds?: number;
  lookupCacheMaxEntries?: number;
  maxConcurrentRequests?: number;
  failureBehaviour?: 'retry' | 'bounce';
  maxRetryCount?: number;
  inboxMailboxId?: string;
}

export interface VaultConfig {
  enabled?: boolean;
  address?: string;
  token?: string;
  namespace?: string;
  skipTlsVerification?: boolean;
  connectTimeout?: number;
  readTimeout?: number;
  writeTimeout?: number;
}

// Config file metadata
export interface ConfigFileInfo {
  fileName: string;
  serverIds: string[];
  updatedAt: string;
}

// Config entry from API
export interface ConfigEntry {
  serverId: string;
  fileName: string;
  config: Record<string, unknown>;
  updatedAt: string;
  sha256: string;
}

// Config file with base and override
export interface ConfigFileData {
  fileName: string;
  base: {
    config: Record<string, unknown>;
    updatedAt: string;
    sha256: string;
  };
  override: {
    serverId: string;
    config: Record<string, unknown>;
    updatedAt: string;
    sha256: string;
  } | null;
}

// Config file definitions for UI
export interface ConfigFileDefinition {
  fileName: string;
  label: string;
  description: string;
  icon: string;
  category: 'core' | 'security' | 'delivery' | 'integration' | 'monitoring';
}

export const CONFIG_FILES: ConfigFileDefinition[] = [
  { fileName: 'server.json5', label: 'Server', description: 'SMTP server settings, ports, TLS, authentication', icon: 'Server', category: 'core' },
  { fileName: 'queue.json5', label: 'Queue', description: 'Message queue backend configuration', icon: 'ListOrdered', category: 'core' },
  { fileName: 'storage.json5', label: 'Storage', description: 'Email storage and mailbox settings', icon: 'HardDrive', category: 'core' },
  { fileName: 'users.json5', label: 'Users', description: 'Static test users for local/e2e workflows', icon: 'Users', category: 'delivery' },
  { fileName: 'relay.json5', label: 'Relay', description: 'Inbound/outbound relay configuration', icon: 'ArrowRightLeft', category: 'delivery' },
  { fileName: 'dovecot.json5', label: 'Dovecot', description: 'Dovecot authentication and delivery', icon: 'Key', category: 'delivery' },
  { fileName: 'client.json5', label: 'Client', description: 'Default SMTP client settings for outbound email', icon: 'Send', category: 'delivery' },
  { fileName: 'properties.json5', label: 'Properties', description: 'Runtime settings, logging, auto-reload', icon: 'Settings', category: 'core' },
  { fileName: 'proxy.json5', label: 'Proxy', description: 'Rule-based SMTP/ESMTP/LMTP proxying', icon: 'ArrowRightLeft', category: 'integration' },
  { fileName: 'vault.json5', label: 'Vault', description: 'HashiCorp Vault integration for secret resolution', icon: 'KeyRound', category: 'integration' },
  { fileName: 'clamav.json5', label: 'ClamAV', description: 'Virus scanning configuration', icon: 'Shield', category: 'security' },
  { fileName: 'rspamd.json5', label: 'Rspamd', description: 'Spam detection and DKIM signing', icon: 'ShieldAlert', category: 'security' },
  { fileName: 'stalwart.json5', label: 'Stalwart', description: 'Stalwart mailbox backend integration', icon: 'ServerCog', category: 'integration' },
  { fileName: 'bots.json5', label: 'Bots', description: 'Email analysis and DMARC bots', icon: 'Bot', category: 'integration' },
  { fileName: 'webhooks.json5', label: 'Webhooks', description: 'SMTP event webhooks', icon: 'Webhook', category: 'integration' },
  { fileName: 'whitelist.json5', label: 'Whitelist', description: 'Trusted IP addresses', icon: 'CheckCircle', category: 'security' },
  { fileName: 'blocklist.json5', label: 'Blocklist', description: 'Blocked IP addresses', icon: 'XCircle', category: 'security' },
  { fileName: 'blackhole.json5', label: 'Blackhole', description: 'Discard rules for unwanted email', icon: 'Trash2', category: 'security' },
  { fileName: 'geoip.json5', label: 'GeoIP', description: 'Geographic IP filtering', icon: 'Globe', category: 'security' },
  { fileName: 'prometheus.json5', label: 'Prometheus', description: 'Metrics remote write', icon: 'BarChart3', category: 'monitoring' },
  { fileName: 'distributed-rate.json5', label: 'Distributed rate', description: 'Redis-based rate limiting', icon: 'Gauge', category: 'monitoring' },
];

// Default port config values
export const DEFAULT_PORT_CONFIG: PortConfig = {
  backlog: 25,
  minimumPoolSize: 1,
  maximumPoolSize: 10,
  threadKeepAliveTime: 60,
  transactionsLimit: 305,
  recipientsLimit: 100,
  envelopeLimit: 100,
  messageSizeLimit: 10242400,
  errorLimit: 3,
  dosProtectionEnabled: true,
  maxConnectionsPerIp: 10,
  maxTotalConnections: 100,
  rateLimitWindowSeconds: 60,
  maxConnectionsPerWindow: 30,
  maxCommandsPerMinute: 100,
  minDataRateBytesPerSecond: 10240,
  maxDataTimeoutSeconds: 300,
  tarpitDelayMillis: 1000,
};
