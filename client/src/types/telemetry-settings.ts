export interface TelemetryConnection {
  revision: string;
  mode: 'disabled' | 'bundled' | 'external';
  url: string;
  auth: 'none' | 'basic' | 'bearer';
  username: string;
  allowPrivate: boolean;
  secretConfigured: boolean;
}
export type TelemetryConnectionUpdate = Omit<TelemetryConnection, 'secretConfigured'> & { secret?: string; clearSecret?: boolean };
export interface TelemetrySnapshot { name: string; createdAt: string }
