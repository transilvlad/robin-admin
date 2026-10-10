/**
 * Per-file managed config for Dovecot, following the shared per-file model.
 * Additive to the existing 50-robin-managed.conf (auth/protocol) form: each of
 * these renders a focused robin-managed include under conf.d (Dovecot merges
 * conf.d in filename order, so 50-robin-* overrides the base). The knobs here are
 * valid on both Dovecot 2.3 and 2.4.
 */

import {
  MANAGED_MARKER,
  asManagedFileDef,
  cfgBool,
  cfgNum,
  cfgOneOf,
  cfgRecord,
  cfgStr,
  type ManagedFileDef,
} from './managed-config-file.js';

const yn = (b: boolean) => (b ? 'yes' : 'no');

// ── 50-robin-logging.conf ────────────────────────────────────────────────────
export interface DovecotLoggingFile extends Record<string, unknown> {
  authVerbose: boolean;
  authDebug: boolean;
  mailDebug: boolean;
  verboseProctitle: boolean;
  logTimestamp: string;
}
const loggingFile: ManagedFileDef<DovecotLoggingFile> = {
  key: 'logging',
  fileName: '50-robin-logging.conf',
  defaults: { authVerbose: false, authDebug: false, mailDebug: false, verboseProctitle: false, logTimestamp: '%Y-%m-%d %H:%M:%S ' },
  normalize: (raw) => {
    const r = cfgRecord(raw);
    return {
      authVerbose: cfgBool(r.authVerbose, false),
      authDebug: cfgBool(r.authDebug, false),
      mailDebug: cfgBool(r.mailDebug, false),
      verboseProctitle: cfgBool(r.verboseProctitle, false),
      logTimestamp: cfgStr(r.logTimestamp, '%Y-%m-%d %H:%M:%S '),
    };
  },
  render: (v) => [
    MANAGED_MARKER,
    `auth_verbose = ${yn(v.authVerbose)}`,
    `auth_debug = ${yn(v.authDebug)}`,
    `mail_debug = ${yn(v.mailDebug)}`,
    `verbose_proctitle = ${yn(v.verboseProctitle)}`,
    v.logTimestamp.trim() ? `log_timestamp = "${v.logTimestamp}"` : '',
    '',
  ].filter(Boolean).join('\n'),
};

// ── 50-robin-limits.conf ─────────────────────────────────────────────────────
export interface DovecotLimitsFile extends Record<string, unknown> {
  defaultProcessLimit: number;
  defaultClientLimit: number;
  defaultVszLimit: string;
  imapProcessLimit: number;
  imapLoginProcessLimit: number;
}
const limitsFile: ManagedFileDef<DovecotLimitsFile> = {
  key: 'limits',
  fileName: '50-robin-limits.conf',
  defaults: { defaultProcessLimit: 100, defaultClientLimit: 1000, defaultVszLimit: '256M', imapProcessLimit: 1024, imapLoginProcessLimit: 0 },
  normalize: (raw) => {
    const r = cfgRecord(raw);
    return {
      defaultProcessLimit: Math.max(1, cfgNum(r.defaultProcessLimit, 100)),
      defaultClientLimit: Math.max(1, cfgNum(r.defaultClientLimit, 1000)),
      defaultVszLimit: cfgStr(r.defaultVszLimit, '256M'),
      imapProcessLimit: Math.max(0, cfgNum(r.imapProcessLimit, 1024)),
      imapLoginProcessLimit: Math.max(0, cfgNum(r.imapLoginProcessLimit, 0)),
    };
  },
  render: (v) => [
    MANAGED_MARKER,
    `default_process_limit = ${v.defaultProcessLimit}`,
    `default_client_limit = ${v.defaultClientLimit}`,
    v.defaultVszLimit.trim() ? `default_vsz_limit = ${v.defaultVszLimit.trim()}` : '',
    v.imapProcessLimit > 0 ? `service imap {\n  process_limit = ${v.imapProcessLimit}\n}` : '',
    v.imapLoginProcessLimit > 0 ? `service imap-login {\n  process_limit = ${v.imapLoginProcessLimit}\n}` : '',
    '',
  ].filter(Boolean).join('\n'),
};

// ── 50-robin-lmtp.conf ───────────────────────────────────────────────────────
export interface DovecotLmtpFile extends Record<string, unknown> {
  postmasterAddress: string;
  hostname: string;
  lmtpRcptCheckQuota: boolean;
  lmtpSaveToDetailMailbox: boolean;
}
const lmtpFile: ManagedFileDef<DovecotLmtpFile> = {
  key: 'lmtp',
  fileName: '50-robin-lmtp.conf',
  defaults: { postmasterAddress: 'postmaster@example.com', hostname: '', lmtpRcptCheckQuota: false, lmtpSaveToDetailMailbox: false },
  normalize: (raw) => {
    const r = cfgRecord(raw);
    return {
      postmasterAddress: cfgStr(r.postmasterAddress, 'postmaster@example.com'),
      hostname: cfgStr(r.hostname, ''),
      lmtpRcptCheckQuota: cfgBool(r.lmtpRcptCheckQuota, false),
      lmtpSaveToDetailMailbox: cfgBool(r.lmtpSaveToDetailMailbox, false),
    };
  },
  // postmaster_address goes inside `protocol lmtp {}`: a global value would be
  // shadowed by any lmtp block the host's own config already has.
  render: (v) => [
    MANAGED_MARKER,
    v.hostname.trim() ? `hostname = ${v.hostname.trim()}` : '',
    'protocol lmtp {',
    v.postmasterAddress.trim() ? `  postmaster_address = ${v.postmasterAddress.trim()}` : '',
    `  lmtp_rcpt_check_quota = ${yn(v.lmtpRcptCheckQuota)}`,
    `  lmtp_save_to_detail_mailbox = ${yn(v.lmtpSaveToDetailMailbox)}`,
    '}',
    '',
  ].filter(Boolean).join('\n'),
};

// ── 50-robin-mail.conf ───────────────────────────────────────────────────────
const FSYNC = ['optimized', 'always', 'never'] as const;
export interface DovecotMailFile extends Record<string, unknown> {
  mailFsync: typeof FSYNC[number];
  firstValidUid: number;
  mmapDisable: boolean;
  mailNfsStorage: boolean;
}
const mailFile: ManagedFileDef<DovecotMailFile> = {
  key: 'mail',
  fileName: '50-robin-mail.conf',
  defaults: { mailFsync: 'optimized', firstValidUid: 1000, mmapDisable: false, mailNfsStorage: false },
  normalize: (raw) => {
    const r = cfgRecord(raw);
    return {
      mailFsync: cfgOneOf(r.mailFsync, FSYNC, 'optimized'),
      firstValidUid: Math.max(0, cfgNum(r.firstValidUid, 1000)),
      mmapDisable: cfgBool(r.mmapDisable, false),
      mailNfsStorage: cfgBool(r.mailNfsStorage, false),
    };
  },
  render: (v) => [
    MANAGED_MARKER,
    `mail_fsync = ${v.mailFsync}`,
    `first_valid_uid = ${v.firstValidUid}`,
    `mmap_disable = ${yn(v.mmapDisable)}`,
    `mail_nfs_storage = ${yn(v.mailNfsStorage)}`,
    '',
  ].filter(Boolean).join('\n'),
};

export const DOVECOT_MANAGED_FILES: ManagedFileDef[] = [
  asManagedFileDef(loggingFile),
  asManagedFileDef(limitsFile),
  asManagedFileDef(lmtpFile),
  asManagedFileDef(mailFile),
];

export const DOVECOT_MANAGED_FILES_BY_KEY: Record<string, ManagedFileDef> =
  Object.fromEntries(DOVECOT_MANAGED_FILES.map((f) => [f.key, f]));
