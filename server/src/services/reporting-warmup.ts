/**
 * Pre-compute the default reporting view at startup.
 *
 * High-cardinality source aggregates scan the rollups and can take several
 * seconds on a cold cache. Without this, whoever opens Reports first after a
 * deploy pays that cost for everyone else — which is exactly the "the reporting
 * pages are slow" experience this exists to remove.
 *
 * Deliberately fire-and-forget and deliberately failure-tolerant: warming is an
 * optimisation, and a database hiccup here must never stop the server booting or
 * surface to a user. Anything that fails simply gets computed on demand later.
 */

import { logger } from '../logger.js';
import {
  getDomainAggregates,
  getReporterAggregates,
  getTotals,
  getTrend,
  resolveTimeframe,
} from './reporting-aggregate.js';
import { getSourceAggregates } from './reporting-sources.js';

export async function warmReportingCache(): Promise<void> {
  const started = Date.now();
  try {
    // The timeframe every screen defaults to: anchored to the newest report,
    // which is what an operator opening Reports will actually be looking at.
    const timeframe = await resolveTimeframe({});
    if (timeframe.empty) {
      logger.info('Reporting cache warm skipped: no report data');
      return;
    }

    await Promise.all([
      getTotals(timeframe, {}),
      getTrend(timeframe, {}),
      getReporterAggregates(timeframe, {}, { limit: 8 }),
      getSourceAggregates(timeframe, {}, { bucket: 'all', sort: 'actionable', direction: 'desc', limit: 8 }),
      getDomainAggregates(timeframe, {}, { sort: 'actionable', direction: 'desc', limit: 8 }),
    ]);

    logger.info(`Reporting cache warmed in ${Date.now() - started}ms`);
  } catch (error) {
    logger.warn('Reporting cache warm failed; aggregates will be computed on demand', {
      error: (error as Error).message,
    });
  }
}
