/**
 * Per-file managed config for Postfix, following the shared per-file model.
 * Additive to the existing robin-managed.cf (limits/rate) + header/body checks:
 * these render focused `postconf`-style include files for the biggest gaps — TLS,
 * SMTP restrictions, and milter integration. Each is a `key = value` block a host
 * applies via `postconf -e` (or a main.cf include).
 */

import {
  MANAGED_MARKER,
  asManagedFileDef,
  cfgBool,
  cfgOneOf,
  cfgRecord,
  cfgStr,
  type ManagedFileDef,
} from './managed-config-file.js';

const yn = (b: boolean) => (b ? 'yes' : 'no');
/** Render `key = value` only when the value is non-empty (postconf leaves the rest at defaults). */
function kv(key: string, value: string): string {
  return value.trim() ? `${key} = ${value.trim()}` : '';
}

// ── robin-tls.cf ─────────────────────────────────────────────────────────────
const TLS_LEVELS = ['none', 'may', 'encrypt'] as const;
export interface PostfixTlsFile extends Record<string, unknown> {
  smtpdTlsSecurityLevel: typeof TLS_LEVELS[number];
  smtpTlsSecurityLevel: typeof TLS_LEVELS[number];
  smtpdTlsProtocols: string;
  smtpdTlsCertFile: string;
  smtpdTlsKeyFile: string;
  smtpdTlsAuthOnly: boolean;
}
const tlsFile: ManagedFileDef<PostfixTlsFile> = {
  key: 'tls',
  fileName: 'robin-tls.cf',
  defaults: {
    smtpdTlsSecurityLevel: 'may', smtpTlsSecurityLevel: 'may',
    smtpdTlsProtocols: '>=TLSv1.2', smtpdTlsCertFile: '', smtpdTlsKeyFile: '', smtpdTlsAuthOnly: true,
  },
  normalize: (raw) => {
    const r = cfgRecord(raw);
    return {
      smtpdTlsSecurityLevel: cfgOneOf(r.smtpdTlsSecurityLevel, TLS_LEVELS, 'may'),
      smtpTlsSecurityLevel: cfgOneOf(r.smtpTlsSecurityLevel, TLS_LEVELS, 'may'),
      smtpdTlsProtocols: cfgStr(r.smtpdTlsProtocols, '>=TLSv1.2'),
      smtpdTlsCertFile: cfgStr(r.smtpdTlsCertFile, ''),
      smtpdTlsKeyFile: cfgStr(r.smtpdTlsKeyFile, ''),
      smtpdTlsAuthOnly: cfgBool(r.smtpdTlsAuthOnly, true),
    };
  },
  render: (v) => [
    MANAGED_MARKER,
    `smtpd_tls_security_level = ${v.smtpdTlsSecurityLevel}`,
    `smtp_tls_security_level = ${v.smtpTlsSecurityLevel}`,
    kv('smtpd_tls_protocols', v.smtpdTlsProtocols),
    kv('smtpd_tls_cert_file', v.smtpdTlsCertFile),
    kv('smtpd_tls_key_file', v.smtpdTlsKeyFile),
    `smtpd_tls_auth_only = ${yn(v.smtpdTlsAuthOnly)}`,
    '',
  ].filter(Boolean).join('\n'),
};

// ── robin-restrictions.cf ────────────────────────────────────────────────────
export interface PostfixRestrictionsFile extends Record<string, unknown> {
  smtpdHeloRequired: boolean;
  smtpdHeloRestrictions: string;
  smtpdSenderRestrictions: string;
  smtpdRecipientRestrictions: string;
  smtpdRelayRestrictions: string;
}
const restrictionsFile: ManagedFileDef<PostfixRestrictionsFile> = {
  key: 'restrictions',
  fileName: 'robin-restrictions.cf',
  defaults: {
    smtpdHeloRequired: true,
    smtpdHeloRestrictions: 'permit_mynetworks, reject_invalid_helo_hostname',
    smtpdSenderRestrictions: 'reject_unknown_sender_domain',
    smtpdRecipientRestrictions: '',
    smtpdRelayRestrictions: 'permit_mynetworks, reject_unauth_destination',
  },
  normalize: (raw) => {
    const r = cfgRecord(raw);
    return {
      smtpdHeloRequired: cfgBool(r.smtpdHeloRequired, true),
      smtpdHeloRestrictions: cfgStr(r.smtpdHeloRestrictions, 'permit_mynetworks, reject_invalid_helo_hostname'),
      smtpdSenderRestrictions: cfgStr(r.smtpdSenderRestrictions, 'reject_unknown_sender_domain'),
      smtpdRecipientRestrictions: cfgStr(r.smtpdRecipientRestrictions, ''),
      smtpdRelayRestrictions: cfgStr(r.smtpdRelayRestrictions, 'permit_mynetworks, reject_unauth_destination'),
    };
  },
  render: (v) => [
    MANAGED_MARKER,
    `smtpd_helo_required = ${yn(v.smtpdHeloRequired)}`,
    kv('smtpd_helo_restrictions', v.smtpdHeloRestrictions),
    kv('smtpd_sender_restrictions', v.smtpdSenderRestrictions),
    kv('smtpd_recipient_restrictions', v.smtpdRecipientRestrictions),
    kv('smtpd_relay_restrictions', v.smtpdRelayRestrictions),
    '',
  ].filter(Boolean).join('\n'),
};

// ── robin-milters.cf — rspamd / opendkim integration ────────────────────────
const MILTER_ACTIONS = ['accept', 'reject', 'tempfail', 'quarantine'] as const;
const MILTER_PROTOS = ['2', '3', '4', '6'] as const;
export interface PostfixMiltersFile extends Record<string, unknown> {
  smtpdMilters: string;
  nonSmtpdMilters: string;
  milterDefaultAction: typeof MILTER_ACTIONS[number];
  milterProtocol: typeof MILTER_PROTOS[number];
}
const miltersFile: ManagedFileDef<PostfixMiltersFile> = {
  key: 'milters',
  fileName: 'robin-milters.cf',
  defaults: { smtpdMilters: '', nonSmtpdMilters: '', milterDefaultAction: 'accept', milterProtocol: '6' },
  normalize: (raw) => {
    const r = cfgRecord(raw);
    return {
      smtpdMilters: cfgStr(r.smtpdMilters, ''),
      nonSmtpdMilters: cfgStr(r.nonSmtpdMilters, ''),
      milterDefaultAction: cfgOneOf(r.milterDefaultAction, MILTER_ACTIONS, 'accept'),
      milterProtocol: cfgOneOf(r.milterProtocol, MILTER_PROTOS, '6'),
    };
  },
  render: (v) => [
    MANAGED_MARKER,
    kv('smtpd_milters', v.smtpdMilters),
    kv('non_smtpd_milters', v.nonSmtpdMilters),
    `milter_default_action = ${v.milterDefaultAction}`,
    `milter_protocol = ${v.milterProtocol}`,
    '',
  ].filter(Boolean).join('\n'),
};

export const POSTFIX_MANAGED_FILES: ManagedFileDef[] = [
  asManagedFileDef(tlsFile),
  asManagedFileDef(restrictionsFile),
  asManagedFileDef(miltersFile),
];

export const POSTFIX_MANAGED_FILES_BY_KEY: Record<string, ManagedFileDef> =
  Object.fromEntries(POSTFIX_MANAGED_FILES.map((f) => [f.key, f]));
