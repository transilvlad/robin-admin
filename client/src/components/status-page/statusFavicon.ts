import type { StatusPageComponentStatus } from '../../types/status-page';

/** One shade darker than the status page's own dots, so the white symbol reads at tab size. */
const COLORS: Record<StatusPageComponentStatus, string> = {
  operational: '#16a34a',
  degraded: '#d97706',
  outage: '#dc2626',
  maintenance: '#2563eb',
  unknown: '#6b7280',
};

const W = 'stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" fill="none"';

const SYMBOLS: Record<StatusPageComponentStatus, string> = {
  operational: `<path d="M10 16.5l4 4 8-9" ${W}/>`,
  degraded: `<path d="M16 9v8" ${W}/><circle cx="16" cy="22.5" r="2.1" fill="#fff"/>`,
  outage: `<path d="M11 11l10 10M21 11l-10 10" ${W}/>`,
  maintenance: '<path d="M19.5 9.5a4 4 0 0 0-4.8 5.3l-5.2 5.2a1.6 1.6 0 0 0 2.3 2.3l5.2-5.2a4 4 0 0 0 5.3-4.8l-2.4 2.4-2.3-.6-.6-2.3z" fill="#fff"/>',
  unknown: `<path d="M12.8 12.5a3.3 3.3 0 1 1 4.6 3c-1 .5-1.4 1.1-1.4 2.2" ${W}/><circle cx="16" cy="22.5" r="2.1" fill="#fff"/>`,
};

/** The status page's tab icon for a status: a coloured circle with a white symbol, as a data URL. */
export function statusFaviconUrl(status: StatusPageComponentStatus): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="${COLORS[status]}"/>${SYMBOLS[status]}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
