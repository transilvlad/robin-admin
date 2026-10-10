import crypto from 'node:crypto';
import { GRID_COLUMNS, type DashboardContent, type DashboardTemplate, type TemplatePanel } from '../types.js';
import { dockerDashboard } from './docker.js';
import { hostDashboard } from './host.js';

/** Optional exporter-specific examples. Never installed automatically. */
export const TEMPLATES: readonly DashboardTemplate[] = [
  hostDashboard,
  dockerDashboard,
];

export function getTemplate(key: string): DashboardTemplate | undefined {
  return TEMPLATES.find((template) => template.key === key);
}

/** Grid rows a panel type gets by default. */
export function defaultPanelHeight(type: TemplatePanel['type']): number {
  return type === 'stat' ? 4 : 8;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'row';
}

/**
 * Turn a template into dashboard content: panels flow left to right by width
 * (quarters of the row) and wrap onto the next line.
 */
export function templateContent(template: DashboardTemplate): DashboardContent {
  const rowIds = new Set<string>();
  return {
    title: template.title,
    description: template.description,
    ...(template.defaults ? { defaults: { ...template.defaults } } : {}),
    variables: template.variables.map((variable) => ({ ...variable })),
    rows: template.rows.map((row) => {
      let id = slug(row.title);
      for (let n = 2; rowIds.has(id); n++) id = `${slug(row.title)}-${n}`;
      rowIds.add(id);
      let x = 0;
      let y = 0;
      let lineHeight = 0;
      return {
        id,
        title: row.title,
        ...(row.collapsed ? { collapsed: true } : {}),
        ...(row.repeat ? { repeat: row.repeat } : {}),
        panels: row.panels.map(({ width, ...panel }) => {
          const w = (width ?? 2) * (GRID_COLUMNS / 4);
          const h = defaultPanelHeight(panel.type);
          if (x + w > GRID_COLUMNS) {
            x = 0;
            y += lineHeight;
            lineHeight = 0;
          }
          const layout = { x, y, w, h };
          x += w;
          lineHeight = Math.max(lineHeight, h);
          return { ...panel, queries: panel.queries.map((query) => ({ ...query })), layout };
        }),
      };
    }),
  };
}

/** Fingerprint of a template's content; changes whenever the template does. */
export function templateHash(template: DashboardTemplate): string {
  return crypto.createHash('sha256').update(JSON.stringify(templateContent(template))).digest('hex').slice(0, 16);
}
