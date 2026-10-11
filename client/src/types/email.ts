export type EmailRelayType = 'smtp' | 'robin' | 'postfix';
export type EmailSmtpSecurity = 'none' | 'starttls' | 'tls';
export type EmailTlsMode = 'strict' | 'allow_self_signed';
export type EmailSenderProfileKey = 'system' | 'alerts' | 'status';
export type EmailDeliveryStatus = 'pending' | 'processing' | 'accepted' | 'failed' | 'cancelled';
export type StatusPageSubscriberStatus = 'pending' | 'confirmed' | 'unsubscribed';

export interface EmailRelay {
  id: number;
  name: string;
  relayType: EmailRelayType;
  enabled: boolean;
  priority: number;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: EmailSmtpSecurity;
  tlsMode: EmailTlsMode;
  username: string | null;
  hasPassword: boolean;
  robinServiceId: string | null;
  postfixServiceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmailSenderProfile {
  profileKey: EmailSenderProfileKey;
  displayName: string;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  envelopeFrom: string | null;
  enabled: boolean;
  relayIds: number[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminEmailSubscription {
  adminId: number;
  adminName: string;
  adminEmail: string;
  disabled: boolean;
  monitoringIssueOpened: boolean;
  monitoringIssueRecovered: boolean;
  statusPageReports: boolean;
  emailDeliveryFailure: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface StatusPageSubscriber {
  id: number;
  email: string;
  status: StatusPageSubscriberStatus;
  allComponents: boolean;
  componentIds: number[];
  confirmedAt: string | null;
  unsubscribedAt: string | null;
  lastNotifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmailDeliveryAttempt {
  id: number;
  deliveryId: number;
  relayId: number | null;
  relayName: string;
  attemptNumber: number;
  accepted: boolean;
  response: string | null;
  error: string | null;
  createdAt: string;
}

export interface EmailDelivery {
  id: number;
  purpose: string;
  senderProfileKey: EmailSenderProfileKey;
  recipientEmail: string;
  recipientKind: string;
  subject: string;
  status: EmailDeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastRelayId: number | null;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  completedAt: string | null;
  deliveryAttempts: EmailDeliveryAttempt[];
}

export interface EmailTransportAdminView {
  relays: EmailRelay[];
  senderProfiles: EmailSenderProfile[];
  deliveries: EmailDelivery[];
}
