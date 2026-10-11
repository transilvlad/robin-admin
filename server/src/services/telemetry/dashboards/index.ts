import type { DashboardContent, DashboardPanel } from './types.js';

export type * from './types.js';
export { getTemplate, templateContent, templateHash, TEMPLATES } from './templates/index.js';
export { compactPanels, parseDashboardContent, TelemetryValidationError, DASHBOARD_LIMITS } from './validate.js';

export function getPanel(dashboard: Pick<DashboardContent, 'rows'>, panelId: string): DashboardPanel | undefined {
  for (const row of dashboard.rows) {
    const panel = row.panels.find((candidate) => candidate.id === panelId);
    if (panel) return panel;
  }
  return undefined;
}
