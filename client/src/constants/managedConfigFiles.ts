// Client-side field metadata for the per-file managed configs. The server owns
// defaults + rendering; this drives the generic PerFileConfigPage form so a new
// file is added by describing its fields, not by writing a bespoke form. Reused
// across all services — the value keys must match the server's shape.

export type ManagedFieldType = 'text' | 'number' | 'boolean' | 'select' | 'textarea';

export interface ManagedFieldDef {
  key: string;
  label: string;
  type: ManagedFieldType;
  help?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  /** A number field whose empty value maps to null (e.g. optional threshold). */
  nullable?: boolean;
}

export interface ManagedFileCatalogEntry {
  key: string;
  label: string;
  description: string;
  icon: string; // appIcons key
  fields: ManagedFieldDef[];
}

const LOG_LEVELS = ['error', 'warning', 'info', 'debug', 'silent'].map((v) => ({ value: v, label: v }));

export const RSPAMD_MANAGED_FILE_CATALOG: ManagedFileCatalogEntry[] = [
  {
    key: 'redis',
    label: 'Redis backend',
    description: 'redis.conf — the global Redis used by Bayes, fuzzy, ratelimit, replies and history.',
    icon: 'redisMetrics',
    fields: [
      { key: 'servers', label: 'Servers', type: 'text', placeholder: 'redis-backend:6379', help: 'host:port (comma-separated for multiple).' },
      { key: 'db', label: 'Database', type: 'text', placeholder: '(default)', help: 'Optional Redis logical DB index.' },
      { key: 'password', label: 'Password', type: 'text', placeholder: '(none)', help: 'Optional Redis AUTH password.' },
      { key: 'timeout', label: 'Timeout (s)', type: 'number', min: 1, step: 1, help: 'Connection/operation timeout in seconds.' },
      { key: 'expandKeys', label: 'Expand keys', type: 'boolean', help: 'Enable key expansion for per-user statistics.' },
    ],
  },
  {
    key: 'logging',
    label: 'Logging',
    description: 'logging.inc — where and how verbosely rspamd logs.',
    icon: 'logs',
    fields: [
      { key: 'type', label: 'Type', type: 'select', options: ['file', 'console', 'syslog'].map((v) => ({ value: v, label: v })) },
      { key: 'filename', label: 'File', type: 'text', placeholder: '/var/log/rspamd.log', help: 'Log file path (type = file).' },
      { key: 'level', label: 'Level', type: 'select', options: LOG_LEVELS },
      { key: 'logReCache', label: 'Log regexp cache', type: 'boolean' },
      { key: 'logUsec', label: 'Microsecond timestamps', type: 'boolean' },
      { key: 'systemd', label: 'systemd mode', type: 'boolean', help: 'Log without timestamps (journald adds them).' },
    ],
  },
  {
    key: 'options',
    label: 'Scan options',
    description: 'options.inc — global scan and DNS behaviour.',
    icon: 'settings',
    fields: [
      { key: 'taskTimeout', label: 'Task timeout (s)', type: 'number', min: 1, help: 'Max seconds to scan one message.' },
      { key: 'maxRecipients', label: 'Max recipients', type: 'number', min: 1, help: 'Recipients scanned per message.' },
      { key: 'checkAllFilters', label: 'Check all filters', type: 'boolean', help: 'Run every rule even after a reject-level score.' },
      { key: 'dnsTimeout', label: 'DNS timeout (s)', type: 'number', min: 1 },
      { key: 'dnsRetransmits', label: 'DNS retransmits', type: 'number', min: 1 },
    ],
  },
  {
    key: 'worker_normal',
    label: 'Scan worker',
    description: 'worker-normal.inc — the scanning worker process.',
    icon: 'rspamdScan',
    fields: [
      { key: 'count', label: 'Process count', type: 'number', min: 1, help: 'Number of scanning worker processes.' },
      { key: 'maxTasks', label: 'Max tasks', type: 'number', min: 0, help: 'Recycle a worker after N tasks (0 = never).' },
      { key: 'bindSocket', label: 'Bind socket', type: 'text', placeholder: '*:11333' },
    ],
  },
];

export const RSPAMD_MANAGED_FILE_CATALOG_BY_KEY: Record<string, ManagedFileCatalogEntry> =
  Object.fromEntries(RSPAMD_MANAGED_FILE_CATALOG.map((e) => [e.key, e]));

// The existing DKIM signing + Bayes classifier managed policy, as sidebar
// sections (RspamdManagedConfig → dkim_signing.conf / classifier-bayes.conf).
// Saved via updateConfig.
export const RSPAMD_CORE_SECTIONS: ManagedFileCatalogEntry[] = [
  {
    key: 'dkim', label: 'DKIM signing', icon: 'rspamdDkim',
    description: 'dkim_signing.conf — outbound DKIM signing policy.',
    fields: [
      { key: 'rspamdDkimEnabled', label: 'Enabled', type: 'boolean' },
      { key: 'rspamdDkimPathTemplate', label: 'Key path template', type: 'text', placeholder: '/var/lib/rspamd/dkim/$domain.$selector.key' },
      { key: 'rspamdDkimUseDomain', label: 'Use domain', type: 'select', options: ['header', 'envelope', 'auth'].map((v) => ({ value: v, label: v })) },
      { key: 'rspamdDkimFallbackSelector', label: 'Fallback selector', type: 'text', placeholder: 'dkim' },
      { key: 'rspamdDkimSignAuthenticated', label: 'Sign authenticated', type: 'boolean' },
      { key: 'rspamdDkimSignLocal', label: 'Sign local', type: 'boolean' },
      { key: 'rspamdDkimTryFallback', label: 'Try fallback selector', type: 'boolean' },
      { key: 'rspamdDkimCheckPubkey', label: 'Check public key', type: 'boolean' },
      { key: 'rspamdDkimAllowPubkeyMismatch', label: 'Allow pubkey mismatch', type: 'boolean' },
    ],
  },
  {
    key: 'bayes', label: 'Bayes classifier', icon: 'brain',
    description: 'classifier-bayes.conf — statistical spam classifier.',
    fields: [
      { key: 'rspamdBayesBackend', label: 'Backend', type: 'text', placeholder: 'redis' },
      { key: 'rspamdBayesRedisServers', label: 'Redis servers', type: 'text', placeholder: 'blank = inherit redis.conf' },
      { key: 'rspamdBayesTokenizer', label: 'Tokenizer', type: 'text', placeholder: 'osb' },
      { key: 'rspamdBayesMinLearns', label: 'Min learns', type: 'number', min: 0 },
      { key: 'rspamdBayesAutolearnEnabled', label: 'Autolearn', type: 'boolean' },
      { key: 'rspamdBayesSpamThreshold', label: 'Spam threshold', type: 'number', step: 0.1 },
      { key: 'rspamdBayesJunkThreshold', label: 'Junk threshold', type: 'number', step: 0.1, nullable: true, help: 'Blank to disable.' },
      { key: 'rspamdBayesHamThreshold', label: 'Ham threshold', type: 'number', step: 0.1 },
      { key: 'rspamdBayesCheckBalance', label: 'Check balance', type: 'boolean' },
      { key: 'rspamdBayesMinBalance', label: 'Min balance', type: 'number', step: 0.05 },
    ],
  },
];

export const DOVECOT_MANAGED_FILE_CATALOG: ManagedFileCatalogEntry[] = [
  {
    key: 'logging',
    label: 'Logging',
    description: '50-robin-logging.conf — auth/mail debug verbosity and log timestamps.',
    icon: 'logs',
    fields: [
      { key: 'authVerbose', label: 'Verbose auth', type: 'boolean', help: 'Log why authentication failed.' },
      { key: 'authDebug', label: 'Auth debug', type: 'boolean', help: 'Very verbose auth logging (passwords redacted).' },
      { key: 'mailDebug', label: 'Mail debug', type: 'boolean' },
      { key: 'verboseProctitle', label: 'Verbose proctitle', type: 'boolean', help: 'Show connection info in process titles.' },
      { key: 'logTimestamp', label: 'Log timestamp', type: 'text', placeholder: '%Y-%m-%d %H:%M:%S ' },
    ],
  },
  {
    key: 'limits',
    label: 'Process limits',
    description: '50-robin-limits.conf — process/client limits and per-service caps.',
    icon: 'settings',
    fields: [
      { key: 'defaultProcessLimit', label: 'Default process limit', type: 'number', min: 1 },
      { key: 'defaultClientLimit', label: 'Default client limit', type: 'number', min: 1 },
      { key: 'defaultVszLimit', label: 'Default VSZ limit', type: 'text', placeholder: '256M', help: 'Per-process virtual memory cap.' },
      { key: 'imapProcessLimit', label: 'imap process limit', type: 'number', min: 0, help: '0 = leave default.' },
      { key: 'imapLoginProcessLimit', label: 'imap-login process limit', type: 'number', min: 0, help: '0 = leave default.' },
    ],
  },
  {
    key: 'lmtp',
    label: 'LMTP delivery',
    description: '50-robin-lmtp.conf — local delivery behaviour.',
    icon: 'postfixConfig',
    fields: [
      { key: 'postmasterAddress', label: 'Postmaster address', type: 'text', placeholder: 'postmaster@example.com' },
      { key: 'hostname', label: 'Hostname', type: 'text', placeholder: '(system default)' },
      { key: 'lmtpRcptCheckQuota', label: 'Check quota at RCPT', type: 'boolean', help: 'Reject over-quota recipients at RCPT time.' },
      { key: 'lmtpSaveToDetailMailbox', label: 'Save to detail mailbox', type: 'boolean', help: 'Deliver user+detail@ into the "detail" mailbox.' },
    ],
  },
  {
    key: 'mail',
    label: 'Mail storage',
    description: '50-robin-mail.conf — storage sync and mailbox tunables.',
    icon: 'dovecotConfig',
    fields: [
      { key: 'mailFsync', label: 'fsync', type: 'select', options: ['optimized', 'always', 'never'].map((v) => ({ value: v, label: v })), help: 'When to fsync mail writes to disk.' },
      { key: 'firstValidUid', label: 'First valid UID', type: 'number', min: 0 },
      { key: 'mmapDisable', label: 'Disable mmap', type: 'boolean', help: 'Turn off memory-mapped I/O (needed on some NFS).' },
      { key: 'mailNfsStorage', label: 'NFS storage', type: 'boolean', help: 'Use NFS-safe cache flushing for mailbox storage.' },
    ],
  },
];

export const DOVECOT_MANAGED_FILE_CATALOG_BY_KEY: Record<string, ManagedFileCatalogEntry> =
  Object.fromEntries(DOVECOT_MANAGED_FILE_CATALOG.map((e) => [e.key, e]));

// The existing Dovecot managed form (DovecotManagedConfig → 50-robin-managed.conf),
// split into sidebar sections. These edit the single managed object (saved via
// updateConfig); the DOVECOT_MANAGED_FILE_CATALOG entries are separate files.
export const DOVECOT_CORE_SECTIONS: ManagedFileCatalogEntry[] = [
  {
    key: 'auth', label: 'Authentication', icon: 'settings',
    description: '50-robin-managed.conf — auth cache and plaintext policy.',
    fields: [
      { key: 'dovecotVersion', label: 'Dovecot version', type: 'select', options: ['2.3', '2.4'].map((v) => ({ value: v, label: v })), help: 'Selects 2.3 vs 2.4 syntax until the service’s agent reports its Dovecot version; the reported version then wins.' },
      { key: 'disablePlaintextAuth', label: 'Disable plaintext auth', type: 'boolean' },
      { key: 'authCacheSize', label: 'Auth cache size', type: 'text', placeholder: 'blank = unset, e.g. 10M' },
      { key: 'authCacheTtl', label: 'Auth cache TTL', type: 'text', placeholder: '1 hour' },
      { key: 'authCacheNegativeTtl', label: 'Auth cache negative TTL', type: 'text', placeholder: '1 hour' },
      { key: 'authFailureDelay', label: 'Auth failure delay', type: 'text', placeholder: '2 secs' },
    ],
  },
  {
    key: 'sessions', label: 'Sessions & protocols', icon: 'dovecotConfig',
    description: '50-robin-managed.conf — protocols, IMAP and mailbox limits.',
    fields: [
      { key: 'protocols', label: 'Protocols', type: 'text', placeholder: 'imap lmtp' },
      { key: 'mailMaxUseripConnections', label: 'Max connections / user·IP', type: 'number', min: 0 },
      { key: 'imapIdleNotifyInterval', label: 'IMAP idle notify interval', type: 'text', placeholder: '2 mins' },
      { key: 'imapMaxLineLength', label: 'IMAP max line length', type: 'text', placeholder: 'blank = default, e.g. 64k' },
      { key: 'mailMaxLockTimeout', label: 'Mail max lock timeout', type: 'text', placeholder: 'blank = default, e.g. 5 mins' },
      { key: 'mailRetentionDays', label: 'Mail retention (days)', type: 'number', min: 0, help: '0 = disabled.' },
    ],
  },
];

// ClamAV: clamd.conf + freshclam.conf. Sections whose key starts with
// 'freshclam' edit the freshclam sub-object; the rest edit clamd.
export const CLAMAV_CONFIG_SECTIONS: ManagedFileCatalogEntry[] = [
  {
    key: 'clamd-connection', label: 'Daemon', icon: 'clamavConfig',
    description: 'clamd.conf — listener, threads and identity.',
    fields: [
      { key: 'tcpAddr', label: 'TCP address', type: 'text' },
      { key: 'tcpPort', label: 'TCP port', type: 'number', min: 0 },
      { key: 'localSocket', label: 'Local socket', type: 'text', placeholder: 'blank = TCP only' },
      { key: 'localSocketMode', label: 'Socket mode', type: 'text', placeholder: '666' },
      { key: 'maxThreads', label: 'Max threads', type: 'number', min: 1 },
      { key: 'readTimeoutSeconds', label: 'Read timeout (s)', type: 'number', min: 0 },
      { key: 'user', label: 'User', type: 'text' },
    ],
  },
  {
    key: 'clamd-scan', label: 'Scan limits', icon: 'settings',
    description: 'clamd.conf — size/recursion caps and scan timeout.',
    fields: [
      { key: 'maxScanSize', label: 'Max scan size', type: 'text', placeholder: '100M' },
      { key: 'maxFileSize', label: 'Max file size', type: 'text', placeholder: '25M' },
      { key: 'maxRecursion', label: 'Max recursion', type: 'number', min: 0 },
      { key: 'maxFiles', label: 'Max files', type: 'number', min: 0 },
      { key: 'scanArchive', label: 'Scan archives', type: 'boolean' },
      { key: 'maxScanTimeMs', label: 'Max scan time (ms)', type: 'number', min: 0 },
    ],
  },
  {
    key: 'clamd-detection', label: 'Detection', icon: 'rspamdRules',
    description: 'clamd.conf — what to inspect and how aggressively to alert.',
    fields: [
      { key: 'detectPua', label: 'Detect PUA', type: 'boolean', help: 'Potentially unwanted apps.' },
      { key: 'heuristicAlerts', label: 'Heuristic alerts', type: 'boolean' },
      { key: 'scanPdf', label: 'Scan PDF', type: 'boolean' },
      { key: 'scanHtml', label: 'Scan HTML', type: 'boolean' },
      { key: 'scanOle2', label: 'Scan OLE2 (MS Office)', type: 'boolean' },
    ],
  },
  {
    key: 'clamd-logging', label: 'Logging', icon: 'logs',
    description: 'clamd.conf — log destination and on-detect hook.',
    fields: [
      { key: 'logFile', label: 'Log file', type: 'text' },
      { key: 'logVerbose', label: 'Verbose logging', type: 'boolean' },
      { key: 'virusEvent', label: 'Virus event hook', type: 'text', placeholder: 'command on detection' },
      { key: 'notifyClamdOnUpdate', label: 'Notify clamd after updates', type: 'boolean' },
    ],
  },
  {
    key: 'freshclam', label: 'Updates (freshclam)', icon: 'settings',
    description: 'freshclam.conf — signature database updates.',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'boolean' },
      { key: 'daemon', label: 'Run as daemon', type: 'boolean' },
      { key: 'checks', label: 'Checks per day', type: 'number', min: 0 },
      { key: 'databaseOwner', label: 'Database owner', type: 'text' },
      { key: 'notifyClamd', label: 'Notify clamd file', type: 'text' },
      { key: 'connectTimeoutSeconds', label: 'Connect timeout (s)', type: 'number', min: 0 },
      { key: 'receiveTimeoutSeconds', label: 'Receive timeout (s)', type: 'number', min: 0 },
      { key: 'databaseMirror', label: 'Database mirrors', type: 'textarea', placeholder: 'database.clamav.net (one per line)' },
      { key: 'privateMirror', label: 'Private mirrors', type: 'textarea', placeholder: 'one per line' },
      { key: 'updateLogFile', label: 'Update log file', type: 'text' },
      { key: 'httpProxyServer', label: 'HTTP proxy server', type: 'text' },
      { key: 'httpProxyPort', label: 'HTTP proxy port', type: 'number', min: 0 },
    ],
  },
];

const TLS_LEVEL_OPTS = ['none', 'may', 'encrypt'].map((v) => ({ value: v, label: v }));

export const POSTFIX_MANAGED_FILE_CATALOG: ManagedFileCatalogEntry[] = [
  {
    key: 'tls',
    label: 'TLS',
    description: 'robin-tls.cf — inbound/outbound TLS policy and certificates.',
    icon: 'settings',
    fields: [
      { key: 'smtpdTlsSecurityLevel', label: 'Inbound TLS (smtpd)', type: 'select', options: TLS_LEVEL_OPTS, help: 'may = opportunistic; encrypt = required.' },
      { key: 'smtpTlsSecurityLevel', label: 'Outbound TLS (smtp)', type: 'select', options: TLS_LEVEL_OPTS },
      { key: 'smtpdTlsProtocols', label: 'Protocols', type: 'text', placeholder: '>=TLSv1.2' },
      { key: 'smtpdTlsCertFile', label: 'Certificate file', type: 'text', placeholder: '/etc/ssl/certs/mail.pem' },
      { key: 'smtpdTlsKeyFile', label: 'Key file', type: 'text', placeholder: '/etc/ssl/private/mail.key' },
      { key: 'smtpdTlsAuthOnly', label: 'Auth only over TLS', type: 'boolean', help: 'Offer AUTH only after STARTTLS.' },
    ],
  },
  {
    key: 'restrictions',
    label: 'Restrictions',
    description: 'robin-restrictions.cf — SMTP access/relay policy.',
    icon: 'rspamdRules',
    fields: [
      { key: 'smtpdHeloRequired', label: 'Require HELO', type: 'boolean' },
      { key: 'smtpdHeloRestrictions', label: 'HELO restrictions', type: 'text', placeholder: 'permit_mynetworks, reject_invalid_helo_hostname' },
      { key: 'smtpdSenderRestrictions', label: 'Sender restrictions', type: 'text', placeholder: 'reject_unknown_sender_domain' },
      { key: 'smtpdRecipientRestrictions', label: 'Recipient restrictions', type: 'text' },
      { key: 'smtpdRelayRestrictions', label: 'Relay restrictions', type: 'text', placeholder: 'permit_mynetworks, reject_unauth_destination' },
    ],
  },
  {
    key: 'milters',
    label: 'Milters',
    description: 'robin-milters.cf — rspamd / OpenDKIM milter integration.',
    icon: 'rspamdConfig',
    fields: [
      { key: 'smtpdMilters', label: 'smtpd milters', type: 'text', placeholder: 'inet:localhost:11332' },
      { key: 'nonSmtpdMilters', label: 'non-smtpd milters', type: 'text', placeholder: 'inet:localhost:11332' },
      { key: 'milterDefaultAction', label: 'Default action', type: 'select', options: ['accept', 'reject', 'tempfail', 'quarantine'].map((v) => ({ value: v, label: v })), help: 'What to do if the milter is unavailable.' },
      { key: 'milterProtocol', label: 'Protocol', type: 'select', options: ['2', '3', '4', '6'].map((v) => ({ value: v, label: v })) },
    ],
  },
];

export const POSTFIX_MANAGED_FILE_CATALOG_BY_KEY: Record<string, ManagedFileCatalogEntry> =
  Object.fromEntries(POSTFIX_MANAGED_FILE_CATALOG.map((e) => [e.key, e]));

// The existing Postfix managed form (PostfixManagedConfig → robin-managed.cf +
// header/body checks), split into sidebar sections. Saved via updateConfig.
export const POSTFIX_CORE_SECTIONS: ManagedFileCatalogEntry[] = [
  {
    key: 'limits', label: 'Limits & queue', icon: 'settings',
    description: 'robin-managed.cf — message/queue sizes and process limits.',
    fields: [
      { key: 'messageSizeLimit', label: 'Message size limit (bytes)', type: 'number', min: 0 },
      { key: 'mailboxSizeLimit', label: 'Mailbox size limit (bytes)', type: 'number', min: 0, help: '0 = unlimited.' },
      { key: 'maximalQueueLifetime', label: 'Maximal queue lifetime', type: 'text', placeholder: '5d' },
      { key: 'bounceQueueLifetime', label: 'Bounce queue lifetime', type: 'text', placeholder: '5d' },
      { key: 'defaultProcessLimit', label: 'Default process limit', type: 'number', min: 1 },
      { key: 'defaultDestinationConcurrencyLimit', label: 'Destination concurrency', type: 'number', min: 1 },
    ],
  },
  {
    key: 'ratelimits', label: 'Rate limits', icon: 'rspamdRules',
    description: 'robin-managed.cf — smtpd per-client anvil limits.',
    fields: [
      { key: 'smtpdClientConnectionCountLimit', label: 'Connection count limit', type: 'number', min: 0 },
      { key: 'smtpdClientConnectionRateLimit', label: 'Connection rate limit', type: 'number', min: 0 },
      { key: 'smtpdClientMessageRateLimit', label: 'Message rate limit', type: 'number', min: 0 },
      { key: 'smtpdClientRecipientRateLimit', label: 'Recipient rate limit', type: 'number', min: 0 },
      { key: 'smtpdClientAuthRateLimit', label: 'Auth rate limit', type: 'number', min: 0 },
      { key: 'notifyClasses', label: 'Notify classes', type: 'text', placeholder: 'resource, software' },
    ],
  },
  {
    key: 'checks', label: 'Content filters', icon: 'postfixConfig',
    description: 'robin-header_checks / robin-body_checks — one regexp rule per line.',
    fields: [
      { key: 'headerChecks', label: 'Header checks', type: 'textarea', placeholder: '/^X-Spammy:/ REJECT unwanted header' },
      { key: 'bodyChecks', label: 'Body checks', type: 'textarea', placeholder: '/tracking-pixel\\.example\\.com/ DISCARD' },
    ],
  },
];

// Redis has no on-disk files (CONFIG SET, applied live) — model its config as
// logical sections so it uses the same per-file page. Every section edits the
// one managed object; the page merges the edited section on save.
const REDIS_POLICY_OPTS = [
  'noeviction', 'allkeys-lru', 'allkeys-lfu', 'allkeys-random',
  'volatile-lru', 'volatile-lfu', 'volatile-random', 'volatile-ttl',
].map((v) => ({ value: v, label: v }));
const REDIS_LOG_OPTS = ['debug', 'verbose', 'notice', 'warning', 'nothing'].map((v) => ({ value: v, label: v }));

export const REDIS_CONFIG_SECTIONS: ManagedFileCatalogEntry[] = [
  {
    key: 'memory', label: 'Memory', icon: 'redisMetrics',
    description: 'Eviction and per-client memory limits.',
    fields: [
      { key: 'maxmemory', label: 'Max memory', type: 'text', placeholder: '0 = unlimited, e.g. 256mb' },
      { key: 'maxmemoryPolicy', label: 'Eviction policy', type: 'select', options: REDIS_POLICY_OPTS },
      { key: 'maxmemoryClients', label: 'Max memory clients', type: 'text', placeholder: '0, a size, or "5%" (Redis 7+)' },
    ],
  },
  {
    key: 'persistence', label: 'Persistence', icon: 'settings',
    description: 'RDB snapshots and the append-only file.',
    fields: [
      { key: 'save', label: 'Save points', type: 'text', placeholder: '3600 1 300 100 60 10000' },
      { key: 'appendonly', label: 'Append-only file (AOF)', type: 'boolean' },
      { key: 'appendfsync', label: 'AOF fsync', type: 'select', options: ['always', 'everysec', 'no'].map((v) => ({ value: v, label: v })) },
      { key: 'stopWritesOnBgsaveError', label: 'Stop writes on bgsave error', type: 'boolean' },
      { key: 'rdbCompression', label: 'RDB compression', type: 'boolean' },
    ],
  },
  {
    key: 'connections', label: 'Connections', icon: 'settings',
    description: 'Client connection limits and the server tick.',
    fields: [
      { key: 'timeout', label: 'Timeout (s)', type: 'number', min: 0, help: '0 = disabled.' },
      { key: 'tcpKeepalive', label: 'TCP keepalive (s)', type: 'number', min: 0 },
      { key: 'maxclients', label: 'Max clients', type: 'number', min: 1 },
      { key: 'hz', label: 'Hz', type: 'number', min: 1, help: 'Background task frequency.' },
    ],
  },
  {
    key: 'logging', label: 'Logging & slowlog', icon: 'logs',
    description: 'Log level, keyspace notifications, slowlog and latency.',
    fields: [
      { key: 'loglevel', label: 'Log level', type: 'select', options: REDIS_LOG_OPTS },
      { key: 'notifyKeyspaceEvents', label: 'Keyspace events', type: 'text', placeholder: 'blank = disabled, e.g. KEA' },
      { key: 'slowlogLogSlowerThan', label: 'Slowlog threshold (µs)', type: 'number' },
      { key: 'slowlogMaxLen', label: 'Slowlog max length', type: 'number', min: 0 },
      { key: 'latencyMonitorThreshold', label: 'Latency monitor (ms)', type: 'number', min: 0, help: '0 = disabled.' },
    ],
  },
  {
    key: 'performance', label: 'Performance', icon: 'metrics',
    description: 'Defragmentation and lazy-free (async delete) behaviour.',
    fields: [
      { key: 'activeDefrag', label: 'Active defragmentation', type: 'boolean' },
      { key: 'lazyfreeLazyEviction', label: 'Lazy free on eviction', type: 'boolean' },
      { key: 'lazyfreeLazyExpire', label: 'Lazy free on expire', type: 'boolean' },
      { key: 'lazyfreeLazyServerDel', label: 'Lazy free on server del', type: 'boolean' },
      { key: 'lazyfreeLazyUserDel', label: 'Lazy free on user del', type: 'boolean' },
      { key: 'lazyfreeLazyUserFlush', label: 'Lazy free on user flush', type: 'boolean' },
    ],
  },
];

// Postgres has no on-disk files (ALTER SYSTEM, applied live) — same section model.
export const POSTGRES_CONFIG_SECTIONS: ManagedFileCatalogEntry[] = [
  {
    key: 'memory', label: 'Memory & planner', icon: 'postgresMetrics',
    description: 'Working memory and planner cost estimates.',
    fields: [
      { key: 'workMem', label: 'work_mem', type: 'text', placeholder: '4MB' },
      { key: 'maintenanceWorkMem', label: 'maintenance_work_mem', type: 'text', placeholder: '64MB' },
      { key: 'effectiveCacheSize', label: 'effective_cache_size', type: 'text', placeholder: '4GB' },
      { key: 'randomPageCost', label: 'random_page_cost', type: 'number', step: 0.1 },
      { key: 'defaultStatisticsTarget', label: 'default_statistics_target', type: 'number', min: 1, max: 10000 },
    ],
  },
  {
    key: 'timeouts', label: 'Timeouts', icon: 'settings',
    description: 'Statement and idle-transaction limits.',
    fields: [
      { key: 'statementTimeout', label: 'statement_timeout (ms)', type: 'number', min: 0, help: '0 = disabled.' },
      { key: 'idleInTransactionSessionTimeout', label: 'idle_in_transaction (ms)', type: 'number', min: 0, help: '0 = disabled.' },
      { key: 'logMinDurationStatement', label: 'log_min_duration (ms)', type: 'number', help: '-1 = disabled.' },
    ],
  },
  {
    key: 'autovacuum', label: 'Autovacuum', icon: 'settings',
    description: 'Automatic vacuum/analyze thresholds.',
    fields: [
      { key: 'autovacuum', label: 'Autovacuum', type: 'boolean' },
      { key: 'autovacuumVacuumScaleFactor', label: 'Vacuum scale factor', type: 'number', step: 0.01, min: 0, max: 1 },
      { key: 'autovacuumAnalyzeScaleFactor', label: 'Analyze scale factor', type: 'number', step: 0.01, min: 0, max: 1 },
      { key: 'autovacuumNaptime', label: 'Naptime (s)', type: 'number', min: 1 },
    ],
  },
  {
    key: 'checkpoints', label: 'Checkpoints & WAL', icon: 'settings',
    description: 'Checkpoint pacing and write-ahead log sizing.',
    fields: [
      { key: 'checkpointTimeout', label: 'checkpoint_timeout (s)', type: 'number', min: 30 },
      { key: 'checkpointCompletionTarget', label: 'completion_target', type: 'number', step: 0.05, min: 0, max: 1 },
      { key: 'maxWalSize', label: 'max_wal_size', type: 'text', placeholder: '1GB' },
      { key: 'minWalSize', label: 'min_wal_size', type: 'text', placeholder: '80MB' },
      { key: 'walCompression', label: 'WAL compression', type: 'boolean' },
    ],
  },
  {
    key: 'parallelism', label: 'Parallelism & I/O', icon: 'metrics',
    description: 'Parallel query workers, I/O concurrency and commit durability.',
    fields: [
      { key: 'effectiveIoConcurrency', label: 'effective_io_concurrency', type: 'number', min: 0, max: 1000 },
      { key: 'maxParallelWorkersPerGather', label: 'max_parallel_workers_per_gather', type: 'number', min: 0, max: 1024 },
      { key: 'synchronousCommit', label: 'synchronous_commit', type: 'select', options: ['on', 'off', 'local', 'remote_write', 'remote_apply'].map((v) => ({ value: v, label: v })) },
    ],
  },
  {
    key: 'logging', label: 'Logging', icon: 'logs',
    description: 'Connection, lock and temp-file logging.',
    fields: [
      { key: 'logConnections', label: 'log_connections', type: 'boolean' },
      { key: 'logDisconnections', label: 'log_disconnections', type: 'boolean' },
      { key: 'logLockWaits', label: 'log_lock_waits', type: 'boolean' },
      { key: 'logTempFiles', label: 'log_temp_files (kB)', type: 'number', help: '-1 = disabled.' },
    ],
  },
];

// MariaDB has no on-disk files either: dynamic variables applied with SET GLOBAL.
// Every field is optional: empty leaves the server's own setting alone, so a
// save only ever touches what an operator chose to manage.
const UNMANAGED = { value: '', label: 'Not managed (server setting)' };
const ON_OFF = [UNMANAGED, { value: 'true', label: 'ON' }, { value: 'false', label: 'OFF' }];

export const MARIADB_CONFIG_SECTIONS: ManagedFileCatalogEntry[] = [
  {
    key: 'connections', label: 'Connections & timeouts', icon: 'mariadbMetrics',
    description: 'Connection limit, idle timeouts and statement caps.',
    fields: [
      { key: 'maxConnections', label: 'max_connections', type: 'number', nullable: true, help: '10 – 100000.' },
      { key: 'waitTimeout', label: 'wait_timeout (s)', type: 'number', nullable: true, help: 'Idle seconds before a non-interactive connection is closed.' },
      { key: 'interactiveTimeout', label: 'interactive_timeout (s)', type: 'number', nullable: true },
      { key: 'maxStatementTime', label: 'max_statement_time (s)', type: 'number', nullable: true, help: 'MariaDB only. 0 = no limit.' },
      { key: 'maxExecutionTime', label: 'max_execution_time (ms)', type: 'number', nullable: true, help: 'MySQL only, SELECTs. 0 = no limit.' },
      { key: 'threadCacheSize', label: 'thread_cache_size', type: 'number', nullable: true },
    ],
  },
  {
    key: 'locking', label: 'Locking', icon: 'settings',
    description: 'How long statements wait for row and metadata locks, and deadlock logging.',
    fields: [
      { key: 'innodbLockWaitTimeout', label: 'innodb_lock_wait_timeout (s)', type: 'number', nullable: true },
      { key: 'lockWaitTimeout', label: 'lock_wait_timeout (s)', type: 'number', nullable: true, help: 'Metadata locks.' },
      { key: 'innodbPrintAllDeadlocks', label: 'innodb_print_all_deadlocks', type: 'select', options: ON_OFF, help: 'Write every deadlock to the error log.' },
    ],
  },
  {
    key: 'slowlog', label: 'Slow query log', icon: 'logs',
    description: 'Which statements are logged as slow.',
    fields: [
      { key: 'slowQueryLog', label: 'slow_query_log', type: 'select', options: ON_OFF },
      { key: 'longQueryTime', label: 'long_query_time (s)', type: 'number', nullable: true },
      { key: 'logQueriesNotUsingIndexes', label: 'log_queries_not_using_indexes', type: 'select', options: ON_OFF },
    ],
  },
  {
    key: 'innodb', label: 'InnoDB I/O & durability', icon: 'metrics',
    description: 'Background I/O budget and commit durability.',
    fields: [
      { key: 'innodbIoCapacity', label: 'innodb_io_capacity', type: 'number', nullable: true },
      { key: 'innodbIoCapacityMax', label: 'innodb_io_capacity_max', type: 'number', nullable: true },
      { key: 'innodbFlushLogAtTrxCommit', label: 'innodb_flush_log_at_trx_commit', type: 'select', options: [UNMANAGED, ...['0', '1', '2'].map((v) => ({ value: v, label: v }))], help: '1 = durable on every commit.' },
      { key: 'syncBinlog', label: 'sync_binlog', type: 'number', nullable: true },
    ],
  },
  {
    key: 'memory', label: 'Memory & caches', icon: 'settings',
    description: 'In-memory temporary tables and the table cache.',
    fields: [
      { key: 'tmpTableSize', label: 'tmp_table_size (bytes)', type: 'number', nullable: true },
      { key: 'maxHeapTableSize', label: 'max_heap_table_size (bytes)', type: 'number', nullable: true },
      { key: 'tableOpenCache', label: 'table_open_cache', type: 'number', nullable: true },
    ],
  },
];
