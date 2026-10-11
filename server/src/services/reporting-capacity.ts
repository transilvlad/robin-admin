import { onReportingSettingsChanged, reportingPolicy } from './reporting-settings.js';

export class ReportingCapacityError extends Error {
  constructor(message = 'Reporting is busy; retry later') {
    super(message);
    this.name = 'ReportingCapacityError';
  }
}

let active = 0;
interface WaitingRead {
  start: () => void;
  timer: ReturnType<typeof setTimeout>;
}
const waiting: WaitingRead[] = [];

function drain(): void {
  while (active < reportingPolicy().reportingSourceConcurrency && waiting.length > 0) {
    const next = waiting.shift()!;
    clearTimeout(next.timer);
    next.start();
  }
}
onReportingSettingsChanged(drain);

/** Hold capacity through SQL, identities, folding and pagination, not just SQL. */
export function runSourceRead<T>(read: () => Promise<T>): Promise<T> {
  drain();
  const policy = reportingPolicy();
  if (active >= policy.reportingSourceConcurrency && waiting.length >= policy.reportingSourceQueueSize) {
    return Promise.reject(new ReportingCapacityError());
  }
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      active += 1;
      void Promise.resolve().then(read).then(resolve, reject).finally(() => {
        active -= 1;
        drain();
      });
    };
    if (active < policy.reportingSourceConcurrency) { start(); return; }
    const item: WaitingRead = {
      start,
      timer: setTimeout(() => {
        const index = waiting.indexOf(item);
        if (index >= 0) waiting.splice(index, 1);
        reject(new ReportingCapacityError('Reporting read waited too long; retry later'));
      }, policy.reportingSourceQueueWaitMs),
    };
    waiting.push(item);
  });
}
