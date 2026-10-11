import type { MonitoringStatus } from './monitoring.js';

export const STATUS_PAGE_COMPONENT_STATUSES = ['operational', 'degraded', 'outage', 'maintenance', 'unknown'] as const;
export const STATUS_PAGE_REPORT_STATUSES = ['open', 'resolved'] as const;
export const STATUS_PAGE_UPDATE_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
export const STATUS_PAGE_REPORT_IMPACTS = ['degraded', 'outage', 'maintenance'] as const;
export const STATUS_PAGE_REPORT_SOURCES = ['automatic', 'manual', 'imported'] as const;
export const STATUS_PAGE_MAINTENANCE_STATUSES = ['scheduled', 'active', 'completed', 'cancelled'] as const;

export type StatusPageComponentStatus = (typeof STATUS_PAGE_COMPONENT_STATUSES)[number];
export type StatusPageReportStatus = (typeof STATUS_PAGE_REPORT_STATUSES)[number];
export type StatusPageUpdateStatus = (typeof STATUS_PAGE_UPDATE_STATUSES)[number];
export type StatusPageReportImpact = (typeof STATUS_PAGE_REPORT_IMPACTS)[number];
export type StatusPageReportSource = (typeof STATUS_PAGE_REPORT_SOURCES)[number];
export type StatusPageMaintenanceStatus = (typeof STATUS_PAGE_MAINTENANCE_STATUSES)[number];

export interface StatusPageSettings {
  id: number;
  companyName: string;
  companyUrl: string | null;
  logoUrl: string | null;
  customDomain: string | null;
  published: boolean;
  historyDays: number;
  timezone: string;
  theme: 'system' | 'light' | 'dark';
  announcement: string | null;
  subscribable: boolean;
  /** The Previous incidents archive and a page per incident. */
  incidentHistoryEnabled: boolean;
  /** The Maintenance page with upcoming and past windows. */
  maintenancePageEnabled: boolean;
  /** RSS and JSON feeds of incidents. */
  feedsEnabled: boolean;
  /** Monitoring issues opening while an automatic incident is open, or this many minutes after it resolved, join it; 0 gives every issue its own incident. */
  incidentGroupingMinutes: number;
  /** How many days of resolved incidents the main page lists; 0 lists none. */
  homeIncidentDays: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface StatusPageSection {
  id: number;
  name: string;
  position: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface StatusPageComponentCheck {
  checkId: number;
  checkName: string;
  targetName: string;
  targetEnvironment: string;
  checkType: string;
  endpoint: string;
  port: number | null;
  currentStatus: MonitoringStatus;
  lastRunAt: Date | null;
  lastError: string | null;
}

export interface StatusPageComponent {
  id: number;
  sectionId: number;
  sectionName: string;
  publicName: string;
  description: string | null;
  position: number;
  enabled: boolean;
  showHistory: boolean;
  createdAt: Date;
  updatedAt: Date;
  checks: StatusPageComponentCheck[];
  status: StatusPageComponentStatus;
  statusReason: string | null;
  history: StatusPageHistoryDay[];
  /** Share of the linked checks' observations that were reachable over the history window, 0-100. */
  uptimePercent: number | null;
}

export interface StatusPageHistoryDay {
  day: string;
  status: StatusPageComponentStatus;
  outageMinutes: number;
  maintenanceMinutes: number;
}

export interface StatusPageReportUpdate {
  id: number;
  reportId: number;
  status: StatusPageUpdateStatus;
  message: string;
  createdAt: Date;
}

export interface StatusPageReport {
  id: number;
  title: string;
  status: StatusPageReportStatus;
  impact: StatusPageReportImpact;
  source: StatusPageReportSource;
  openedAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  components: Array<{ id: number; publicName: string; status: StatusPageComponentStatus }>;
  updates: StatusPageReportUpdate[];
}

export interface StatusPageMaintenance {
  id: number;
  title: string;
  message: string;
  status: StatusPageMaintenanceStatus;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
  updatedAt: Date;
  components: Array<{ id: number; publicName: string }>;
}

export interface StatusPageAdminSummary {
  settings: StatusPageSettings;
  sections: StatusPageSection[];
  components: StatusPageComponent[];
  reports: StatusPageReport[];
  maintenances: StatusPageMaintenance[];
}

// ── Public page ───────────────────────────────────────────────────────────────
// What anyone can read: public names and statuses only. Monitoring checks,
// targets, endpoints, error text and internal ids stay on the admin side.

export interface PublicStatusPageSettings {
  companyName: string;
  companyUrl: string | null;
  logoUrl: string | null;
  historyDays: number;
  timezone: string;
  theme: 'system' | 'light' | 'dark';
  announcement: string | null;
  subscribable: boolean;
  incidentHistoryEnabled: boolean;
  maintenancePageEnabled: boolean;
  feedsEnabled: boolean;
}

export interface PublicStatusPageComponent {
  id: number;
  publicName: string;
  description: string | null;
  showHistory: boolean;
  status: StatusPageComponentStatus;
  statusReason: string | null;
  history: StatusPageHistoryDay[];
  uptimePercent: number | null;
}

export interface PublicStatusPageReport {
  id: number;
  title: string;
  status: StatusPageReportStatus;
  impact: StatusPageReportImpact;
  openedAt: Date;
  resolvedAt: Date | null;
  components: Array<{ id: number; publicName: string; status: StatusPageComponentStatus }>;
  updates: Array<{ id: number; status: StatusPageUpdateStatus; message: string; createdAt: Date }>;
}

export interface PublicStatusPageMaintenance {
  id: number;
  title: string;
  message: string;
  status: StatusPageMaintenanceStatus;
  startsAt: Date;
  endsAt: Date;
  components: Array<{ id: number; publicName: string }>;
}

export interface PublicStatusPage {
  settings: PublicStatusPageSettings;
  aggregateStatus: StatusPageComponentStatus;
  sections: Array<{ id: number; name: string; components: PublicStatusPageComponent[] }>;
  activeReports: PublicStatusPageReport[];
  recentReports: PublicStatusPageReport[];
  maintenances: PublicStatusPageMaintenance[];
  generatedAt: Date;
}

/** A window of whole months, newest first, in the page's timezone. */
export interface PublicIncidentArchive {
  from: string;
  to: string;
  months: Array<{ month: string; reports: PublicStatusPageReport[] }>;
  hasOlder: boolean;
  hasNewer: boolean;
}

/** A window of whole months, oldest first, in the page's timezone. */
export interface PublicMaintenanceSchedule {
  from: string;
  to: string;
  months: Array<{ month: string; maintenances: PublicStatusPageMaintenance[] }>;
  hasOlder: boolean;
  hasNewer: boolean;
}

/** One past incident to import, for example from another status page. */
export interface StatusPageReportImport {
  title: string;
  impact: StatusPageReportImpact;
  openedAt: Date;
  resolvedAt: Date | null;
  /** Public component names; names with no matching component are skipped and reported back. */
  components: string[];
  updates: Array<{ status: StatusPageUpdateStatus; message: string; createdAt: Date }>;
}

export interface StatusPageReportImportResult {
  imported: number;
  skipped: number;
  unknownComponents: string[];
}
