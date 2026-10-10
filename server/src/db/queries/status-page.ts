import { query } from '../connection.js';
import type {
  PublicIncidentArchive,
  PublicMaintenanceSchedule,
  PublicStatusPageComponent,
  PublicStatusPageMaintenance,
  PublicStatusPageReport,
  PublicStatusPage,
  StatusPageAdminSummary,
  StatusPageComponent,
  StatusPageComponentCheck,
  StatusPageComponentStatus,
  StatusPageHistoryDay,
  StatusPageMaintenance,
  StatusPageMaintenanceStatus,
  StatusPageReport,
  StatusPageReportImpact,
  StatusPageReportImport,
  StatusPageReportImportResult,
  StatusPageReportSource,
  StatusPageReportStatus,
  StatusPageReportUpdate,
  StatusPageUpdateStatus,
  StatusPageSection,
  StatusPageSettings,
} from '../../types/status-page.js';
import type { MonitoringStatus } from '../../types/monitoring.js';
import { listAdminEmailSubscriptions, listConfirmedStatusSubscribersForComponents } from './email.js';
import { enqueueStatusReportSubscriberEmail } from '../../services/email/messages.js';
import { config } from '../../config.js';

type JsonRecord = Record<string, unknown>;

interface SettingsRow {
  id: number;
  company_name: string;
  company_url: string | null;
  logo_url: string | null;
  custom_domain: string | null;
  published: boolean;
  history_days: number;
  timezone: string;
  theme: 'system' | 'light' | 'dark';
  announcement: string | null;
  subscribable: boolean;
  incident_history_enabled: boolean;
  maintenance_page_enabled: boolean;
  feeds_enabled: boolean;
  incident_grouping_minutes: number;
  home_incident_days: number;
  created_at: Date;
  updated_at: Date;
}

interface SectionRow {
  id: number;
  name: string;
  position: number;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

interface ComponentRow {
  id: number;
  section_id: number;
  section_name: string;
  public_name: string;
  description: string | null;
  position: number;
  enabled: boolean;
  show_history: boolean;
  created_at: Date;
  updated_at: Date;
}

interface ComponentCheckRow {
  component_id: number;
  check_id: number;
  check_name: string;
  target_name: string;
  target_environment: string;
  check_type: string;
  endpoint: string;
  port: number | null;
  current_status: MonitoringStatus;
  last_run_at: Date | null;
  last_error: string | null;
}

interface ReportRow {
  id: number;
  title: string;
  status: StatusPageReportStatus;
  impact: StatusPageReportImpact;
  source: StatusPageReportSource;
  opened_at: Date;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ReportComponentRow {
  report_id: number;
  component_id: number;
  public_name: string;
  status: StatusPageComponentStatus;
}

interface ReportUpdateRow {
  id: number;
  report_id: number;
  status: StatusPageUpdateStatus;
  message: string;
  created_at: Date;
}

interface MaintenanceRow {
  id: number;
  title: string;
  message: string;
  status: StatusPageMaintenanceStatus;
  starts_at: Date;
  ends_at: Date;
  created_at: Date;
  updated_at: Date;
}

interface MaintenanceComponentRow {
  maintenance_id: number;
  component_id: number;
  public_name: string;
}

interface LinkedIssueRow {
  issue_id: number;
  issue_status: 'open' | 'closed';
  severity: 'warning' | 'critical';
  summary: string;
  opened_at: Date;
  closed_at: Date | null;
  component_id: number;
  public_name: string;
}

interface SyncIssueRow {
  issue_id: number;
  issue_status: 'open' | 'closed';
  opened_at: Date;
  closed_at: Date | null;
  report_id: number | null;
}

interface ReportIssueRow {
  report_id: number;
  issue_id: number;
  issue_status: 'open' | 'closed';
  severity: 'warning' | 'critical';
  opened_at: Date;
  closed_at: Date | null;
  component_id: number;
  public_name: string;
}

const SETTINGS_COLUMNS = `
  id, company_name, company_url, logo_url, custom_domain, published, history_days,
  timezone, theme, announcement, subscribable, incident_history_enabled, maintenance_page_enabled,
  feeds_enabled, incident_grouping_minutes, home_incident_days, created_at, updated_at
`;
const SECTION_COLUMNS = 'id, name, position, enabled, created_at, updated_at';
const COMPONENT_COLUMNS = `
  c.id, c.section_id, s.name AS section_name, c.public_name, c.description, c.position,
  c.enabled, c.show_history, c.created_at, c.updated_at
`;
const REPORT_COLUMNS = `
  id, title, status, impact, source, opened_at, resolved_at, created_at, updated_at
`;
const MAINTENANCE_COLUMNS = 'id, title, message, status, starts_at, ends_at, created_at, updated_at';

function mapSettings(row: SettingsRow): StatusPageSettings {
  return {
    id: row.id,
    companyName: row.company_name,
    companyUrl: row.company_url,
    logoUrl: row.logo_url,
    customDomain: row.custom_domain,
    published: row.published,
    historyDays: row.history_days,
    timezone: row.timezone,
    theme: row.theme,
    announcement: row.announcement,
    subscribable: row.subscribable,
    incidentHistoryEnabled: row.incident_history_enabled,
    maintenancePageEnabled: row.maintenance_page_enabled,
    feedsEnabled: row.feeds_enabled,
    incidentGroupingMinutes: row.incident_grouping_minutes,
    homeIncidentDays: row.home_incident_days,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safePublicHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function mapSection(row: SectionRow): StatusPageSection {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function emptyHistory(days: number): StatusPageHistoryDay[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(today);
    day.setUTCDate(today.getUTCDate() - (days - index - 1));
    return {
      day: day.toISOString().slice(0, 10),
      status: 'operational',
      outageMinutes: 0,
      maintenanceMinutes: 0,
    };
  });
}

function mapComponent(row: ComponentRow, historyDays: number): StatusPageComponent {
  return {
    id: row.id,
    sectionId: row.section_id,
    sectionName: row.section_name,
    publicName: row.public_name,
    description: row.description,
    position: row.position,
    enabled: row.enabled,
    showHistory: row.show_history,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    checks: [],
    status: 'unknown',
    statusReason: null,
    history: emptyHistory(historyDays),
    uptimePercent: null,
  };
}

function mapComponentCheck(row: ComponentCheckRow): StatusPageComponentCheck {
  return {
    checkId: row.check_id,
    checkName: row.check_name,
    targetName: row.target_name,
    targetEnvironment: row.target_environment,
    checkType: row.check_type,
    endpoint: row.endpoint,
    port: row.port,
    currentStatus: row.current_status,
    lastRunAt: row.last_run_at,
    lastError: row.last_error,
  };
}

function mapReport(row: ReportRow): StatusPageReport {
  return {
    id: Number(row.id),
    title: row.title,
    status: row.status,
    impact: row.impact,
    source: row.source,
    openedAt: row.opened_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    components: [],
    updates: [],
  };
}

function mapReportUpdate(row: ReportUpdateRow): StatusPageReportUpdate {
  return {
    id: Number(row.id),
    reportId: Number(row.report_id),
    status: row.status,
    message: row.message,
    createdAt: row.created_at,
  };
}

function mapMaintenance(row: MaintenanceRow): StatusPageMaintenance {
  return {
    id: Number(row.id),
    title: row.title,
    message: row.message,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    components: [],
  };
}

function aggregateCheckStatus(checks: StatusPageComponentCheck[]): { status: StatusPageComponentStatus; reason: string | null } {
  if (checks.length === 0) {
    return { status: 'unknown', reason: 'No Monitoring checks are linked.' };
  }
  const down = checks.find((check) => check.currentStatus === 'down');
  if (down) return { status: 'outage', reason: down.lastError ?? `${down.checkName} is down` };
  const warning = checks.find((check) => check.currentStatus === 'warning');
  if (warning) return { status: 'degraded', reason: warning.lastError ?? `${warning.checkName} is warning` };
  const unknown = checks.find((check) => check.currentStatus === 'unknown');
  if (unknown) return { status: 'unknown', reason: `${unknown.checkName} has not run yet.` };
  return { status: 'operational', reason: null };
}

function aggregatePageStatus(components: StatusPageComponent[]): StatusPageComponentStatus {
  const enabled = components.filter((component) => component.enabled);
  if (enabled.some((component) => component.status === 'outage')) return 'outage';
  if (enabled.some((component) => component.status === 'degraded')) return 'degraded';
  if (enabled.some((component) => component.status === 'maintenance')) return 'maintenance';
  if (enabled.length === 0 || enabled.some((component) => component.status === 'unknown')) return 'unknown';
  return 'operational';
}

function currentMaintenanceApplies(maintenance: StatusPageMaintenance, componentId: number, now: Date): boolean {
  return maintenance.status !== 'cancelled'
    && maintenance.startsAt <= now
    && maintenance.endsAt >= now
    && maintenance.components.some((component) => component.id === componentId);
}

function impactToComponentStatus(impact: StatusPageReportImpact): StatusPageComponentStatus {
  if (impact === 'outage') return 'outage';
  if (impact === 'maintenance') return 'maintenance';
  return 'degraded';
}

export async function getStatusPageSettings(): Promise<StatusPageSettings> {
  const result = await query<SettingsRow>(`SELECT ${SETTINGS_COLUMNS} FROM status_page_settings WHERE id = 1`);
  return mapSettings(result.rows[0]);
}

export async function updateStatusPageSettings(input: Partial<{
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
  incidentHistoryEnabled: boolean;
  maintenancePageEnabled: boolean;
  feedsEnabled: boolean;
  incidentGroupingMinutes: number;
  homeIncidentDays: number;
}>): Promise<StatusPageSettings> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let index = 1;
  const add = (column: string, value: unknown) => {
    sets.push(`${column} = $${index++}`);
    values.push(value);
  };
  if (input.companyName !== undefined) add('company_name', input.companyName);
  if (input.companyUrl !== undefined) add('company_url', input.companyUrl);
  if (input.logoUrl !== undefined) add('logo_url', input.logoUrl);
  if (input.customDomain !== undefined) add('custom_domain', input.customDomain);
  if (input.published !== undefined) add('published', input.published);
  if (input.historyDays !== undefined) add('history_days', input.historyDays);
  if (input.timezone !== undefined) add('timezone', input.timezone);
  if (input.theme !== undefined) add('theme', input.theme);
  if (input.announcement !== undefined) add('announcement', input.announcement);
  if (input.subscribable !== undefined) add('subscribable', input.subscribable);
  if (input.incidentHistoryEnabled !== undefined) add('incident_history_enabled', input.incidentHistoryEnabled);
  if (input.maintenancePageEnabled !== undefined) add('maintenance_page_enabled', input.maintenancePageEnabled);
  if (input.feedsEnabled !== undefined) add('feeds_enabled', input.feedsEnabled);
  if (input.incidentGroupingMinutes !== undefined) add('incident_grouping_minutes', input.incidentGroupingMinutes);
  if (input.homeIncidentDays !== undefined) add('home_incident_days', input.homeIncidentDays);
  if (sets.length === 0) return getStatusPageSettings();
  sets.push('updated_at = CURRENT_TIMESTAMP');
  const result = await query<SettingsRow>(
    `UPDATE status_page_settings SET ${sets.join(', ')} WHERE id = 1 RETURNING ${SETTINGS_COLUMNS}`,
    values
  );
  return mapSettings(result.rows[0]);
}

export async function listStatusPageSections(): Promise<StatusPageSection[]> {
  const result = await query<SectionRow>(
    `SELECT ${SECTION_COLUMNS}
     FROM status_page_sections
     ORDER BY position ASC, id ASC`
  );
  return result.rows.map(mapSection);
}

export async function upsertStatusPageSection(input: {
  id?: number | null;
  name: string;
  position: number;
  enabled: boolean;
}): Promise<StatusPageSection> {
  if (input.id) {
    const result = await query<SectionRow>(
      `UPDATE status_page_sections
       SET name = $2, position = $3, enabled = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING ${SECTION_COLUMNS}`,
      [input.id, input.name, input.position, input.enabled]
    );
    return mapSection(result.rows[0]);
  }
  const result = await query<SectionRow>(
    `INSERT INTO status_page_sections (name, position, enabled)
     VALUES ($1, $2, $3)
     RETURNING ${SECTION_COLUMNS}`,
    [input.name, input.position, input.enabled]
  );
  return mapSection(result.rows[0]);
}

export async function deleteStatusPageSection(id: number): Promise<boolean> {
  const result = await query(`DELETE FROM status_page_sections WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function listStatusPageComponents(historyDays = 30): Promise<StatusPageComponent[]> {
  const componentResult = await query<ComponentRow>(
    `SELECT ${COMPONENT_COLUMNS}
     FROM status_page_components c
     JOIN status_page_sections s ON s.id = c.section_id
     ORDER BY s.position ASC, c.position ASC, c.id ASC`
  );
  const components = componentResult.rows.map((row) => mapComponent(row, historyDays));
  await attachComponentChecks(components);
  await attachComponentHistory(components, historyDays);
  return components;
}

async function attachComponentChecks(components: StatusPageComponent[]): Promise<void> {
  if (components.length === 0) return;
  const result = await query<ComponentCheckRow>(
    `SELECT scc.component_id, c.id AS check_id, c.name AS check_name, t.name AS target_name,
            t.environment AS target_environment, c.check_type, c.endpoint, c.port,
            c.current_status, c.last_run_at, c.last_error
     FROM status_page_component_checks scc
     JOIN monitoring_checks c ON c.id = scc.check_id
     JOIN monitoring_targets t ON t.id = c.target_id
     WHERE scc.component_id = ANY($1::int[])
     ORDER BY c.name ASC, c.id ASC`,
    [components.map((component) => component.id)]
  );
  const byComponentId = new Map<number, StatusPageComponentCheck[]>();
  for (const row of result.rows) {
    const checks = byComponentId.get(row.component_id) ?? [];
    checks.push(mapComponentCheck(row));
    byComponentId.set(row.component_id, checks);
  }
  for (const component of components) {
    component.checks = byComponentId.get(component.id) ?? [];
    const status = aggregateCheckStatus(component.checks);
    component.status = status.status;
    component.statusReason = status.reason;
  }
}

async function attachComponentHistory(components: StatusPageComponent[], historyDays: number): Promise<void> {
  if (components.length === 0) return;
  const issueResult = await query<LinkedIssueRow>(
    `SELECT i.id AS issue_id, i.status AS issue_status, i.severity, i.summary, i.opened_at, i.closed_at,
            scc.component_id, c.public_name
     FROM monitoring_issues i
     JOIN status_page_component_checks scc ON scc.check_id = i.check_id
     JOIN status_page_components c ON c.id = scc.component_id
     WHERE i.opened_at >= CURRENT_DATE - ($1::int * INTERVAL '1 day')`,
    [historyDays]
  );
  const maintenanceResult = await query<MaintenanceComponentRow & { starts_at: Date; ends_at: Date; status: StatusPageMaintenanceStatus }>(
    `SELECT smc.maintenance_id, smc.component_id, c.public_name, m.starts_at, m.ends_at, m.status
     FROM status_page_maintenance_components smc
     JOIN status_page_components c ON c.id = smc.component_id
     JOIN status_page_maintenances m ON m.id = smc.maintenance_id
     WHERE m.status <> 'cancelled'
       AND m.ends_at >= CURRENT_DATE - ($1::int * INTERVAL '1 day')`,
    [historyDays]
  );
  const uptimeResult = await query<{ component_id: number; reachable: string; total: string }>(
    `SELECT scc.component_id,
            SUM(d.up_count + d.warning_count - d.unavailable_warning_count) AS reachable,
            SUM(d.up_count + d.warning_count + d.down_count) AS total
     FROM status_page_component_checks scc
     JOIN monitoring_check_daily d ON d.check_id = scc.check_id
     WHERE d.day > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - $1::int
     GROUP BY scc.component_id`,
    [historyDays]
  );
  const componentsById = new Map(components.map((component) => [component.id, component]));
  for (const row of uptimeResult.rows) {
    const component = componentsById.get(row.component_id);
    const total = Number(row.total);
    if (component && total > 0) component.uptimePercent = Math.round((Number(row.reachable) / total) * 100000) / 1000;
  }
  for (const issue of issueResult.rows) {
    const component = componentsById.get(issue.component_id);
    if (!component) continue;
    markHistory(component.history, issue.opened_at, issue.closed_at ?? new Date(), issue.severity === 'critical' ? 'outage' : 'degraded');
  }
  for (const maintenance of maintenanceResult.rows) {
    const component = componentsById.get(maintenance.component_id);
    if (!component) continue;
    markHistory(component.history, maintenance.starts_at, maintenance.ends_at, 'maintenance');
  }
}

function markHistory(history: StatusPageHistoryDay[], start: Date, end: Date, status: StatusPageComponentStatus): void {
  const startDay = new Date(start);
  startDay.setUTCHours(0, 0, 0, 0);
  const endDay = new Date(end);
  endDay.setUTCHours(0, 0, 0, 0);
  for (const day of history) {
    const current = new Date(`${day.day}T00:00:00.000Z`);
    if (current < startDay || current > endDay) continue;
    if (status === 'outage' || (status === 'degraded' && day.status === 'operational')) {
      day.status = status;
      day.outageMinutes = 1;
    }
    if (status === 'maintenance' && day.status !== 'outage') {
      day.status = 'maintenance';
      day.maintenanceMinutes = 1;
    }
  }
}

export async function upsertStatusPageComponent(input: {
  id?: number | null;
  sectionId: number;
  publicName: string;
  description: string | null;
  position: number;
  enabled: boolean;
  showHistory: boolean;
  checkIds: number[];
}): Promise<StatusPageComponent> {
  const result = input.id
    ? await query<ComponentRow>(
      `WITH updated AS (
         UPDATE status_page_components
         SET section_id = $2, public_name = $3, description = $4, position = $5,
             enabled = $6, show_history = $7, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *
       )
       SELECT updated.id, updated.section_id, s.name AS section_name, updated.public_name, updated.description,
              updated.position, updated.enabled, updated.show_history, updated.created_at, updated.updated_at
       FROM updated
       JOIN status_page_sections s ON s.id = updated.section_id`,
      [input.id, input.sectionId, input.publicName, input.description, input.position, input.enabled, input.showHistory]
    )
    : await query<ComponentRow>(
      `WITH inserted AS (
         INSERT INTO status_page_components (section_id, public_name, description, position, enabled, show_history)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *
       )
       SELECT inserted.id, inserted.section_id, s.name AS section_name, inserted.public_name, inserted.description,
              inserted.position, inserted.enabled, inserted.show_history, inserted.created_at, inserted.updated_at
       FROM inserted
       JOIN status_page_sections s ON s.id = inserted.section_id`,
      [input.sectionId, input.publicName, input.description, input.position, input.enabled, input.showHistory]
    );
  const component = mapComponent(result.rows[0], (await getStatusPageSettings()).historyDays);
  await setComponentChecks(component.id, input.checkIds);
  await attachComponentChecks([component]);
  return component;
}

async function setComponentChecks(componentId: number, checkIds: number[]): Promise<void> {
  await query(`DELETE FROM status_page_component_checks WHERE component_id = $1`, [componentId]);
  const uniqueCheckIds = Array.from(new Set(checkIds));
  for (const checkId of uniqueCheckIds) {
    await query(
      `INSERT INTO status_page_component_checks (component_id, check_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [componentId, checkId]
    );
  }
}

export async function deleteStatusPageComponent(id: number): Promise<boolean> {
  const result = await query(`DELETE FROM status_page_components WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function listStatusPageReports(limit = 50): Promise<StatusPageReport[]> {
  const result = await query<ReportRow>(
    `SELECT ${REPORT_COLUMNS}
     FROM status_page_reports
     ORDER BY opened_at DESC, id DESC
     LIMIT $1`,
    [Math.max(1, Math.min(limit, 200))]
  );
  return attachReportDetails(result.rows.map(mapReport));
}

async function attachReportDetails(reports: StatusPageReport[]): Promise<StatusPageReport[]> {
  if (reports.length === 0) return reports;
  const reportIds = reports.map((report) => report.id);
  const componentResult = await query<ReportComponentRow>(
    `SELECT src.report_id, src.component_id, c.public_name, src.status
     FROM status_page_report_components src
     JOIN status_page_components c ON c.id = src.component_id
     WHERE src.report_id = ANY($1::bigint[])
     ORDER BY c.public_name ASC`,
    [reportIds]
  );
  const updateResult = await query<ReportUpdateRow>(
    `SELECT id, report_id, status, message, created_at
     FROM status_page_report_updates
     WHERE report_id = ANY($1::bigint[])
     ORDER BY created_at ASC, id ASC`,
    [reportIds]
  );
  const byReportId = new Map<number, StatusPageReport>();
  for (const report of reports) byReportId.set(report.id, report);
  for (const row of componentResult.rows) {
    byReportId.get(Number(row.report_id))?.components.push({
      id: row.component_id,
      publicName: row.public_name,
      status: row.status,
    });
  }
  for (const row of updateResult.rows) {
    byReportId.get(Number(row.report_id))?.updates.push(mapReportUpdate(row));
  }
  return reports;
}

export async function createStatusPageReport(input: {
  title: string;
  impact: StatusPageReportImpact;
  componentIds: number[];
  message: string;
}): Promise<StatusPageReport> {
  const result = await query<ReportRow>(
    `INSERT INTO status_page_reports (title, impact, source, status)
     VALUES ($1, $2, 'manual', 'open')
     RETURNING ${REPORT_COLUMNS}`,
    [input.title, input.impact]
  );
  const report = mapReport(result.rows[0]);
  const status = impactToComponentStatus(input.impact);
  await setReportComponents(report.id, input.componentIds.map((id) => ({ id, status })));
  await addStatusPageReportUpdate(report.id, 'investigating', input.message);
  const [withDetails] = await attachReportDetails([report]);
  return withDetails;
}

async function setReportComponents(reportId: number, components: Array<{ id: number; status: StatusPageComponentStatus }>): Promise<void> {
  await query(`DELETE FROM status_page_report_components WHERE report_id = $1`, [reportId]);
  const seen = new Set<number>();
  for (const component of components) {
    if (seen.has(component.id)) continue;
    seen.add(component.id);
    await query(
      `INSERT INTO status_page_report_components (report_id, component_id, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (report_id, component_id) DO UPDATE SET status = EXCLUDED.status`,
      [reportId, component.id, component.status]
    );
  }
}

export async function addStatusPageReportUpdate(reportId: number, status: StatusPageUpdateStatus, message: string): Promise<StatusPageReportUpdate> {
  const update = await query<ReportUpdateRow>(
    `INSERT INTO status_page_report_updates (report_id, status, message)
     VALUES ($1, $2, $3)
     RETURNING id, report_id, status, message, created_at`,
    [reportId, status, message]
  );
  if (status === 'resolved') {
    await query(
      `UPDATE status_page_reports
       SET status = 'resolved', resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [reportId]
    );
  } else {
    await query(`UPDATE status_page_reports SET status = 'open', resolved_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [reportId]);
  }
  await enqueueStatusReportEmails(reportId);
  return mapReportUpdate(update.rows[0]);
}

async function enqueueStatusReportEmails(reportId: number): Promise<void> {
  const details = await attachReportDetails((await query<ReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM status_page_reports WHERE id = $1`,
    [reportId]
  )).rows.map(mapReport));
  const report = details[0];
  if (!report) return;
  const componentIds = report.components.map((component) => component.id);
  const subscribers = await listConfirmedStatusSubscribersForComponents(componentIds);
  await Promise.all(subscribers.map((subscriber) => enqueueStatusReportSubscriberEmail({
    email: subscriber.email,
    report,
    unsubscribeUrl: `${config.publicBaseUrl}/status?unsubscribe=${encodeURIComponent(subscriber.unsubscribeToken)}`,
  })));
  const admins = (await listAdminEmailSubscriptions()).filter((admin) => !admin.disabled && admin.statusPageReports);
  await Promise.all(admins.map((admin) => enqueueStatusReportSubscriberEmail({
    email: admin.adminEmail,
    report,
  })));
}

export async function listStatusPageMaintenances(limit = 50): Promise<StatusPageMaintenance[]> {
  const result = await query<MaintenanceRow>(
    `SELECT ${MAINTENANCE_COLUMNS}
     FROM status_page_maintenances
     ORDER BY starts_at DESC, id DESC
     LIMIT $1`,
    [Math.max(1, Math.min(limit, 200))]
  );
  return attachMaintenanceComponents(result.rows.map(mapMaintenance));
}

async function attachMaintenanceComponents(maintenances: StatusPageMaintenance[]): Promise<StatusPageMaintenance[]> {
  if (maintenances.length === 0) return maintenances;
  const result = await query<MaintenanceComponentRow>(
    `SELECT smc.maintenance_id, smc.component_id, c.public_name
     FROM status_page_maintenance_components smc
     JOIN status_page_components c ON c.id = smc.component_id
     WHERE smc.maintenance_id = ANY($1::bigint[])
     ORDER BY c.public_name ASC`,
    [maintenances.map((maintenance) => maintenance.id)]
  );
  const byMaintenanceId = new Map(maintenances.map((maintenance) => [maintenance.id, maintenance]));
  for (const row of result.rows) {
    byMaintenanceId.get(Number(row.maintenance_id))?.components.push({ id: row.component_id, publicName: row.public_name });
  }
  return maintenances;
}

export async function upsertStatusPageMaintenance(input: {
  id?: number | null;
  title: string;
  message: string;
  status: StatusPageMaintenanceStatus;
  startsAt: Date;
  endsAt: Date;
  componentIds: number[];
}): Promise<StatusPageMaintenance> {
  const result = input.id
    ? await query<MaintenanceRow>(
      `UPDATE status_page_maintenances
       SET title = $2, message = $3, status = $4, starts_at = $5, ends_at = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING ${MAINTENANCE_COLUMNS}`,
      [input.id, input.title, input.message, input.status, input.startsAt, input.endsAt]
    )
    : await query<MaintenanceRow>(
      `INSERT INTO status_page_maintenances (title, message, status, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${MAINTENANCE_COLUMNS}`,
      [input.title, input.message, input.status, input.startsAt, input.endsAt]
    );
  const maintenance = mapMaintenance(result.rows[0]);
  await query(`DELETE FROM status_page_maintenance_components WHERE maintenance_id = $1`, [maintenance.id]);
  for (const componentId of Array.from(new Set(input.componentIds))) {
    await query(
      `INSERT INTO status_page_maintenance_components (maintenance_id, component_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [maintenance.id, componentId]
    );
  }
  const [withComponents] = await attachMaintenanceComponents([maintenance]);
  return withComponents;
}

export async function deleteStatusPageMaintenance(id: number): Promise<boolean> {
  const result = await query(`DELETE FROM status_page_maintenances WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Automatic incidents follow Monitoring issues on the checks linked to public
 * components. Issues that open while an automatic incident is open, or within
 * the grouping window after it resolved, join that incident, so one outage
 * across several services is one incident. Its timeline says when each
 * service went down and recovered, as Monitoring saw it.
 */
export async function syncAutomaticStatusPageReports(): Promise<void> {
  const run = syncChain.then(syncAutomaticStatusPageReportsOnce, syncAutomaticStatusPageReportsOnce);
  syncChain = run.catch(() => undefined);
  return run;
}

// Syncs in this process run one at a time, so two never create an incident for the same issue.
let syncChain: Promise<void> = Promise.resolve();

async function syncAutomaticStatusPageReportsOnce(): Promise<void> {
  // Only open issues and recently closed ones: older issues were synced as
  // resolved when they closed, and re-syncing the whole history on every issue
  // change grows with every incident ever recorded.
  const linked = await query<SyncIssueRow>(
    `SELECT i.id AS issue_id, i.status AS issue_status, i.opened_at, i.closed_at, ri.report_id
     FROM monitoring_issues i
     LEFT JOIN status_page_report_issues ri ON ri.monitoring_issue_id = i.id
     WHERE (i.status = 'open' OR i.closed_at > CURRENT_TIMESTAMP - INTERVAL '${AUTOMATIC_REPORT_SYNC_DAYS} days')
       AND NOT EXISTS (SELECT 1 FROM status_page_dismissed_issues d WHERE d.monitoring_issue_id = i.id)
       AND EXISTS (
         SELECT 1 FROM status_page_component_checks scc
         JOIN status_page_components c ON c.id = scc.component_id
         WHERE scc.check_id = i.check_id AND c.enabled = true
       )
     ORDER BY i.opened_at ASC, i.id ASC`
  );
  const touched = new Set<number>();
  for (const row of linked.rows) if (row.report_id !== null) touched.add(Number(row.report_id));

  const unattached = linked.rows.filter((row) => row.report_id === null);
  if (unattached.length > 0) {
    const { incidentGroupingMinutes } = await getStatusPageSettings();
    const candidates = await query<{ id: number; opened_at: Date; resolved_at: Date | null; status: StatusPageReportStatus }>(
      `SELECT id, opened_at, resolved_at, status
       FROM status_page_reports
       WHERE source = 'automatic'
         AND (status = 'open' OR resolved_at > CURRENT_TIMESTAMP - INTERVAL '${AUTOMATIC_REPORT_SYNC_DAYS + 1} days')`
    );
    const plan = planIncidentAssignments(
      unattached.map((row) => ({ issueId: Number(row.issue_id), openedAt: new Date(row.opened_at), closedAt: row.closed_at ? new Date(row.closed_at) : null })),
      candidates.rows.map((row) => ({ reportId: Number(row.id), openedAt: new Date(row.opened_at), endAt: row.status === 'open' || !row.resolved_at ? null : new Date(row.resolved_at) })),
      incidentGroupingMinutes,
    );
    const created = new Map<string, number>();
    for (const assignment of plan) {
      let reportId = assignment.reportId;
      if (reportId === null) {
        reportId = created.get(assignment.newKey!) ?? null;
        if (reportId === null) {
          const inserted = await query<{ id: number }>(
            `INSERT INTO status_page_reports (title, status, impact, source, opened_at)
             VALUES ('Incident', 'open', 'degraded', 'automatic', $1)
             RETURNING id`,
            [assignment.openedAt]
          );
          reportId = Number(inserted.rows[0].id);
          created.set(assignment.newKey!, reportId);
        }
      }
      const attached = await query(
        `INSERT INTO status_page_report_issues (report_id, monitoring_issue_id)
         VALUES ($1, $2)
         ON CONFLICT (monitoring_issue_id) DO NOTHING`,
        [reportId, assignment.issueId]
      );
      if ((attached.rowCount ?? 0) > 0) touched.add(reportId);
    }
    // A report created here whose issue another server attached first holds nothing.
    for (const reportId of created.values()) {
      if (!touched.has(reportId)) await query(`DELETE FROM status_page_reports WHERE id = $1`, [reportId]);
    }
  }

  const touchedIds = [...touched];
  if (touchedIds.length > 0) {
    const [issues, keys] = await Promise.all([
      query<ReportIssueRow>(
        `SELECT ri.report_id, i.id AS issue_id, i.status AS issue_status, i.severity, i.opened_at, i.closed_at,
                c.id AS component_id, c.public_name
         FROM status_page_report_issues ri
         JOIN monitoring_issues i ON i.id = ri.monitoring_issue_id
         JOIN status_page_component_checks scc ON scc.check_id = i.check_id
         JOIN status_page_components c ON c.id = scc.component_id AND c.enabled = true
         WHERE ri.report_id = ANY($1::bigint[])`,
        [touchedIds]
      ),
      query<{ report_id: number; key: string }>(
        `SELECT report_id, unnest(event_keys) AS key
         FROM status_page_report_updates
         WHERE report_id = ANY($1::bigint[])`,
        [touchedIds]
      ),
    ]);
    for (const reportId of touchedIds) {
      const rows = issues.rows.filter((row) => Number(row.report_id) === reportId);
      if (rows.length === 0) continue;
      const known = new Set(keys.rows.filter((row) => Number(row.report_id) === reportId).map((row) => row.key));
      await applyIncidentTimeline(reportId, incidentTimeline(rows.map((row) => ({
        issueId: Number(row.issue_id),
        open: row.issue_status === 'open',
        critical: row.severity === 'critical',
        openedAt: new Date(row.opened_at),
        closedAt: row.closed_at ? new Date(row.closed_at) : null,
        componentId: Number(row.component_id),
        publicName: row.public_name,
      }))), known);
    }
  }

  await resolveUnlinkedAutomaticReports(touchedIds);
}

async function applyIncidentTimeline(reportId: number, timeline: IncidentTimeline, knownKeys: Set<string>): Promise<void> {
  await query(
    `UPDATE status_page_reports
     SET title = $2, status = $3, impact = $4, opened_at = $5, resolved_at = $6, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [reportId, timeline.title, timeline.status, timeline.impact, timeline.openedAt, timeline.resolvedAt]
  );
  await setReportComponents(reportId, timeline.components.map((component) => ({ id: component.id, status: component.status })));
  const updates = timelineUpdates(timeline, knownKeys);
  for (const update of updates) {
    await query(
      `INSERT INTO status_page_report_updates (report_id, status, message, event_keys, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [reportId, update.status, update.message, update.eventKeys, update.createdAt]
    );
  }
  // Subscribers hear about what is happening, not about a late re-sync of old events.
  if (updates.some((update) => Date.now() - update.createdAt.getTime() < EMAIL_RECENT_MS)) {
    await enqueueStatusReportEmails(reportId);
  }
}

const AUTOMATIC_REPORT_SYNC_DAYS = 7;
const EMAIL_RECENT_MS = 60 * 60 * 1000;
/** Events of one kind this close together (one probe round) are one timeline update. */
const UPDATE_MERGE_MS = 30 * 1000;
const PUBLIC_SYNC_INTERVAL_MS = 15_000;
let publicSync: { at: number; running: Promise<void> | null } = { at: 0, running: null };

export interface IncidentIssue {
  issueId: number;
  openedAt: Date;
  closedAt: Date | null;
}

export interface IncidentCandidate {
  reportId: number;
  openedAt: Date;
  /** When the incident resolved, or null while it is open. */
  endAt: Date | null;
}

export interface IncidentAssignment {
  issueId: number;
  /** The existing incident the issue joins, or null for a new one. */
  reportId: number | null;
  /** Issues sharing a newKey go into one new incident. */
  newKey: string | null;
  openedAt: Date;
}

/**
 * Which incident each new issue joins, oldest issue first. An issue joins the
 * most recently opened incident that is open at the issue's start, or resolved
 * no more than groupingMinutes before it; otherwise it starts a new incident.
 * A groupingMinutes of 0 gives every issue its own incident.
 */
export function planIncidentAssignments(issues: IncidentIssue[], candidates: IncidentCandidate[], groupingMinutes: number): IncidentAssignment[] {
  const graceMs = groupingMinutes * 60_000;
  const spans = candidates.map((candidate) => ({ ...candidate, newKey: null as string | null }));
  const assignments: IncidentAssignment[] = [];
  const sorted = [...issues].sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime() || a.issueId - b.issueId);
  for (const issue of sorted) {
    const start = issue.openedAt.getTime();
    const match = groupingMinutes <= 0 ? undefined : spans
      .filter((span) => span.openedAt.getTime() - graceMs <= start && (span.endAt === null || start <= span.endAt.getTime() + graceMs))
      .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())[0];
    if (match) {
      if (start < match.openedAt.getTime()) match.openedAt = issue.openedAt;
      match.endAt = match.endAt === null || issue.closedAt === null ? null : new Date(Math.max(match.endAt.getTime(), issue.closedAt.getTime()));
      assignments.push({ issueId: issue.issueId, reportId: match.newKey ? null : match.reportId, newKey: match.newKey, openedAt: match.openedAt });
      continue;
    }
    const newKey = `new-${issue.issueId}`;
    spans.push({ reportId: 0, openedAt: issue.openedAt, endAt: issue.closedAt, newKey });
    assignments.push({ issueId: issue.issueId, reportId: null, newKey, openedAt: issue.openedAt });
  }
  return assignments;
}

export interface IncidentIssueComponent {
  issueId: number;
  open: boolean;
  critical: boolean;
  openedAt: Date;
  closedAt: Date | null;
  componentId: number;
  publicName: string;
}

export interface IncidentEvent {
  kind: 'down' | 'up';
  componentId: number;
  publicName: string;
  at: Date;
  key: string;
}

export interface IncidentTimeline {
  title: string;
  status: StatusPageReportStatus;
  impact: StatusPageReportImpact;
  openedAt: Date;
  resolvedAt: Date | null;
  components: Array<{ id: number; publicName: string; status: StatusPageComponentStatus }>;
  events: IncidentEvent[];
}

/**
 * The state and per-service events of an incident from its issues. A service
 * is down while any of its issues is open; overlapping issues are one outage.
 */
export function incidentTimeline(rows: IncidentIssueComponent[]): IncidentTimeline {
  const open = rows.some((row) => row.open);
  const impact: StatusPageReportImpact = rows.some((row) => row.critical) ? 'outage' : 'degraded';
  const openedAt = new Date(Math.min(...rows.map((row) => row.openedAt.getTime())));
  const resolvedAt = open ? null : new Date(Math.max(...rows.map((row) => (row.closedAt ?? row.openedAt).getTime())));
  const byComponent = new Map<number, IncidentIssueComponent[]>();
  for (const row of rows) byComponent.set(row.componentId, [...(byComponent.get(row.componentId) ?? []), row]);

  const events: IncidentEvent[] = [];
  const components: Array<{ id: number; publicName: string; status: StatusPageComponentStatus; firstDown: number }> = [];
  for (const [componentId, componentRows] of byComponent) {
    const publicName = componentRows[0].publicName;
    const spans = componentRows
      .map((row) => ({ start: row.openedAt.getTime(), end: row.open || row.closedAt === null ? Infinity : row.closedAt.getTime() }))
      .sort((a, b) => a.start - b.start);
    const merged: Array<{ start: number; end: number }> = [];
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
      else merged.push({ ...span });
    }
    for (const span of merged) {
      events.push({ kind: 'down', componentId, publicName, at: new Date(span.start), key: `down:${componentId}:${Math.floor(span.start / 1000)}` });
      if (span.end !== Infinity) events.push({ kind: 'up', componentId, publicName, at: new Date(span.end), key: `up:${componentId}:${Math.floor(span.end / 1000)}` });
    }
    components.push({
      id: componentId,
      publicName,
      status: componentRows.some((row) => row.critical) ? 'outage' : 'degraded',
      firstDown: merged[0].start,
    });
  }
  components.sort((a, b) => a.firstDown - b.firstDown || a.publicName.localeCompare(b.publicName));
  events.sort((a, b) => a.at.getTime() - b.at.getTime() || (a.kind === b.kind ? 0 : a.kind === 'down' ? -1 : 1) || a.publicName.localeCompare(b.publicName));
  return {
    title: incidentTitle(components.map((component) => component.publicName), impact),
    status: open ? 'open' : 'resolved',
    impact,
    openedAt,
    resolvedAt,
    components: components.map(({ id, publicName, status }) => ({ id, publicName, status })),
    events,
  };
}

const TITLE_MAX = 255;

export function incidentTitle(names: string[], impact: StatusPageReportImpact): string {
  const state = impact === 'outage' ? 'down' : 'degraded';
  let title: string;
  if (names.length === 1) title = `${names[0]} is ${state}`;
  else if (names.length === 2) title = `${names[0]} and ${names[1]} are ${state}`;
  else {
    const others = names.length - 2;
    title = `${names[0]}, ${names[1]}, and ${others} other service${others === 1 ? '' : 's'} are ${state}`;
  }
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
}

function listNames(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

export interface TimelineUpdate {
  status: StatusPageUpdateStatus;
  message: string;
  createdAt: Date;
  eventKeys: string[];
}

/**
 * The timeline updates for events not posted yet. Events of one kind within
 * UPDATE_MERGE_MS of each other share an update ("A and B went down."); the recovery
 * that resolves the incident is the resolved update.
 */
export function timelineUpdates(timeline: IncidentTimeline, knownKeys: Set<string>): TimelineUpdate[] {
  const fresh = timeline.events.filter((event) => !knownKeys.has(event.key));
  const groups: IncidentEvent[][] = [];
  for (const event of fresh) {
    const group = groups[groups.length - 1];
    if (group && group[0].kind === event.kind && event.at.getTime() - group[0].at.getTime() < UPDATE_MERGE_MS) group.push(event);
    else groups.push([event]);
  }
  const resolvedAt = timeline.resolvedAt?.getTime() ?? null;
  return groups.map((group): TimelineUpdate => {
    const names = [...new Set(group.map((event) => event.publicName))];
    const last = group[group.length - 1].at.getTime();
    const kind = group[0].kind;
    const resolves = kind === 'up' && resolvedAt !== null && last === resolvedAt;
    return {
      status: kind === 'down' ? 'investigating' : resolves ? 'resolved' : 'monitoring',
      message: `${listNames(names)} ${kind === 'down' ? 'went down' : 'recovered'}.`,
      createdAt: resolves ? new Date(last) : group[0].at,
      eventKeys: group.map((event) => event.key),
    };
  });
}

/**
 * The public page is anonymous and busiest during incidents, so its views share
 * one sync at most every PUBLIC_SYNC_INTERVAL_MS. Issue changes still sync
 * immediately through syncAutomaticStatusPageReports.
 */
export async function syncAutomaticStatusPageReportsForPublicView(): Promise<void> {
  if (publicSync.running) return publicSync.running;
  if (Date.now() - publicSync.at < PUBLIC_SYNC_INTERVAL_MS) return;
  publicSync.running = syncAutomaticStatusPageReports()
    .finally(() => { publicSync = { at: Date.now(), running: null }; });
  return publicSync.running;
}

export function resetPublicStatusPageSyncForTests(): void {
  publicSync = { at: 0, running: null };
  syncChain = Promise.resolve();
}

/** Open automatic incidents whose issues are gone or no longer public resolve. */
async function resolveUnlinkedAutomaticReports(touchedReportIds: number[]): Promise<void> {
  const result = await query<{ id: number; resolved_at: Date }>(
    `UPDATE status_page_reports
     SET status = 'resolved', resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
     WHERE source = 'automatic'
       AND status = 'open'
       AND id <> ALL($1::bigint[])
     RETURNING id, resolved_at`,
    [touchedReportIds]
  );
  for (const row of result.rows) {
    await query(
      `INSERT INTO status_page_report_updates (report_id, status, message, event_keys, created_at)
       VALUES ($1, 'resolved', 'Recovered.', ARRAY['unlinked'], $2)`,
      [row.id, row.resolved_at]
    );
    await enqueueStatusReportEmails(Number(row.id));
  }
}

export async function getStatusPageAdminSummary(): Promise<StatusPageAdminSummary> {
  await syncAutomaticStatusPageReports();
  const settings = await getStatusPageSettings();
  const [sections, components, reports, maintenances] = await Promise.all([
    listStatusPageSections(),
    listStatusPageComponents(settings.historyDays),
    listStatusPageReports(100),
    listStatusPageMaintenances(100),
  ]);
  applyMaintenancesToComponents(components, maintenances);
  return { settings, sections, components, reports, maintenances };
}

function toPublicSettings(settings: StatusPageSettings): PublicStatusPage['settings'] {
  return {
    companyName: settings.companyName,
    companyUrl: safePublicHttpUrl(settings.companyUrl),
    logoUrl: safePublicHttpUrl(settings.logoUrl),
    historyDays: settings.historyDays,
    timezone: settings.timezone,
    theme: settings.theme,
    announcement: settings.announcement,
    subscribable: settings.subscribable,
    incidentHistoryEnabled: settings.incidentHistoryEnabled,
    maintenancePageEnabled: settings.maintenancePageEnabled,
    feedsEnabled: settings.feedsEnabled,
  };
}

/** The public page, or null while it isn't published. */
export async function getPublicStatusPage(): Promise<PublicStatusPage | null> {
  const settings = await getStatusPageSettings();
  if (!settings.published) return null;
  await syncAutomaticStatusPageReportsForPublicView();
  const [sections, components, reports, maintenances] = await Promise.all([
    listStatusPageSections(),
    listStatusPageComponents(settings.historyDays),
    listStatusPageReports(100),
    listStatusPageMaintenances(100),
  ]);
  const publicComponents = components.filter((component) => component.enabled);
  const activeMaintenances = maintenances.filter((maintenance) => maintenance.status !== 'cancelled' && maintenance.endsAt >= new Date());
  applyMaintenancesToComponents(publicComponents, activeMaintenances);
  const componentsBySection = sections
    .filter((section) => section.enabled)
    .map((section) => ({
      ...section,
      components: publicComponents.filter((component) => component.sectionId === section.id),
    }))
    .filter((section) => section.components.length > 0);
  const recentSince = Date.now() - settings.homeIncidentDays * 86_400_000;
  return {
    settings: toPublicSettings(settings),
    aggregateStatus: aggregatePageStatus(publicComponents),
    sections: componentsBySection.map((section) => ({
      id: section.id,
      name: section.name,
      components: section.components.map(toPublicComponent),
    })),
    activeReports: reports.filter((report) => report.status === 'open').map(toPublicReport),
    recentReports: settings.homeIncidentDays === 0 ? [] : reports
      .filter((report) => report.status === 'resolved' && report.resolvedAt !== null && new Date(report.resolvedAt).getTime() >= recentSince)
      .slice(0, 20)
      .map(toPublicReport),
    maintenances: activeMaintenances.map(toPublicMaintenance),
    generatedAt: new Date(),
  };
}

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
/** Months shown per page of the incident archive and the maintenance schedule. */
const MONTHS_PER_PAGE = 3;

interface YearMonth { year: number; month: number }

function parseMonth(value: string): YearMonth | null {
  const match = MONTH_PATTERN.exec(value);
  return match ? { year: Number(match[1]), month: Number(match[2]) } : null;
}

function shiftMonth(value: YearMonth, delta: number): YearMonth {
  const index = value.year * 12 + (value.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function monthKey(value: YearMonth): string {
  return `${value.year}-${String(value.month).padStart(2, '0')}`;
}

function monthIndex(value: YearMonth): number {
  return value.year * 12 + value.month;
}

/** The page's timezone when Postgres knows it, else UTC, so month boundaries never fail. */
async function pageTimeZone(timezone: string): Promise<string> {
  const result = await query<{ known: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1) AS known`,
    [timezone]
  );
  return result.rows[0]?.known ? timezone : 'UTC';
}

async function currentMonth(timeZone: string): Promise<YearMonth> {
  const result = await query<{ month: string }>(`SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE $1, 'YYYY-MM') AS month`, [timeZone]);
  return parseMonth(result.rows[0].month)!;
}

/**
 * Past incidents in whole months, newest first: the MONTHS_PER_PAGE months
 * ending with `month` (default the current one). Null while the page or its
 * incident history is off.
 */
export async function getPublicIncidentArchive(month?: string): Promise<PublicIncidentArchive | null> {
  const settings = await getStatusPageSettings();
  if (!settings.published || !settings.incidentHistoryEnabled) return null;
  await syncAutomaticStatusPageReportsForPublicView();
  const timeZone = await pageTimeZone(settings.timezone);
  const now = await currentMonth(timeZone);
  const requested = month ? parseMonth(month) : null;
  const to = requested && monthIndex(requested) < monthIndex(now) ? requested : now;
  const from = shiftMonth(to, -(MONTHS_PER_PAGE - 1));
  const after = shiftMonth(to, 1);
  const [rows, older] = await Promise.all([
    query<ReportRow & { month: string }>(
      `SELECT ${REPORT_COLUMNS}, to_char(opened_at AT TIME ZONE $1, 'YYYY-MM') AS month
       FROM status_page_reports
       WHERE opened_at >= ($2::date)::timestamp AT TIME ZONE $1
         AND opened_at < ($3::date)::timestamp AT TIME ZONE $1
       ORDER BY opened_at DESC, id DESC
       LIMIT 500`,
      [timeZone, `${monthKey(from)}-01`, `${monthKey(after)}-01`]
    ),
    query<{ older: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM status_page_reports WHERE opened_at < ($2::date)::timestamp AT TIME ZONE $1) AS older`,
      [timeZone, `${monthKey(from)}-01`]
    ),
  ]);
  const reports = await attachReportDetails(rows.rows.map(mapReport));
  const monthOf = new Map(rows.rows.map((row) => [Number(row.id), row.month]));
  const months = Array.from({ length: MONTHS_PER_PAGE }, (_, index) => monthKey(shiftMonth(to, -index)));
  return {
    from: monthKey(from),
    to: monthKey(to),
    months: months.map((key) => ({
      month: key,
      reports: reports.filter((report) => monthOf.get(report.id) === key).map(toPublicReport),
    })),
    hasOlder: older.rows[0]?.older === true,
    hasNewer: monthIndex(to) < monthIndex(now),
  };
}

/** One incident with its timeline, or null while it, the page or incident history is off. */
export async function getPublicIncident(id: number): Promise<PublicStatusPageReport | null> {
  const settings = await getStatusPageSettings();
  if (!settings.published || !settings.incidentHistoryEnabled) return null;
  await syncAutomaticStatusPageReportsForPublicView();
  const result = await query<ReportRow>(`SELECT ${REPORT_COLUMNS} FROM status_page_reports WHERE id = $1`, [id]);
  if (!result.rows[0]) return null;
  const [report] = await attachReportDetails([mapReport(result.rows[0])]);
  return toPublicReport(report);
}

/**
 * Maintenance in whole months, oldest first: the MONTHS_PER_PAGE months
 * starting with `month` (default the current one). Cancelled windows are left
 * out. Null while the page or its maintenance page is off.
 */
export async function getPublicMaintenanceSchedule(month?: string): Promise<PublicMaintenanceSchedule | null> {
  const settings = await getStatusPageSettings();
  if (!settings.published || !settings.maintenancePageEnabled) return null;
  const timeZone = await pageTimeZone(settings.timezone);
  const from = (month ? parseMonth(month) : null) ?? await currentMonth(timeZone);
  const to = shiftMonth(from, MONTHS_PER_PAGE - 1);
  const after = shiftMonth(to, 1);
  const [rows, edges] = await Promise.all([
    query<MaintenanceRow & { month: string }>(
      `SELECT ${MAINTENANCE_COLUMNS}, to_char(starts_at AT TIME ZONE $1, 'YYYY-MM') AS month
       FROM status_page_maintenances
       WHERE status <> 'cancelled'
         AND starts_at >= ($2::date)::timestamp AT TIME ZONE $1
         AND starts_at < ($3::date)::timestamp AT TIME ZONE $1
       ORDER BY starts_at ASC, id ASC
       LIMIT 500`,
      [timeZone, `${monthKey(from)}-01`, `${monthKey(after)}-01`]
    ),
    query<{ older: boolean; newer: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM status_page_maintenances WHERE status <> 'cancelled' AND starts_at < ($2::date)::timestamp AT TIME ZONE $1) AS older,
              EXISTS (SELECT 1 FROM status_page_maintenances WHERE status <> 'cancelled' AND starts_at >= ($3::date)::timestamp AT TIME ZONE $1) AS newer`,
      [timeZone, `${monthKey(from)}-01`, `${monthKey(after)}-01`]
    ),
  ]);
  const maintenances = await attachMaintenanceComponents(rows.rows.map(mapMaintenance));
  const monthOf = new Map(rows.rows.map((row) => [Number(row.id), row.month]));
  const months = Array.from({ length: MONTHS_PER_PAGE }, (_, index) => monthKey(shiftMonth(from, index)));
  return {
    from: monthKey(from),
    to: monthKey(to),
    months: months.map((key) => ({
      month: key,
      maintenances: maintenances.filter((maintenance) => monthOf.get(maintenance.id) === key).map(toPublicMaintenance),
    })),
    hasOlder: edges.rows[0]?.older === true,
    hasNewer: edges.rows[0]?.newer === true,
  };
}

/** The newest incidents for the RSS and JSON feeds, or null while the page or its feeds are off. */
export async function getStatusPageFeed(limit = 50): Promise<{ settings: PublicStatusPage['settings']; reports: PublicStatusPageReport[] } | null> {
  const settings = await getStatusPageSettings();
  if (!settings.published || !settings.feedsEnabled) return null;
  await syncAutomaticStatusPageReportsForPublicView();
  return { settings: toPublicSettings(settings), reports: (await listStatusPageReports(limit)).map(toPublicReport) };
}

/**
 * Deletes an incident and its updates. The Monitoring issues behind an
 * automatic incident are dismissed, so the sync does not recreate it; later
 * failures still open new incidents.
 */
export async function deleteStatusPageReport(id: number): Promise<boolean> {
  await query(
    `INSERT INTO status_page_dismissed_issues (monitoring_issue_id)
     SELECT monitoring_issue_id FROM status_page_report_issues WHERE report_id = $1
     ON CONFLICT DO NOTHING`,
    [id]
  );
  const result = await query(`DELETE FROM status_page_reports WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Past incidents from elsewhere, for example a previous status page. Components
 * are matched by public name, ignoring case. An incident already imported with
 * the same title and start is skipped, so an import can be re-run. Imports
 * never notify subscribers.
 */
export async function importStatusPageReports(items: StatusPageReportImport[]): Promise<StatusPageReportImportResult> {
  const components = await query<{ id: number; public_name: string }>(`SELECT id, public_name FROM status_page_components`);
  const byName = new Map(components.rows.map((row) => [row.public_name.toLowerCase(), Number(row.id)]));
  const unknownComponents = new Set<string>();
  let imported = 0;
  let skipped = 0;
  for (const item of items) {
    const existing = await query(
      `SELECT 1 FROM status_page_reports WHERE source = 'imported' AND title = $1 AND opened_at = $2 LIMIT 1`,
      [item.title, item.openedAt]
    );
    if (existing.rows[0]) {
      skipped += 1;
      continue;
    }
    const inserted = await query<{ id: number }>(
      `INSERT INTO status_page_reports (title, status, impact, source, opened_at, resolved_at)
       VALUES ($1, $2, $3, 'imported', $4, $5)
       RETURNING id`,
      [item.title, item.resolvedAt ? 'resolved' : 'open', item.impact, item.openedAt, item.resolvedAt]
    );
    const reportId = Number(inserted.rows[0].id);
    const status = impactToComponentStatus(item.impact);
    const componentIds: number[] = [];
    for (const name of item.components) {
      const id = byName.get(name.toLowerCase());
      if (id === undefined) unknownComponents.add(name);
      else componentIds.push(id);
    }
    await setReportComponents(reportId, componentIds.map((id) => ({ id, status })));
    for (const update of [...item.updates].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
      await query(
        `INSERT INTO status_page_report_updates (report_id, status, message, created_at)
         VALUES ($1, $2, $3, $4)`,
        [reportId, update.status, update.message, update.createdAt]
      );
    }
    imported += 1;
  }
  return { imported, skipped, unknownComponents: [...unknownComponents].sort() };
}

// A check's error text and name are for operators; the public sees the status.
const PUBLIC_STATUS_REASON: Record<StatusPageComponentStatus, string | null> = {
  operational: null,
  degraded: 'Degraded performance',
  outage: 'Unavailable',
  maintenance: 'Under maintenance',
  unknown: null,
};

function toPublicComponent(component: StatusPageComponent): PublicStatusPageComponent {
  return {
    id: component.id,
    publicName: component.publicName,
    description: component.description,
    showHistory: component.showHistory,
    status: component.status,
    // A maintenance title is written for the public; other reasons come from checks.
    statusReason: component.status === 'maintenance' ? component.statusReason : PUBLIC_STATUS_REASON[component.status],
    history: component.showHistory ? component.history : [],
    uptimePercent: component.showHistory ? component.uptimePercent : null,
  };
}

function toPublicReport(report: StatusPageReport): PublicStatusPageReport {
  return {
    id: report.id,
    title: report.title,
    status: report.status,
    impact: report.impact,
    openedAt: report.openedAt,
    resolvedAt: report.resolvedAt,
    components: report.components,
    updates: report.updates.map(({ id, status, message, createdAt }) => ({ id, status, message, createdAt })),
  };
}

function toPublicMaintenance(maintenance: StatusPageMaintenance): PublicStatusPageMaintenance {
  const { id, title, message, status, startsAt, endsAt, components: affected } = maintenance;
  return { id, title, message, status, startsAt, endsAt, components: affected };
}

function applyMaintenancesToComponents(components: StatusPageComponent[], maintenances: StatusPageMaintenance[]): void {
  const now = new Date();
  for (const component of components) {
    const maintenance = maintenances.find((entry) => currentMaintenanceApplies(entry, component.id, now));
    if (maintenance) {
      component.status = 'maintenance';
      component.statusReason = maintenance.title;
    }
  }
}

export async function getStatusPageRawConfig(): Promise<JsonRecord> {
  const summary = await getStatusPageAdminSummary();
  return summary as unknown as JsonRecord;
}
