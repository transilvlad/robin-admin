import type { MonitoringStatus } from './monitoring';

export type StatusPageComponentStatus = 'operational' | 'degraded' | 'outage' | 'maintenance' | 'unknown';
export type StatusPageReportStatus = 'open' | 'resolved';
export type StatusPageUpdateStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';
export type StatusPageReportImpact = 'degraded' | 'outage' | 'maintenance';
export type StatusPageReportSource = 'automatic' | 'manual' | 'imported';
export type StatusPageMaintenanceStatus = 'scheduled' | 'active' | 'completed' | 'cancelled';

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
  createdAt: string;
  updatedAt: string;
}

export interface StatusPageSection {
  id: number;
  name: string;
  position: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
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
  lastRunAt: string | null;
  lastError: string | null;
}

export interface StatusPageHistoryDay {
  day: string;
  status: StatusPageComponentStatus;
  outageMinutes: number;
  maintenanceMinutes: number;
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
  createdAt: string;
  updatedAt: string;
  checks: StatusPageComponentCheck[];
  status: StatusPageComponentStatus;
  statusReason: string | null;
  history: StatusPageHistoryDay[];
  /** Share of the linked checks' observations that were reachable over the history window, 0-100. */
  uptimePercent: number | null;
}

export interface StatusPageReportUpdate {
  id: number;
  reportId: number;
  status: StatusPageUpdateStatus;
  message: string;
  createdAt: string;
}

export interface StatusPageReport {
  id: number;
  title: string;
  status: StatusPageReportStatus;
  impact: StatusPageReportImpact;
  source: StatusPageReportSource;
  openedAt: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  components: Array<{ id: number; publicName: string; status: StatusPageComponentStatus }>;
  updates: StatusPageReportUpdate[];
}

export interface StatusPageMaintenance {
  id: number;
  title: string;
  message: string;
  status: StatusPageMaintenanceStatus;
  startsAt: string;
  endsAt: string;
  createdAt: string;
  updatedAt: string;
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
  /** Null when history is hidden or nothing was observed. */
  uptimePercent: number | null;
}

export interface PublicStatusPageReport {
  id: number;
  title: string;
  status: StatusPageReportStatus;
  impact: StatusPageReportImpact;
  openedAt: string;
  resolvedAt: string | null;
  components: Array<{ id: number; publicName: string; status: StatusPageComponentStatus }>;
  updates: Array<{ id: number; status: StatusPageUpdateStatus; message: string; createdAt: string }>;
}

export interface PublicStatusPageMaintenance {
  id: number;
  title: string;
  message: string;
  status: StatusPageMaintenanceStatus;
  startsAt: string;
  endsAt: string;
  components: Array<{ id: number; publicName: string }>;
}

export interface PublicStatusPage {
  settings: PublicStatusPageSettings;
  aggregateStatus: StatusPageComponentStatus;
  sections: Array<{ id: number; name: string; components: PublicStatusPageComponent[] }>;
  activeReports: PublicStatusPageReport[];
  recentReports: PublicStatusPageReport[];
  maintenances: PublicStatusPageMaintenance[];
  generatedAt: string;
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

export interface StatusPageReportImportResult {
  imported: number;
  skipped: number;
  unknownComponents: string[];
}
