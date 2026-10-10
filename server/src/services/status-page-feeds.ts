/**
 * RSS 2.0 and JSON Feed 1.1 renderings of the public status page's incidents.
 * Each incident is one item; its newest update is the item's text and date, so
 * readers see an item change as the incident moves on.
 */
import type { PublicStatusPage, PublicStatusPageReport } from '../types/status-page.js';

export interface StatusFeedLinks {
  /** The public status page. */
  home: string;
  /** This feed's own URL. */
  self: string;
  /** An incident's page, or null when incident pages are off. */
  incident: (id: number) => string | null;
}

const IMPACT_LABEL: Record<PublicStatusPageReport['impact'], string> = {
  outage: 'Outage',
  degraded: 'Degraded performance',
  maintenance: 'Maintenance',
};

function latestUpdate(report: PublicStatusPageReport) {
  return report.updates.reduce<PublicStatusPageReport['updates'][number] | null>(
    (latest, update) => (!latest || new Date(update.createdAt).getTime() >= new Date(latest.createdAt).getTime() ? update : latest),
    null,
  );
}

function itemDate(report: PublicStatusPageReport): Date {
  const update = latestUpdate(report);
  return new Date(update ? update.createdAt : report.resolvedAt ?? report.openedAt);
}

function itemSummary(report: PublicStatusPageReport): string {
  const state = report.status === 'resolved' ? 'Resolved' : IMPACT_LABEL[report.impact];
  const update = latestUpdate(report);
  const affected = report.components.map((component) => component.publicName).join(', ');
  return [`${state}.`, update?.message, affected ? `Affected: ${affected}.` : null].filter(Boolean).join(' ');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderStatusRss(settings: PublicStatusPage['settings'], reports: PublicStatusPageReport[], links: StatusFeedLinks): string {
  const items = reports.map((report) => {
    const link = links.incident(report.id) ?? links.home;
    return [
      '    <item>',
      `      <title>${escapeXml(report.title)}</title>`,
      `      <link>${escapeXml(link)}</link>`,
      `      <guid isPermaLink="false">incident-${report.id}</guid>`,
      `      <pubDate>${itemDate(report).toUTCString()}</pubDate>`,
      `      <description>${escapeXml(itemSummary(report))}</description>`,
      '    </item>',
    ].join('\n');
  });
  const updated = reports.length ? new Date(Math.max(...reports.map((report) => itemDate(report).getTime()))) : new Date();
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${escapeXml(`${settings.companyName} status`)}</title>`,
    `    <link>${escapeXml(links.home)}</link>`,
    `    <atom:link href="${escapeXml(links.self)}" rel="self" type="application/rss+xml" />`,
    `    <description>${escapeXml(`Incidents on the ${settings.companyName} status page`)}</description>`,
    `    <lastBuildDate>${updated.toUTCString()}</lastBuildDate>`,
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

export function renderStatusJsonFeed(settings: PublicStatusPage['settings'], reports: PublicStatusPageReport[], links: StatusFeedLinks): Record<string, unknown> {
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: `${settings.companyName} status`,
    home_page_url: links.home,
    feed_url: links.self,
    description: `Incidents on the ${settings.companyName} status page`,
    items: reports.map((report) => ({
      id: `incident-${report.id}`,
      url: links.incident(report.id) ?? links.home,
      title: report.title,
      content_text: itemSummary(report),
      date_published: new Date(report.openedAt).toISOString(),
      date_modified: itemDate(report).toISOString(),
      tags: [report.status, report.impact],
      _status_page: {
        status: report.status,
        impact: report.impact,
        opened_at: new Date(report.openedAt).toISOString(),
        resolved_at: report.resolvedAt ? new Date(report.resolvedAt).toISOString() : null,
        components: report.components.map((component) => component.publicName),
        updates: report.updates.map((update) => ({
          status: update.status,
          message: update.message,
          created_at: new Date(update.createdAt).toISOString(),
        })),
      },
    })),
  };
}
