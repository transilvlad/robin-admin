export type HostSecurityStatus = 'ok' | 'not_permitted' | 'not_available';

export interface HostSecurityValues {
  sshKeys: { user: string; file: string; fingerprint: string; type: string; bits: number | null; comment: string; options: string[] };
  sshd: { name: string; value: string };
  accounts: { user: string; uid: number; shell: string; home: string };
  privilegedGroups: { group: string; members: string[] };
  sudoers: { file: string; rule: string; nopasswd: boolean };
  cron: { file: string; sha256: string; lines: number };
  systemd: { unit: string; state: string };
  listeners: { protocol: 'tcp' | 'udp'; address: string; port: number; process: string | null };
  firewall: { backend: 'nftables' | 'iptables' | 'ufw' | 'unknown'; inbound: 'accept' | 'drop' | 'unknown' };
  patching: { pending: number | null; security: number | null; rebootRequired: boolean | null; rebootSince: string | null; kernel: string; os: string };
  integrity: { path: string; sha256: string };
}

export type HostSecuritySectionName = keyof HostSecurityValues;

export interface HostSecurityItem<T> {
  id: string;
  value: T;
}

export interface HostSecuritySection<T> {
  status: HostSecurityStatus;
  complete: boolean;
  items: HostSecurityItem<T>[];
  rootHash?: string;
}

export type HostSecuritySections = {
  [K in HostSecuritySectionName]: HostSecuritySection<HostSecurityValues[K]>;
};

export interface HostSecurityHeartbeat {
  version: 1;
  hash: string;
  observedAt: string;
  intervalSeconds: number;
  sections?: HostSecuritySections;
}

export interface HostSecuritySnapshot {
  id: string;
  hostId: string;
  hash: string;
  observedAt: string;
  receivedAt: string;
  sections: HostSecuritySections;
}

export type HostSecurityDiffItem = {
  [K in HostSecuritySectionName]: {
    id: string;
    section: K;
    itemId: string;
    change: 'added' | 'removed' | 'changed';
    before: HostSecurityValues[K] | null;
    after: HostSecurityValues[K] | null;
  };
}[HostSecuritySectionName];

export interface HostSecurityDiff {
  snapshotId: string;
  baselineRevision: number;
  baselinePending: boolean;
  items: HostSecurityDiffItem[];
}

export interface HostSecurityApprovalSummary {
  revision: number;
  approvedAt: string;
  approver: string;
  reason: string | null;
}

export interface HostSecurityCurrentDiff extends HostSecurityDiff {
  lastApproval: HostSecurityApprovalSummary | null;
}

export interface HostSecurityApproval {
  snapshotId: string;
  baselineRevision: number;
  itemIds?: string[];
  reason?: string;
}

export type HostSecurityEventType =
  | 'login' | 'sudo' | 'su' | 'user_change' | 'group_change' | 'password_change'
  | 'sshd_reload' | 'fail2ban_ban' | 'fail2ban_unban' | 'auditd';

export interface HostSecurityEventInput {
  id: string;
  observedAt: string;
  type: HostSecurityEventType;
  user?: string;
  sourceIp?: string;
  authMethod?: string;
  keyFingerprint?: string;
  process: string;
  line: string;
}

export interface HostSecurityEvent extends HostSecurityEventInput {
  hostId: string;
  snapshotId: string | null;
  baselineRevision: number | null;
  knownAddressId: string | null;
}

export interface HostSecurityCounter {
  minute: string;
  invalidUser: number;
  failedKey: number;
  failedPassword: number;
  successful: number;
  distinctFailedSources: number;
}

export interface HostSecurityEventBatch {
  version: 1;
  batchId: string;
  events: HostSecurityEventInput[];
  counters: HostSecurityCounter[];
}

export interface HostSecurityKnownAddress {
  id: string;
  network: string;
  label: string;
  expiresAt: string | null;
}

export interface HostSecurityPosture {
  hostId: string;
  name: string;
  snapshotId: string;
  baselinePending: boolean;
  unapprovedDrift: number;
  coverageGapCount: number;
  passwordLoginEnabled: boolean | null;
  unknownLogins24h: number;
  patchAgeDays: number | null;
  lastReceivedAt: string;
  stale: boolean;
}

export interface HostSecurityPage<T> {
  items: T[];
  nextCursor: string | null;
}
