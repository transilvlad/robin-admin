export const EMAIL_RELAY_TYPES = ['smtp', 'robin', 'postfix'] as const;
export const EMAIL_SMTP_SECURITY = ['none', 'starttls', 'tls'] as const;
export const EMAIL_TLS_MODES = ['strict', 'allow_self_signed'] as const;
export const EMAIL_SENDER_PROFILE_KEYS = ['system', 'alerts', 'status'] as const;
export const EMAIL_DELIVERY_STATUSES = ['pending', 'processing', 'accepted', 'failed', 'cancelled'] as const;
export const STATUS_PAGE_SUBSCRIBER_STATUSES = ['pending', 'confirmed', 'unsubscribed'] as const;

export type EmailRelayType = (typeof EMAIL_RELAY_TYPES)[number];
export type EmailSmtpSecurity = (typeof EMAIL_SMTP_SECURITY)[number];
export type EmailTlsMode = (typeof EMAIL_TLS_MODES)[number];
export type EmailSenderProfileKey = (typeof EMAIL_SENDER_PROFILE_KEYS)[number];
export type EmailDeliveryStatus = (typeof EMAIL_DELIVERY_STATUSES)[number];
export type StatusPageSubscriberStatus = (typeof STATUS_PAGE_SUBSCRIBER_STATUSES)[number];

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
  createdAt: Date;
  updatedAt: Date;
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
  createdAt: Date;
  updatedAt: Date;
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
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface StatusPageSubscriber {
  id: number;
  email: string;
  status: StatusPageSubscriberStatus;
  allComponents: boolean;
  componentIds: number[];
  confirmedAt: Date | null;
  unsubscribedAt: Date | null;
  lastNotifiedAt: Date | null;
  confirmationSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
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
  createdAt: Date;
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
  nextAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  lastRelayId: number | null;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  completedAt: Date | null;
  deliveryAttempts: EmailDeliveryAttempt[];
}

export interface EmailTransportAdminView {
  relays: EmailRelay[];
  senderProfiles: EmailSenderProfile[];
  deliveries: EmailDelivery[];
}
