import { query } from '../connection.js';

export async function recordFleetServiceObservation(input: {
  fleetServiceId: number;
  reachable: boolean | null;
  observedAt?: Date;
  errorCode?: string | null;
}): Promise<void> {
  const observedAt = input.observedAt ?? new Date();
  const observationKey = `${observedAt.toISOString()}:${input.reachable === null ? 'unknown' : input.reachable ? 'up' : 'down'}`;
  await query(
    `INSERT INTO fleet_service_observations (
       fleet_service_id, observation_key, observed_at, reachable, error_code
     )
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (fleet_service_id) DO UPDATE
     SET observation_key = EXCLUDED.observation_key,
         observed_at = EXCLUDED.observed_at,
         reachable = EXCLUDED.reachable,
         error_code = EXCLUDED.error_code,
         updated_at = CURRENT_TIMESTAMP
     WHERE fleet_service_observations.observed_at <= EXCLUDED.observed_at`,
    [
      input.fleetServiceId,
      observationKey,
      observedAt,
      input.reachable,
      input.errorCode?.slice(0, 64) ?? null,
    ]
  );
}
