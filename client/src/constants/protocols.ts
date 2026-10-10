/**
 * Robin protocol definitions and styling.
 * Single source of truth for all protocol-related constants.
 */

export type Protocol = 'esmtp' | 'smtp' | 'lmtp' | 'dovecot-lda' | 'stalwart-direct';

export interface ProtocolConfig {
  label: string;
  color: string;           // Hex color for charts
  badgeClass: string;      // Tailwind classes for badges
}

// Robin supported protocols with their styling
export const PROTOCOLS: Record<Protocol, ProtocolConfig> = {
  esmtp: {
    label: 'ESMTP',
    color: '#3B82F6',
    badgeClass: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
  },
  smtp: {
    label: 'SMTP',
    color: '#06B6D4',
    badgeClass: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-400',
  },
  lmtp: {
    label: 'LMTP',
    color: '#10B981',
    badgeClass: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  },
  'dovecot-lda': {
    label: 'Dovecot LDA',
    color: '#F59E0B',
    badgeClass: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  },
  'stalwart-direct': {
    label: 'Stalwart direct',
    color: '#8B5CF6',
    badgeClass: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400',
  },
};

const UNKNOWN_PROTOCOL: ProtocolConfig = {
  label: 'Unknown',
  color: '#6B7280',
  badgeClass: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
};

/**
 * Get protocol configuration by name (case-insensitive).
 */
export function getProtocol(protocol: string | null | undefined): ProtocolConfig {
  if (!protocol) return UNKNOWN_PROTOCOL;
  const key = protocol.toLowerCase() as Protocol;
  return PROTOCOLS[key] || UNKNOWN_PROTOCOL;
}

/**
 * Get protocol hex color for charts.
 */
export function getProtocolColor(protocol: string): string {
  return getProtocol(protocol).color;
}

/**
 * Get protocol badge classes for UI.
 */
export function getProtocolBadgeClass(protocol: string): string {
  return getProtocol(protocol).badgeClass;
}
