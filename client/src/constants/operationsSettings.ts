export const OPERATION_FIELDS = [
  ['alertEvaluationIntervalMs', 'Evaluator interval (ms)', 30000, 5000, 300000, 'alerts'],
  ['alertDeliveryIntervalMs', 'Delivery interval (ms)', 5000, 1000, 30000, 'alerts'],
  ['alertDeliveryConcurrency', 'Delivery concurrency', 4, 1, 16, 'alerts'],
  ['alertDeliveryExpiryMs', 'Expire pending deliveries after (ms)', 3600000, 60000, 2592000000, 'alerts'],
  ['alertDeliveryMaxAttempts', 'Maximum delivery attempts', 5, 1, 10, 'alerts'],
  ['alertRetryBaseMs', 'Retry base delay (ms)', 30000, 1000, 300000, 'alerts'],
  ['alertRetryMaxMs', 'Retry maximum delay (ms)', 900000, 1000, 3600000, 'alerts'],
  ['fleetAgentOnlineThresholdMs', 'Agent online window (ms)', 90000, 30000, 600000, 'fleet'],
  ['fleetCommandTimeoutMs', 'Default command timeout (ms)', 20000, 1000, 120000, 'fleet'],
  ['fleetCommandLeaseMs', 'Command lease (ms)', 30000, 5000, 120000, 'fleet'],
  ['fleetCommandPollWaitMs', 'Command poll wait (ms)', 25000, 1000, 25000, 'fleet'],
  ['fleetCommandBatchSize', 'Commands per poll', 20, 1, 20, 'fleet'],
  ['reportingIngestMaxMiB', 'Maximum report payload (MiB)', 5, 1, 20, 'reporting'],
] as const;
export type OperationsNumericKey = typeof OPERATION_FIELDS[number][0];
export type OperationsPolicy = Record<OperationsNumericKey, number> & { alertsEnabled: boolean; alertInstanceName: string };
export function operationsDefaults(): OperationsPolicy {
  return { ...Object.fromEntries(OPERATION_FIELDS.map(([key, , value]) => [key, value])),
    alertsEnabled: false, alertInstanceName: 'Robin Admin' } as OperationsPolicy;
}
