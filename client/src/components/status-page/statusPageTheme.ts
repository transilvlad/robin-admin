import { AlertTriangle, CheckCircle2, HelpCircle, Wrench } from 'lucide-react';
import type {
  PublicStatusPageReport,
  StatusPageComponentStatus,
  StatusPageMaintenanceStatus,
  StatusPageUpdateStatus,
} from '../../types/status-page';

export const STATUS_COPY: Record<StatusPageComponentStatus, { label: string; light: string; dark: string; icon: typeof CheckCircle2 }> = {
  operational: { label: 'Operational', light: 'border-green-200 bg-green-50 text-green-700 ring-green-200', dark: 'border-green-500/30 bg-green-500/10 text-green-300 ring-green-500/30', icon: CheckCircle2 },
  degraded: { label: 'Degraded', light: 'border-amber-200 bg-amber-50 text-amber-700 ring-amber-200', dark: 'border-amber-500/30 bg-amber-500/10 text-amber-300 ring-amber-500/30', icon: AlertTriangle },
  outage: { label: 'Outage', light: 'border-red-200 bg-red-50 text-red-700 ring-red-200', dark: 'border-red-500/30 bg-red-500/10 text-red-300 ring-red-500/30', icon: AlertTriangle },
  maintenance: { label: 'Maintenance', light: 'border-blue-200 bg-blue-50 text-blue-700 ring-blue-200', dark: 'border-blue-500/30 bg-blue-500/10 text-blue-300 ring-blue-500/30', icon: Wrench },
  unknown: { label: 'Unknown', light: 'border-gray-200 bg-gray-100 text-gray-700 ring-gray-200', dark: 'border-gray-700 bg-gray-800 text-gray-200 ring-gray-700', icon: HelpCircle },
};

export const UPDATE_LABEL: Record<StatusPageUpdateStatus, string> = {
  investigating: 'Investigating',
  identified: 'Identified',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
};

export const MAINTENANCE_LABEL: Record<StatusPageMaintenanceStatus, string> = {
  scheduled: 'Scheduled',
  active: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export type StatusPalette = ReturnType<typeof pagePalette>;

export function pagePalette(isDark: boolean) {
  return isDark ? {
    page: 'bg-robin-gray-900 text-gray-100',
    header: 'border-robin-gray-700 bg-robin-gray-800',
    card: 'border-robin-gray-700 bg-robin-gray-800',
    cardHeader: 'border-robin-gray-700',
    divider: 'divide-y divide-robin-gray-700',
    inset: 'border-robin-gray-700 bg-robin-gray-900/60',
    muted: 'text-gray-400',
    subtleText: 'text-gray-300',
    link: 'text-gray-100 hover:text-robin-orange',
    tabActive: 'bg-robin-gray-700 text-white',
    tabIdle: 'text-gray-400 hover:bg-robin-gray-700/60 hover:text-gray-100',
    button: 'border-robin-gray-600 bg-robin-gray-700 text-gray-100 hover:bg-robin-gray-600 disabled:opacity-40',
    announcement: 'border-blue-500/30 bg-blue-500/10 text-blue-200',
  } : {
    page: 'bg-gray-50 text-gray-950',
    header: 'border-gray-200 bg-white',
    card: 'border-gray-200 bg-white',
    cardHeader: 'border-gray-200',
    divider: 'divide-y divide-gray-100',
    inset: 'border-gray-200 bg-gray-50',
    muted: 'text-gray-500',
    subtleText: 'text-gray-600',
    link: 'text-gray-950 hover:text-robin-orange',
    tabActive: 'bg-gray-900 text-white',
    tabIdle: 'text-gray-600 hover:bg-gray-100 hover:text-gray-950',
    button: 'border-gray-300 bg-white text-gray-800 hover:bg-gray-50 disabled:opacity-40',
    announcement: 'border-blue-200 bg-blue-50 text-blue-800',
  };
}

export function statusClass(status: StatusPageComponentStatus, isDark: boolean): string {
  const copy = STATUS_COPY[status];
  return isDark ? copy.dark : copy.light;
}

export function historyColor(status: StatusPageComponentStatus): string {
  return {
    operational: 'bg-green-500',
    degraded: 'bg-amber-500',
    outage: 'bg-red-500',
    maintenance: 'bg-blue-500',
    unknown: 'bg-gray-300',
  }[status];
}

/** The badge state of an incident: resolved, or its impact while it lasts. */
export function reportStatus(report: Pick<PublicStatusPageReport, 'status' | 'impact'>): StatusPageComponentStatus {
  if (report.status === 'resolved') return 'operational';
  return report.impact === 'outage' ? 'outage' : report.impact === 'maintenance' ? 'maintenance' : 'degraded';
}

function format(value: string | Date, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(new Date(value));
  } catch {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(new Date(value));
  }
}

export function formatDateTime(value: string, timeZone: string): string {
  return format(value, timeZone, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatDay(value: string, timeZone: string): string {
  return format(value, timeZone, { dateStyle: 'medium' });
}

/** "2026-09" as "September 2026". */
export function formatMonth(month: string): string {
  return format(`${month}-15T12:00:00Z`, 'UTC', { month: 'long', year: 'numeric' });
}

/** "2026-09" as "Sep 2026". */
export function formatShortMonth(month: string): string {
  return format(`${month}-15T12:00:00Z`, 'UTC', { month: 'short', year: 'numeric' });
}

/** The calendar day of an instant in the page's timezone, as YYYY-MM-DD. */
export function dayKey(value: string, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  }
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function shiftMonth(month: string, delta: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const index = year * 12 + (monthNumber - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

export function formatDuration(from: string, to: string | null): string {
  const minutes = Math.max(0, Math.round(((to ? new Date(to) : new Date()).getTime() - new Date(from).getTime()) / 60_000));
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest} min` : ''}`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

export function timeZoneLabel(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZone, timeZoneName: 'short' }).formatToParts(new Date());
    const name = parts.find((part) => part.type === 'timeZoneName')?.value;
    return name ? `${timeZone} (${name})` : timeZone;
  } catch {
    return 'UTC';
  }
}
