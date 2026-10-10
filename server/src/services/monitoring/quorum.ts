import type { MonitoringStatus } from '../../types/monitoring.js';

export interface LocationVerdict {
  locationId: number;
  locationName: string;
  status: Exclude<MonitoringStatus, 'unknown'>;
  errorCode: string | null;
  observedAt: Date;
}

export interface CombinedVerdict {
  status: MonitoringStatus;
  quorum: number;
  assignedCount: number;
  freshCount: number;
  locations: LocationVerdict[];
  failingLocations: LocationVerdict[];
}

export function combineLocationVerdicts(
  assignedCount: number,
  freshLocations: LocationVerdict[],
  configuredQuorum: number,
): CombinedVerdict {
  const quorum = configuredQuorum || Math.floor(assignedCount / 2) + 1;
  const down = freshLocations.filter(location => location.status === 'down').length;
  const failingLocations = freshLocations.filter(location => location.status !== 'up');
  let status: MonitoringStatus;
  if (assignedCount === 0 || freshLocations.length < quorum) status = 'unknown';
  else if (down >= quorum) status = 'down';
  else if (failingLocations.length > 0) status = 'warning';
  else status = 'up';
  return { status, quorum, assignedCount, freshCount: freshLocations.length, locations: freshLocations, failingLocations };
}
