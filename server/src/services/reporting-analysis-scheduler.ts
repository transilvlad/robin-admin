import { logger } from '../logger.js';
import { getConfig } from '../db/queries/config.js';

type AnalysisKind = 'dmarc' | 'tlsrpt' | 'forensic';

const DEBOUNCE_MS = Math.max(1000, Number.parseInt(process.env.REPORTING_ANALYSIS_DEBOUNCE_MS || '10000', 10));
const timers = new Map<string, NodeJS.Timeout>();
const inFlight = new Set<string>();
const pending = new Set<string>();
// Analyses waiting for a free slot, in arrival order. A burst of reports for
// many domains queues here instead of taking every database connection.
const queued = new Map<string, { kind: AnalysisKind; domain?: string | null }>();
let running = 0;

function analysisKey(kind: AnalysisKind, domain?: string | null): string {
  return `${kind}:${domain?.trim().toLowerCase() || '*'}`;
}

// Each analysis module loads once on first use and is shared by every run
// after it; a failed load is retried by the next run.
const modules = new Map<AnalysisKind, Promise<unknown>>();

function loadModule<T>(kind: AnalysisKind, load: () => Promise<T>): Promise<T> {
  let module = modules.get(kind) as Promise<T> | undefined;
  if (!module) {
    module = load().catch((error) => {
      modules.delete(kind);
      throw error;
    });
    modules.set(kind, module);
  }
  return module;
}

async function runAnalysis(kind: AnalysisKind, domain?: string | null): Promise<void> {
  if (kind === 'dmarc') {
    const { analyzeDmarcIntelligence } = await loadModule('dmarc', () => import('./dmarc-intelligence.js'));
    const result = await analyzeDmarcIntelligence({ domain: domain ?? undefined, daysBack: 30 });
    logger.info('DMARC intelligence updated', { domain: domain ?? '(all)', senders: result.senders, issues: result.issues });
    return;
  }

  if (kind === 'tlsrpt') {
    const { analyzeTlsrptIntelligence } = await loadModule('tlsrpt', () => import('./tlsrpt-intelligence.js'));
    const result = await analyzeTlsrptIntelligence({ domain: domain ?? undefined, daysBack: 30 });
    logger.info('TLSRPT intelligence updated', { domain: domain ?? '(all)', processed: result.processed, issues: result.issues });
    return;
  }

  const { analyzeForensicIntelligence } = await loadModule('forensic', () => import('./forensic-intelligence.js'));
  const result = await analyzeForensicIntelligence({ domain: domain ?? undefined, daysBack: 30 });
  logger.info('Forensic intelligence updated', { domain: domain ?? '(all)', processed: result.processed, issues: result.issues });
}

async function drainQueue(): Promise<void> {
  const config = await getConfig();
  const limit = Math.max(1, config.reportingAnalysisConcurrency);
  while (running < limit && queued.size > 0) {
    const [key, job] = queued.entries().next().value as [string, { kind: AnalysisKind; domain?: string | null }];
    queued.delete(key);
    if (inFlight.has(key)) {
      pending.add(key);
      continue;
    }
    running += 1;
    inFlight.add(key);
    void runAnalysis(job.kind, job.domain)
      .catch((error) => {
        logger.error('Reporting intelligence analysis failed', {
          kind: job.kind,
          domain: job.domain ?? '(all)',
          error: (error as Error).message,
        });
      })
      .finally(() => {
        running -= 1;
        inFlight.delete(key);
        if (pending.delete(key)) {
          void scheduleByKey(job.kind, job.domain);
        }
        void drainQueue().catch(logDrainFailure);
      });
  }
}

function logDrainFailure(error: unknown): void {
  logger.error('Failed to start reporting analysis', { error: (error as Error).message });
}

async function scheduleByKey(kind: AnalysisKind, domain?: string | null): Promise<void> {
  const key = analysisKey(kind, domain);
  const existing = timers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  const config = await getConfig();

  const timer = setTimeout(() => {
    timers.delete(key);

    if (inFlight.has(key)) {
      pending.add(key);
      return;
    }

    queued.set(key, { kind, domain });
    void drainQueue().catch(logDrainFailure);
  }, Math.max(1000, config.reportingAnalysisDebounceMs || DEBOUNCE_MS));
  timer.unref?.();
  timers.set(key, timer);
}

export function scheduleReportingAnalysis(kind: AnalysisKind, domain?: string | null): void {
  void scheduleByKey(kind, domain).catch((error) => {
    logger.error('Failed to schedule reporting analysis', {
      kind,
      domain: domain ?? '(all)',
      error: (error as Error).message,
    });
  });
}

/** Analyses running and waiting, for tests and diagnostics. */
export function reportingAnalysisLoad(): { running: number; queued: number } {
  return { running, queued: queued.size };
}
