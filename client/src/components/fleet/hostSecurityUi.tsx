import { useState, type ReactNode } from 'react';
import { Button } from '../ui/Button';
import type { HostSecuritySectionName, HostSecurityStatus } from '../../types/host-security';

export const hostSecuritySectionLabels: Record<HostSecuritySectionName, string> = {
  sshKeys: 'Authorized SSH keys', sshd: 'SSH settings', accounts: 'Login accounts',
  privilegedGroups: 'Privileged groups', sudoers: 'Sudo rules', cron: 'Scheduled jobs',
  systemd: 'Enabled units', listeners: 'Network listeners', firewall: 'Firewall',
  patching: 'Security maintenance', integrity: 'File integrity',
};

const statusStyles = {
  neutral: 'bg-gray-100 text-gray-700 dark:bg-robin-gray-700 dark:text-gray-200',
  success: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  warning: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  info: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
};

export function SecurityBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: keyof typeof statusStyles }) {
  return <span className={'inline-flex rounded-full px-2 py-0.5 text-xs font-medium ' + statusStyles[tone]}>{children}</span>;
}

export function CoverageBadge({ status, complete }: { status: HostSecurityStatus; complete: boolean }) {
  if (status === 'not_permitted') return <SecurityBadge tone="warning">Permission denied</SecurityBadge>;
  if (status === 'not_available') return <SecurityBadge>Unavailable</SecurityBadge>;
  return complete ? <SecurityBadge tone="success">Complete</SecurityBadge> : <SecurityBadge tone="warning">Partial</SecurityBadge>;
}

export function SecurityError({
  error, label, retry, isRetrying,
}: {
  error: unknown; label: string; retry?: () => void; isRetrying?: boolean;
}) {
  if (!error) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
      <div>
        <p className="font-medium">{label}</p>
        <p>{error instanceof Error ? error.message : String(error)}</p>
      </div>
      {retry && <Button variant="secondary" size="sm" onClick={retry} disabled={isRetrying}>Retry</Button>}
    </div>
  );
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const utcDateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

export function SecurityTime({ value, utc = false }: { value: string; utc?: boolean }) {
  return <time dateTime={value} title={value}>{(utc ? utcDateTime : dateTime).format(new Date(value))}{utc && ' UTC'}</time>;
}

export function useSecurityPagination() {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  return {
    cursor: cursors[cursors.length - 1],
    page: cursors.length,
    next: (cursor: string) => setCursors(previous => [...previous, cursor]),
    previous: () => setCursors(previous => previous.length > 1 ? previous.slice(0, -1) : previous),
    reset: () => setCursors([undefined]),
  };
}

export function SecurityPagination({
  pagination, nextCursor, busy,
}: {
  pagination: ReturnType<typeof useSecurityPagination>; nextCursor?: string | null; busy?: boolean;
}) {
  if (pagination.page === 1 && !nextCursor) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 px-4 py-3 dark:border-robin-gray-700">
      <span className="text-sm text-gray-500 dark:text-gray-400">Page {pagination.page}</span>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={pagination.page === 1 || busy} onClick={pagination.previous}>Previous</Button>
        <Button variant="secondary" size="sm" disabled={!nextCursor || busy} onClick={() => { if (nextCursor) pagination.next(nextCursor); }}>Next</Button>
      </div>
    </div>
  );
}

const fieldLabels: Record<string, string> = {
  bits: 'Key size', comment: 'Key label', fingerprint: 'Fingerprint', uid: 'UID',
  nopasswd: 'Passwordless sudo', os: 'OS', sha256: 'SHA-256',
  inbound: 'Default inbound policy', pending: 'Pending upgrades', security: 'Security upgrades',
  rebootRequired: 'Reboot required', rebootSince: 'Reboot pending since',
};

export function securityFieldLabel(field: string) {
  return fieldLabels[field] ?? field.replace(/^[a-z]/, letter => letter.toUpperCase());
}

export function securityFieldValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  return String(value);
}
