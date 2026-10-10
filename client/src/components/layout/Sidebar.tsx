/**
 * Collapsible sidebar component with hierarchical menu groups.
 *
 * Features:
 * - Collapsible sidebar (narrow/wide modes)
 * - Hierarchical menu with nested expandable groups
 * - Persistent expansion state via localStorage
 * - Auto-expand ancestor groups containing the current route
 * - Dark mode toggle
 * - User menu with profile and logout
 * - Flyout menus when sidebar is collapsed
 *
 * Menu Structure:
 * - Dashboard (standalone)
 * - Mailboxes (Users, Aliases, Auto Aliases)
 * - Fleet
 *   - Services
 *   - Metrics
 *   - Robin (Queue, Metrics, Config, Delivery Test)
 *   - Rspamd (Config, DKIM Keys, Training, Metrics)
 * - Reports
 * - Administration
 *
 * Menu expansion state is stored in localStorage under
 * 'sidebar-expanded-groups' as a JSON array of stable group keys.
 * Groups are conditionally shown based on user permissions and feature flags.
 * Empty groups are hidden.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Bird,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Inbox,
  LogOut,
  Moon,
  Sun,
} from 'lucide-react';
import { appIcons, resolveModuleIcon, resolveModuleNavigationIcon } from '../../constants/appIcons';
import { useAuth } from '../../context/AuthContext';
import { capabilityAvailable, useFeatures } from '../../context/FeaturesContext';
import { useModules } from '../../context/ModulesContext';
import { useTheme } from '../../context/ThemeContext';
import { useIsAdmin } from '../../hooks/useAuth';
import type { AdminModule, FleetServiceType, ModuleDefinition, ModuleNavigationEntry } from '../../types';
import { UserAvatar } from '../ui/UserAvatar';

interface NavItem {
  type: 'item';
  key: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  show: boolean;
  end?: boolean;
  // For an item that stands in for several routes folded into in-page tabs
  // (e.g. Mailboxes -> Users/Aliases/Auto Aliases): highlight this entry
  // whenever the current path is any of these, not just `to` itself.
  matchPaths?: string[];
}

interface NavGroup {
  type: 'group';
  key: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  show?: boolean;
  children: NavEntry[];
}

type NavEntry = NavItem | NavGroup;

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

const EXPANDED_GROUPS_STORAGE_KEY = 'sidebar-expanded-groups';
const MAX_MODULE_NAV_DEPTH = 5;

function isNavGroup(entry: NavEntry): entry is NavGroup {
  return entry.type === 'group';
}

function loadExpandedGroups(): Set<string> {
  try {
    const saved = localStorage.getItem(EXPANDED_GROUPS_STORAGE_KEY);
    return saved ? new Set(JSON.parse(saved) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function persistExpandedGroups(groups: Set<string>): void {
  localStorage.setItem(EXPANDED_GROUPS_STORAGE_KEY, JSON.stringify([...groups]));
}

function filterNavEntries(entries: NavEntry[]): NavEntry[] {
  const visible: NavEntry[] = [];

  for (const entry of entries) {
    if (isNavGroup(entry)) {
      if (entry.show === false) {
        continue;
      }

      const children = filterNavEntries(entry.children);
      if (children.length === 0) {
        continue;
      }

      visible.push({ ...entry, children });
      continue;
    }

    if (entry.show) {
      visible.push(entry);
    }
  }

  return visible;
}

function isEntryActive(entry: NavEntry, pathname: string): boolean {
  if (!isNavGroup(entry)) {
    return pathname === entry.to;
  }

  return entry.children.some((child) => isEntryActive(child, pathname));
}

function findAncestorKeys(entries: NavEntry[], pathname: string, ancestors: string[] = []): string[] {
  for (const entry of entries) {
    if (isNavGroup(entry)) {
      const match = findAncestorKeys(entry.children, pathname, [...ancestors, entry.key]);
      if (match.length > 0) {
        return match;
      }
      continue;
    }

    if (pathname === entry.to) {
      return ancestors;
    }
  }

  return [];
}

function joinModulePath(basePath: string, relativePath?: string): string {
  const normalized = (relativePath ?? '').replace(/^\/+|\/+$/g, '');
  return normalized ? `${basePath}/${normalized}` : basePath;
}

function sanitizeNavKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'entry';
}

function buildModuleNavigationChildren(
  moduleEntry: AdminModule,
  entries: ModuleNavigationEntry[],
  parentKey: string,
  basePath: string,
  depth: number,
): NavEntry[] {
  if (depth > MAX_MODULE_NAV_DEPTH) {
    return [];
  }

  const resolvedEntries: NavEntry[] = [];

  for (const [index, entry] of entries.entries()) {
    const keyBase = `${parentKey}-${sanitizeNavKey(entry.label)}-${index}`;
    const EntryIcon = resolveModuleNavigationIcon(moduleEntry, entry.iconName);
    const childEntries = Array.isArray(entry.children)
      ? buildModuleNavigationChildren(moduleEntry, entry.children, keyBase, basePath, depth + 1)
      : [];

    if (childEntries.length > 0) {
      const landingChildren = entry.path
        ? [{
          type: 'item' as const,
          key: `${keyBase}-index`,
          to: joinModulePath(basePath, entry.path),
          icon: EntryIcon,
          label: entry.indexLabel ?? 'Overview',
          show: true,
          end: entry.path.replace(/^\/+|\/+$/g, '') === '',
        }]
        : [];

      resolvedEntries.push({
        type: 'group' as const,
        key: keyBase,
        icon: EntryIcon,
        label: entry.label,
        children: [...landingChildren, ...childEntries],
      });
      continue;
    }

    resolvedEntries.push({
      type: 'item' as const,
      key: keyBase,
      to: joinModulePath(basePath, entry.path),
      icon: EntryIcon,
      label: entry.label,
      show: true,
      end: (entry.path ?? '').replace(/^\/+|\/+$/g, '') === '',
    });
  }

  return resolvedEntries;
}

function buildModuleNavEntries(moduleEntry: AdminModule, moduleDefinition?: ModuleDefinition): NavEntry {
  const basePath = `/modules/${moduleEntry.routeSlug || moduleEntry.slug}`;
  const navigation = moduleDefinition?.navigation ?? [];
  const ModuleIcon = resolveModuleIcon(moduleEntry);

  if (navigation.length === 0) {
    return {
      type: 'item',
      key: `module-${moduleEntry.slug}`,
      to: basePath,
      icon: ModuleIcon,
      label: moduleEntry.displayName,
      show: true,
      end: true,
    };
  }

  return {
    type: 'group',
    key: `module-${moduleEntry.slug}`,
    icon: ModuleIcon,
    label: moduleEntry.displayName,
    children: buildModuleNavigationChildren(
      moduleEntry,
      navigation,
      `module-${moduleEntry.slug}`,
      basePath,
      1,
    ),
  };
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const DashboardIcon = appIcons.dashboard;
  const ProfileIcon = appIcons.profile;
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { features } = useFeatures();
  const { hostedModules, moduleDefinitions } = useModules();
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();
  const location = useLocation();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(loadExpandedGroups);
  const menuRef = useRef<HTMLDivElement>(null);
  // Collapsed-sidebar flyouts are rendered via a portal (fixed-positioned,
  // measured from the trigger button) instead of an absolutely-positioned
  // descendant of the scrollable <nav>. The nav needs `overflow-y-auto` for
  // long menus, and per the CSS spec that silently forces `overflow-x` to
  // `auto` as well (a "visible" value on one axis is not honored once the
  // other axis is non-visible), clipping any flyout that tried to overflow
  // past the sidebar's right edge. A portal sidesteps that clipping (and any
  // stacking-context ordering vs. the main content) entirely.
  const [flyoutGroup, setFlyoutGroup] = useState<{ key: string; rect: DOMRect } | null>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const flyoutCloseTimer = useRef<number | null>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
      if (event.target instanceof Element && !event.target.closest('aside') && !flyoutRef.current?.contains(event.target)) {
        setFlyoutGroup(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    setFlyoutGroup(null);
  }, [location.pathname]);

  function openFlyout(key: string, target: HTMLElement) {
    if (flyoutCloseTimer.current !== null) {
      window.clearTimeout(flyoutCloseTimer.current);
      flyoutCloseTimer.current = null;
    }
    setFlyoutGroup({ key, rect: target.getBoundingClientRect() });
  }

  function scheduleCloseFlyout() {
    flyoutCloseTimer.current = window.setTimeout(() => setFlyoutGroup(null), 150);
  }

  function cancelCloseFlyout() {
    if (flyoutCloseTimer.current !== null) {
      window.clearTimeout(flyoutCloseTimer.current);
      flyoutCloseTimer.current = null;
    }
  }

  const moduleNavItems: NavEntry[] = hostedModules.map((moduleEntry) => (
    buildModuleNavEntries(moduleEntry, moduleDefinitions[moduleEntry.slug])
  ));

  // Mailboxes is a single sidebar entry; Users, Aliases, and Auto Aliases live
  // as in-page tabs because aliases are occasional setup surfaces.
  const mailboxPaths = ['/users', '/aliases', '/auto-aliases'];
  const mailboxesNavItem: NavItem = {
    type: 'item',
    key: 'mailboxes',
    to: '/users',
    icon: Inbox,
    label: 'Mailboxes',
    show: features.mailboxes,
    matchPaths: mailboxPaths,
  };

  const can = (type: FleetServiceType, id: string) => capabilityAvailable(features, type, id);

  const navGroups: NavGroup[] = [
    {
      type: 'group',
      key: 'fleet',
      icon: appIcons.fleetInstances,
      label: 'Fleet',
      show: features.fleet,
      children: [
        { type: 'item', key: 'fleet-services', to: '/fleet', icon: appIcons.fleetInstances, label: 'Services', show: isAdmin, end: true },
        { type: 'item', key: 'fleet-agents', to: '/fleet/agents', icon: appIcons.fleetAgents, label: 'Agents', show: isAdmin },
        { type: 'item', key: 'fleet-metrics', to: '/fleet/metrics', icon: appIcons.fleetMetrics, label: 'Metrics', show: true },
        { type: 'item', key: 'fleet-docs', to: '/fleet/docs', icon: appIcons.fleetDocs, label: 'Docs', show: isAdmin },
        {
          type: 'group',
          key: 'fleet-robin',
          icon: Bird,
          label: 'Robin',
          show: features.robin,
          children: [
            { type: 'item', key: 'fleet-robin-queue', to: '/robin/queue', icon: appIcons.queue, label: 'Queue', show: can('robin', 'queue') },
            { type: 'item', key: 'fleet-robin-delivery-test', to: '/robin/delivery-test', icon: appIcons.deliveryTest, label: 'Delivery test', show: can('robin', 'deliveryTest') },
            { type: 'item', key: 'fleet-robin-metrics', to: '/robin/metrics', icon: appIcons.metrics, label: 'Metrics', show: can('robin', 'metrics') },
            { type: 'item', key: 'fleet-robin-config', to: '/robin/config', icon: appIcons.robinConfig, label: 'Config', show: can('robin', 'config') && isAdmin },
            { type: 'item', key: 'fleet-robin-logs', to: '/robin/logs', icon: appIcons.logs, label: 'Logs', show: can('robin', 'logs') && isAdmin },
          ],
        },
        {
          type: 'group',
          key: 'fleet-rspamd',
          icon: appIcons.rspamd,
          label: 'Rspamd',
          show: features.rspamd,
          children: [
            { type: 'item', key: 'fleet-rspamd-scan', to: '/rspamd/scan', icon: appIcons.rspamdScan, label: 'Scan', show: can('rspamd', 'scan') && isAdmin },
            { type: 'item', key: 'fleet-rspamd-training', to: '/rspamd/training', icon: appIcons.rspamdTraining, label: 'Training', show: can('rspamd', 'training') && isAdmin },
            { type: 'item', key: 'fleet-rspamd-dkim', to: '/rspamd/dkim', icon: appIcons.rspamdDkim, label: 'DKIM Keys', show: can('rspamd', 'dkim') && isAdmin },
            { type: 'item', key: 'fleet-rspamd-rules', to: '/rspamd/rules', icon: appIcons.rspamdRules, label: 'Rules', show: can('rspamd', 'rules') && isAdmin },
            { type: 'item', key: 'fleet-rspamd-metrics', to: '/rspamd/metrics', icon: appIcons.rspamdMetrics, label: 'Metrics', show: can('rspamd', 'metrics') },
            { type: 'item', key: 'fleet-rspamd-config', to: '/rspamd/config', icon: appIcons.rspamdConfig, label: 'Config', show: can('rspamd', 'config') && isAdmin },
            { type: 'item', key: 'fleet-rspamd-logs', to: '/rspamd/logs', icon: appIcons.logs, label: 'Logs', show: can('rspamd', 'logs') && isAdmin },
          ],
        },
        {
          type: 'group',
          key: 'fleet-clamav',
          icon: appIcons.clamav,
          label: 'ClamAV',
          show: features.clamav,
          children: [
            { type: 'item', key: 'fleet-clamav-scan', to: '/clamav/scan', icon: appIcons.clamavScan, label: 'Scan', show: can('clamav', 'scan') && isAdmin },
            { type: 'item', key: 'fleet-clamav-metrics', to: '/clamav/metrics', icon: appIcons.clamavMetrics, label: 'Metrics', show: can('clamav', 'metrics') },
            { type: 'item', key: 'fleet-clamav-config', to: '/clamav/config', icon: appIcons.clamavConfig, label: 'Config', show: can('clamav', 'config') && isAdmin },
            { type: 'item', key: 'fleet-clamav-logs', to: '/clamav/logs', icon: appIcons.logs, label: 'Logs', show: can('clamav', 'logs') && isAdmin },
          ],
        },
        {
          type: 'group',
          key: 'fleet-dovecot',
          icon: appIcons.dovecot,
          label: 'Dovecot',
          show: features.dovecot,
          children: [
            { type: 'item', key: 'fleet-dovecot-metrics', to: '/dovecot/metrics', icon: appIcons.dovecotMetrics, label: 'Metrics', show: can('dovecot', 'metrics') },
            { type: 'item', key: 'fleet-dovecot-config', to: '/dovecot/config', icon: appIcons.dovecotConfig, label: 'Config', show: can('dovecot', 'config') && isAdmin },
            { type: 'item', key: 'fleet-dovecot-logs', to: '/dovecot/logs', icon: appIcons.logs, label: 'Logs', show: can('dovecot', 'logs') && isAdmin },
          ],
        },
        {
          type: 'group',
          key: 'fleet-postfix',
          icon: appIcons.postfix,
          label: 'Postfix',
          show: features.postfix,
          children: [
            { type: 'item', key: 'fleet-postfix-queue', to: '/postfix/queue', icon: appIcons.postfixQueue, label: 'Queue', show: can('postfix', 'postfixQueue') && isAdmin },
            { type: 'item', key: 'fleet-postfix-metrics', to: '/postfix/metrics', icon: appIcons.postfixMetrics, label: 'Metrics', show: can('postfix', 'metrics') },
            { type: 'item', key: 'fleet-postfix-config', to: '/postfix/config', icon: appIcons.postfixConfig, label: 'Config', show: can('postfix', 'config') && isAdmin },
            { type: 'item', key: 'fleet-postfix-logs', to: '/postfix/logs', icon: appIcons.logs, label: 'Logs', show: can('postfix', 'logs') && isAdmin },
          ],
        },
        {
          type: 'group',
          key: 'fleet-redis',
          icon: appIcons.redis,
          label: 'Redis',
          show: features.redis,
          children: [
            { type: 'item', key: 'fleet-redis-metrics', to: '/redis/metrics', icon: appIcons.redisMetrics, label: 'Metrics', show: can('redis', 'metrics') },
            { type: 'item', key: 'fleet-redis-config', to: '/redis/config', icon: appIcons.redisConfig, label: 'Config', show: can('redis', 'config') && isAdmin },
            { type: 'item', key: 'fleet-redis-logs', to: '/redis/logs', icon: appIcons.logs, label: 'Logs', show: can('redis', 'logs') && isAdmin },
          ],
        },
        {
          type: 'group',
          key: 'fleet-postgres',
          icon: appIcons.postgres,
          label: 'PostgreSQL',
          show: features.postgres,
          children: [
            { type: 'item', key: 'fleet-postgres-metrics', to: '/postgres/metrics', icon: appIcons.postgresMetrics, label: 'Metrics', show: can('postgres', 'metrics') },
            { type: 'item', key: 'fleet-postgres-config', to: '/postgres/config', icon: appIcons.postgresConfig, label: 'Config', show: can('postgres', 'config') && isAdmin },
            { type: 'item', key: 'fleet-postgres-logs', to: '/postgres/logs', icon: appIcons.logs, label: 'Logs', show: can('postgres', 'logs') && isAdmin },
          ],
        },
        {
          type: 'group',
          key: 'fleet-mariadb',
          icon: appIcons.mariadb,
          label: 'MariaDB',
          show: features.mariadb,
          children: [
            { type: 'item', key: 'fleet-mariadb-metrics', to: '/mariadb/metrics', icon: appIcons.mariadbMetrics, label: 'Metrics', show: can('mariadb', 'metrics') },
            { type: 'item', key: 'fleet-mariadb-config', to: '/mariadb/config', icon: appIcons.mariadbConfig, label: 'Config', show: can('mariadb', 'config') && isAdmin },
            { type: 'item', key: 'fleet-mariadb-logs', to: '/mariadb/logs', icon: appIcons.logs, label: 'Logs', show: can('mariadb', 'logs') && isAdmin },
          ],
        },
      ],
    },
    {
      type: 'group',
      key: 'monitoring',
      icon: appIcons.monitoring,
      label: 'Monitoring',
      show: isAdmin && features.monitoring,
      children: [
        { type: 'item', key: 'monitoring-checks', to: '/monitoring', icon: appIcons.monitoring, label: 'Checks', show: isAdmin && features.monitoring, end: true },
        { type: 'item', key: 'monitoring-status-page', to: '/status-page', icon: appIcons.statusPage, label: 'Status page', show: isAdmin && features.monitoring },
        { type: 'item', key: 'monitoring-email-delivery', to: '/monitoring/email-delivery', icon: appIcons.email, label: 'Email delivery', show: isAdmin && features.monitoring },
      ],
    },
    {
      type: 'group',
      key: 'telemetry',
      icon: appIcons.telemetry,
      label: 'Telemetry',
      show: features.telemetry,
      children: [
        { type: 'item', key: 'telemetry-dashboards', to: '/telemetry', icon: appIcons.dashboard, label: 'Dashboard', show: features.telemetry, end: true },
        { type: 'item', key: 'telemetry-explore', to: '/telemetry/explore', icon: appIcons.telemetryExplore, label: 'Explore', show: features.telemetry },
        { type: 'item', key: 'telemetry-sources', to: '/telemetry/sources', icon: appIcons.telemetrySources, label: 'Sources', show: features.telemetry },
      ],
    },
    {
      type: 'group',
      key: 'reports',
      icon: appIcons.reportingOverview,
      label: 'Reports',
      show: features.reporting,
      children: [
        { type: 'item', key: 'reports-overview', to: '/reporting', icon: appIcons.reportingOverview, label: 'Overview', show: true, end: true },
        { type: 'item', key: 'reports-sources', to: '/reporting/sources', icon: appIcons.senderCatalog, label: 'Sources', show: true },
        { type: 'item', key: 'reports-domains', to: '/reporting/domains', icon: appIcons.domainPosture, label: 'Domains', show: true },
        { type: 'item', key: 'reports-explorer', to: '/reporting/explorer', icon: appIcons.reportingIssues, label: 'Explorer', show: true },
        {
          // Raw evidence is the appeal court for the derived views above it,
          // so it belongs underneath them rather than beside them.
          type: 'group',
          key: 'raw-data',
          icon: appIcons.dmarcRaw,
          label: 'Raw data',
          show: features.reporting,
          children: [
            { type: 'item', key: 'reports-dmarc-raw', to: '/dmarc', icon: appIcons.dmarcRaw, label: 'DMARC Reports', show: features.dmarc },
            { type: 'item', key: 'reports-tlsrpt-raw', to: '/tlsrpt', icon: appIcons.tlsrptRaw, label: 'TLSRPT Reports', show: true },
            { type: 'item', key: 'reports-forensic-raw', to: '/forensic', icon: appIcons.forensicRaw, label: 'Forensic reports', show: true },
          ],
        },
      ],
    },
    {
      type: 'group',
      key: 'modules',
      icon: appIcons.modules,
      label: 'Modules',
      show: features.modules,
      children: [
        { type: 'item', key: 'modules-list', to: '/modules', icon: appIcons.modules, label: 'Module list', show: true, end: true },
        ...moduleNavItems,
      ],
    },
    {
      type: 'group',
      key: 'administration',
      icon: appIcons.administration,
      label: 'Administration',
      children: [
        { type: 'item', key: 'administration-access', to: '/administration/access', icon: appIcons.access, label: 'Access', show: isAdmin },
        { type: 'item', key: 'administration-security', to: '/administration/security', icon: appIcons.security, label: 'Security', show: isAdmin },
        { type: 'item', key: 'administration-integration', to: '/administration/integration', icon: appIcons.integration, label: 'Integrations', show: isAdmin },
        { type: 'item', key: 'administration-reporting', to: '/administration/reporting', icon: appIcons.reporting, label: 'Reporting', show: isAdmin },
        { type: 'item', key: 'administration-telemetry', to: '/administration/telemetry', icon: appIcons.telemetry, label: 'Telemetry', show: isAdmin },
        { type: 'item', key: 'administration-monitoring', to: '/administration/monitoring', icon: appIcons.monitoring, label: 'Monitoring', show: isAdmin },
        { type: 'item', key: 'administration-alerts', to: '/administration/alerts', icon: appIcons.alerts, label: 'Alerts', show: isAdmin },
        { type: 'item', key: 'administration-email', to: '/administration/email', icon: appIcons.email, label: 'Email', show: isAdmin },
      ],
    },
  ];

  const visibleGroups = filterNavEntries(navGroups) as NavGroup[];

  useEffect(() => {
    const activeKeys = findAncestorKeys(visibleGroups, location.pathname);
    if (activeKeys.length === 0) {
      return;
    }

    setExpandedGroups((current) => {
      const next = new Set(current);
      let changed = false;

      for (const key of activeKeys) {
        if (!next.has(key)) {
          next.add(key);
          changed = true;
        }
      }

      if (!changed) {
        return current;
      }

      persistExpandedGroups(next);
      return next;
    });
  }, [location.pathname, visibleGroups]);

  const toggleGroup = (key: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      persistExpandedGroups(next);
      return next;
    });
  };

  const renderNavEntries = (entries: NavEntry[], level: number, inFlyout = false): React.ReactNode => (
    entries.map((entry) => {
      if (!isNavGroup(entry)) {
        const forcedActive = entry.matchPaths?.includes(location.pathname);
        return (
          <NavLink
            key={entry.key}
            to={entry.to}
            end={entry.end}
            className={({ isActive }) => `sidebar-link ${(forcedActive ?? isActive) ? 'active' : ''}`}
            style={!collapsed || inFlyout ? { paddingLeft: `${12 + level * 16}px` } : undefined}
          >
            <entry.icon className="w-4 h-4 shrink-0" />
            <span>{entry.label}</span>
          </NavLink>
        );
      }

      const isExpanded = expandedGroups.has(entry.key);
      const active = isEntryActive(entry, location.pathname);

      return (
        <div key={entry.key}>
          <button
            onClick={() => toggleGroup(entry.key)}
            className={`sidebar-link w-full ${active ? 'text-robin-orange' : ''}`}
            style={!collapsed || inFlyout ? { paddingLeft: `${12 + level * 16}px` } : undefined}
          >
            <entry.icon className="w-4 h-4 shrink-0" />
            <span className="flex-1 text-left">{entry.label}</span>
            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          {isExpanded && (
            <div className="ml-4 border-l border-gray-200 dark:border-robin-gray-700">
              {renderNavEntries(entry.children, level + 1, inFlyout)}
            </div>
          )}
        </div>
      );
    })
  );

  return (
    <aside
      className={`fixed top-0 left-0 h-screen bg-white/95 dark:bg-robin-gray-800/95 backdrop-blur-xs border-r border-gray-200/60 dark:border-robin-gray-700/60 transition-all duration-300 z-50 flex flex-col ${
        collapsed ? 'w-16' : 'w-72'
      }`}
    >
      <div className="flex items-center gap-3 px-4 py-5">
        <img src={`${import.meta.env.BASE_URL}robin-logo.svg`} alt="Robin" className="w-8 h-8 shrink-0 dark:drop-shadow-[0_0_1px_rgba(255,255,255,0.85)]" />
        {!collapsed && (
          <span className="text-lg font-bold text-gray-900 dark:text-white tracking-tight">Robin Admin</span>
        )}
      </div>

      <nav className="flex-1 px-3 py-2 space-y-1 overflow-y-auto overflow-x-visible">
        <NavLink
          to="/"
          className={({ isActive }) =>
            `sidebar-link ${isActive ? 'active' : ''} ${collapsed ? 'justify-center px-2' : ''}`
          }
          title={collapsed ? 'Dashboard' : undefined}
        >
          <DashboardIcon className="w-5 h-5 shrink-0" />
          {!collapsed && <span>Dashboard</span>}
        </NavLink>

        {mailboxesNavItem.show && (
          <NavLink
            to={mailboxesNavItem.to}
            className={({ isActive }) => {
              const active = mailboxesNavItem.matchPaths?.includes(location.pathname) ?? isActive;
              return `sidebar-link ${active ? 'active' : ''} ${collapsed ? 'justify-center px-2' : ''}`;
            }}
            title={collapsed ? mailboxesNavItem.label : undefined}
          >
            <mailboxesNavItem.icon className="w-5 h-5 shrink-0" />
            {!collapsed && <span>{mailboxesNavItem.label}</span>}
          </NavLink>
        )}

        {visibleGroups.map((group) => {
          const active = isEntryActive(group, location.pathname);
          const isExpanded = expandedGroups.has(group.key);

          return (
            <div key={group.key} className="mt-2">
              {collapsed ? (
                <div
                  className="relative"
                  onMouseEnter={(e) => openFlyout(group.key, e.currentTarget)}
                  onMouseLeave={scheduleCloseFlyout}
                >
                  <button
                    className={`sidebar-link w-full justify-center px-2 ${active ? 'text-robin-orange' : ''}`}
                    title={group.label}
                    aria-label={group.label}
                    aria-expanded={flyoutGroup?.key === group.key}
                    onClick={(event) => openFlyout(group.key, event.currentTarget.parentElement!)}
                    onKeyDown={(event) => { if (event.key === 'Escape') setFlyoutGroup(null); }}
                  >
                    <group.icon className="w-5 h-5 shrink-0" />
                  </button>
                  {flyoutGroup?.key === group.key &&
                    createPortal(
                      <div
                        ref={flyoutRef}
                        style={{ position: 'fixed', top: flyoutGroup.rect.top, left: flyoutGroup.rect.right + 8 }}
                        className="z-70"
                        onKeyDown={(event) => { if (event.key === 'Escape') setFlyoutGroup(null); }}
                        onMouseEnter={cancelCloseFlyout}
                        onMouseLeave={scheduleCloseFlyout}
                      >
                        <div className="bg-white dark:bg-robin-gray-800 border border-gray-200 dark:border-robin-gray-700 rounded-lg shadow-lg py-1 min-w-[220px]">
                          <div className="px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400">
                            {group.label}
                          </div>
                          {renderNavEntries(group.children, 0, true)}
                        </div>
                      </div>,
                      document.body
                    )}
                </div>
              ) : (
                <>
                  <button
                    onClick={() => toggleGroup(group.key)}
                    className={`sidebar-link w-full ${active ? 'text-robin-orange' : ''}`}
                  >
                    <group.icon className="w-5 h-5 shrink-0" />
                    <span className="flex-1 text-left">{group.label}</span>
                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                  {isExpanded && (
                    <div className="ml-4 border-l border-gray-200 dark:border-robin-gray-700">
                      {renderNavEntries(group.children, 0)}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </nav>

      <div className="p-2 border-t border-gray-200 dark:border-robin-gray-700">
        {user && (
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className={`sidebar-link w-full ${collapsed ? 'justify-center px-2' : ''}`}
              title={collapsed ? `${user.name} <${user.email}>` : undefined}
            >
              {collapsed ? (
                <UserAvatar email={user.email} size={24} />
              ) : (
                <>
                  <UserAvatar email={user.email} size={24} />
                  <span className="truncate flex-1 text-left">{user.name}</span>
                  <ChevronUp className={`w-4 h-4 transition-transform ${userMenuOpen ? '' : 'rotate-180'}`} />
                </>
              )}
            </button>

            {userMenuOpen && (
              <div className={`absolute ${collapsed ? 'left-full ml-2' : 'left-0 right-0'} bottom-full mb-1 bg-white dark:bg-robin-gray-800 border border-gray-200 dark:border-robin-gray-700 rounded-lg shadow-lg overflow-hidden z-70`}>
                <button
                  onClick={() => { navigate('/profile'); setUserMenuOpen(false); }}
                  className="sidebar-link w-full"
                >
                  <ProfileIcon className="w-5 h-5 shrink-0" />
                  <span>Profile</span>
                </button>
                <button
                  onClick={toggleTheme}
                  className="sidebar-link w-full"
                >
                  {theme === 'dark' ? (
                    <Sun className="w-5 h-5 shrink-0" />
                  ) : (
                    <Moon className="w-5 h-5 shrink-0" />
                  )}
                  <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
                </button>
                <button
                  onClick={() => { logout(); setUserMenuOpen(false); }}
                  className="sidebar-link w-full text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                >
                  <LogOut className="w-5 h-5 shrink-0" />
                  <span>Logout</span>
                </button>
              </div>
            )}
          </div>
        )}

        <button
          onClick={onToggle}
          className={`sidebar-link w-full ${collapsed ? 'justify-center px-2' : ''}`}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <ChevronRight className="w-5 h-5 shrink-0" />
          ) : (
            <>
              <ChevronLeft className="w-5 h-5 shrink-0" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
