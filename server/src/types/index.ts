/**
 * Type definitions for Robin Admin.
 */

// Admin roles
export type AdminRole = 'viewer' | 'editor' | 'admin';

// Admin user
export interface Admin {
  id: number;
  uid: string;
  name: string;
  email: string;
  role: AdminRole;
  allowedCidrs: string[];
  createdAt: Date;
  updatedAt: Date;
  lastLogin: Date | null;
  disabled: boolean;
}

// Admin with password hash (internal use only)
export interface AdminWithPassword extends Admin {
  passwordHash: string;
}

// Mail user (Dovecot virtual user). The schema varies between deployments,
// so `extra` carries any non-standard column values verbatim.
export interface MailUser {
  id: number;
  email: string;
  uid: number;
  gid: number;
  home: string | null;
  maildir: string | null;
  extra?: Record<string, unknown>;
}

// Alias
export interface Alias {
  id: number;
  source: string;
  destination: string;
}

// Queue item
export interface QueueItem {
  id: number;
  queueUid: string;
  state: string;
  nextAttemptAt: number;
  claimedUntil: number;
  claimOwner: string | null;
  createdEpoch: number;
  updatedEpoch: number;
  retryCount: number;
  protocol: string | null;
  sessionUid: string | null;
  lastError: string | null;
}

// Audit log entry
export interface AuditLogEntry {
  id: number;
  adminId: number | null;
  action: string;
  entityType: string;
  entityId: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: Date;
}

// Session data stored in express-session
export interface SessionData {
  adminId: number;
  // API keys are independent principals, not their creating admin.
  uid?: string;
  name: string;
  email: string;
  role: AdminRole;
  allowedCidrs?: string[];
}

// API response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// Request types
export interface CreateAdminRequest {
  name: string;
  email: string;
  password: string;
  role: AdminRole;
  allowedCidrs?: string[] | string;
  disabled?: boolean;
}

export interface UpdateAdminRequest {
  name?: string;
  email?: string;
  password?: string;
  role?: AdminRole;
  allowedCidrs?: string[] | string;
  disabled?: boolean;
}

export interface CreateUserRequest {
  email: string;
  password: string;
  uid?: number;
  gid?: number;
}

export interface UpdateUserRequest {
  email?: string;
  password?: string;
  uid?: number;
  gid?: number;
}

export interface CreateAliasRequest {
  source: string;
  destination: string;
}

export interface UpdateAliasRequest {
  source?: string;
  destination?: string;
}

export interface SetupRequest {
  setupId: string;
  name: string;
  email: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

// Queue action types
export type QueueAction = 'retry' | 'delete' | 'bounce';

export interface QueueActionRequest {
  uid?: string;
  uids?: string[];
}

// Re-export reporting types
export * from './reporting.js';
