/**
 * Configuration page for admin settings.
 */

import { useState, useEffect, useRef, type ComponentType, type ReactNode } from 'react';
import { Save, RefreshCw, Trash2, Shield, Globe, Database, Clock, KeyRound, Ban, Server, Activity, Radio, ScrollText, Package } from 'lucide-react';
import { configApi, ipJailApi, ApiError, type IpJailEntry } from '../api/client';
import type { RuntimeConfig } from '../types';
import { AdminNotice, AdminStat, ReadOnlyList, SettingsCard, StatusBadge } from '../components/administration/AdminPrimitives';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { MetricTabs, type MetricTab } from '../components/ui/MetricTabs';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import { useFeatures } from '../context/FeaturesContext';
import { useConfirm } from '../context/ConfirmContext';
import { useIsAdmin } from '../hooks/useAuth';
import { OperationsPolicyFields } from '../components/administration/OperationsPolicyFields';
import { ModuleHostPolicies, type ModuleHostPoliciesHandle } from '../components/administration/ModuleHostPolicies';
import { ModuleIdentityRotation } from '../components/administration/ModuleIdentityRotation';
import { operationsDefaults, type OperationsPolicy } from '../constants/operationsSettings';

export type ConfigSection =
  | 'security'
  | 'integration'
  | 'reporting';

interface AdminConfig extends OperationsPolicy {
  reportingCacheMiB: number;
  reportingCacheEntries: number;
  reportingCacheTtlSeconds: number;
  reportingSourceConcurrency: number;
  reportingSourceQueueSize: number;
  reportingSourceQueueWaitMs: number;
  reportingRetentionDays: number;
  auditLogRetentionDays: number;
  gravatarEnabled: boolean;
  gravatarDefault: string;
  reportingMtaStsChecksEnabled: boolean;
  reportingTlsrptChecksEnabled: boolean;
  reportingDaneChecksEnabled: boolean;
  reportingBimiChecksEnabled: boolean;
  reportingIntegrationEnabled: boolean;
  sessionTimeoutMinutes: number;
  sessionAbsoluteLifetimeMinutes: number;
  maxLoginAttempts: number;
  loginLockoutMinutes: number;
  loginProtectionEnabled: boolean;
  loginMaxAttemptsPerEmail: number;
  loginMaxAttemptsPerIp: number;
  globalIpAllowlist: string;
  ingestionAuthRequired: boolean;
  ingestionAllowedCidrs: string;
  ingestionSecretConfigured: boolean;
  csrfProtectionEnabled: boolean;
  allowedOrigins: string;
  trustedProxyCidrs: string;
  allowPrivateServiceUrls: boolean;
  apiKeyMaxLifetimeDays: number;
  fleetEnabled: boolean;
  mailboxesEnabled: boolean;
  monitoringEnabled: boolean;
  telemetryEnabled: boolean;
  modulesEnabled: boolean;
  robinConfigTableName: string;
  alertDeliveryRetentionDays: number;
  reportingDefaultWindowDays: number;
  reportingStaleAfterDays: number;
  reportingAnalysisDebounceMs: number;
  reportingAnalysisConcurrency: number;
  reportingNonCompliantRateThreshold: number;
  reportingNonCompliantMinVolume: number;
  reportingNonCompliantAbsoluteFloor: number;
  detectionUnknownSenderMinVolume: number;
  detectionSpoofingMinFailCount: number;
  detectionMisconfiguredMinVolume: number;
  detectionDmarcFailingPassRate: number;
  detectionTlsFailureRate: number;
  detectionTlsMinFailures: number;
  detectionForensicSpikeMultiplier: number;
  detectionForensicSpikeMinRecent: number;
  detectionForensicClusterMinOccurrences: number;
  detectionForensicClusterMaxIssues: number;
  detectionRequiredRuns: number;
  detectionGraceRuns: number;
  sourceIdentityTtlDays: number;
  sourceIdentityConcurrency: number;
  sourceIdentityTimeoutMs: number;
  dnsResolvers: string;
  senderEnrichmentDnsTimeoutMs: number;
  metricsPollIntervalMs: number;
  metricsRetentionDays: number;
  logDefaultLines: number;
  logMaxLines: number;
}

type ReportingUsageStats = {
  dmarc: {
    reports: number;
    records: number;
    oldestReportDate: string | null;
    newestReportDate: string | null;
    storageBytes: number;
  };
  tlsrpt: {
    reports: number;
    policies: number;
    failures: number;
    oldestReportDate: string | null;
    newestReportDate: string | null;
    storageBytes: number;
  };
  forensic: {
    reports: number;
    oldestReportDate: string | null;
    newestReportDate: string | null;
    storageBytes: number;
  };
};

type NewJailForm = {
  cidr: string;
  reason: string;
  expiresAt: string;
};

type SecurityTab = 'login' | 'network' | 'jail' | 'runtime' | 'audit' | 'identity';
type IntegrationTab = 'capabilities' | 'configStore' | 'modules' | 'avatars';
type ReportingTab = 'workspaces' | 'analysis' | 'detection' | 'dns' | 'ingestion' | 'retention';
type ConfigTab = SecurityTab | IntegrationTab | ReportingTab;

const SECURITY_TABS: readonly MetricTab<SecurityTab>[] = [
  { id: 'login', label: 'Login', icon: Shield },
  { id: 'network', label: 'Network', icon: Globe },
  { id: 'jail', label: 'IP Jail', icon: Ban },
  { id: 'runtime', label: 'Runtime', icon: ScrollText },
  { id: 'audit', label: 'Audit', icon: Activity },
  { id: 'identity', label: 'Module identity', icon: KeyRound },
];

const INTEGRATION_TABS: readonly MetricTab<IntegrationTab>[] = [
  { id: 'capabilities', label: 'Capabilities', icon: Server },
  { id: 'configStore', label: 'Config store', icon: Database },
  { id: 'modules', label: 'Modules', icon: Package },
  { id: 'avatars', label: 'Avatars', icon: Globe },
];

const CAPABILITY_SWITCHES = [
  { key: 'mailboxesEnabled', label: 'Enable mailboxes', description: 'Shows Mailboxes and enables mailbox APIs. Mailbox data is retained when disabled.' },
  { key: 'fleetEnabled', label: 'Enable fleet', description: 'Shows Fleet and its service workspaces. Registered services and their settings are retained when disabled.' },
  { key: 'monitoringEnabled', label: 'Enable monitoring', description: 'Shows Monitoring and runs scheduled checks. Checks and their history are retained when disabled.' },
  { key: 'telemetryEnabled', label: 'Enable telemetry', description: 'Shows Telemetry dashboards, Explore and Sources. Stored metrics and dashboards are retained when disabled.' },
  { key: 'reportingIntegrationEnabled', label: 'Enable reports', description: 'Shows Reports and its reporting workspaces. Stored reports and ingestion settings are retained when disabled.' },
  { key: 'modulesEnabled', label: 'Enable modules', description: 'Shows Modules and installed module navigation. Installed modules and their data are retained when disabled.' },
] as const;

const REPORTING_TABS: readonly MetricTab<ReportingTab>[] = [
  { id: 'workspaces', label: 'Workspaces', icon: Globe },
  { id: 'analysis', label: 'Analysis', icon: Activity },
  { id: 'detection', label: 'Detection', icon: Shield },
  { id: 'dns', label: 'DNS', icon: Radio },
  { id: 'ingestion', label: 'Ingestion', icon: KeyRound },
  { id: 'retention', label: 'Retention', icon: Clock },
];

const GRAVATAR_DEFAULTS = [
  { value: 'monsterid', label: 'Monster ID' },
  { value: 'identicon', label: 'Identicon' },
  { value: 'wavatar', label: 'Wavatar' },
  { value: 'retro', label: 'Retro' },
  { value: 'robohash', label: 'RoboHash' },
  { value: 'blank', label: 'Blank' },
  { value: 'mp', label: 'Mystery person' },
];

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatDate(value: string | null): string {
  if (!value) return 'None';
  return new Date(value).toLocaleDateString();
}

function formatDurationMs(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

interface SectionCardProps {
  title: string;
  description?: string;
  icon: ComponentType<{ className?: string }>;
  children: ReactNode;
  className?: string;
}

function SectionCard({ title, description, icon: Icon, children, className = '' }: SectionCardProps) {
  return (
    <SettingsCard
      title={title}
      description={description}
      icon={Icon}
      className={`min-w-0 ${className}`}
      bodyClassName="space-y-5 p-5"
    >
      {children}
    </SettingsCard>
  );
}

function ConfiguredStatus({ configured }: { configured: boolean }) {
  return <StatusBadge tone={configured ? 'success' : 'warning'}>{configured ? 'Configured' : 'Not configured'}</StatusBadge>;
}

function tabsForSection(section: ConfigSection): readonly MetricTab<ConfigTab>[] {
  if (section === 'integration') return INTEGRATION_TABS;
  if (section === 'reporting') return REPORTING_TABS;
  return SECURITY_TABS;
}

function defaultTabForSection(section: ConfigSection): ConfigTab {
  if (section === 'integration') return 'capabilities';
  if (section === 'reporting') return 'workspaces';
  return 'login';
}

function storageKeyForSection(section: ConfigSection): string {
  return `robin-admin.${section}.tab`;
}

function initialTabForSection(section: ConfigSection): ConfigTab {
  const tabs = tabsForSection(section);
  const saved = localStorage.getItem(storageKeyForSection(section));
  return tabs.some((tab) => tab.id === saved) ? saved as ConfigTab : defaultTabForSection(section);
}

function tabForSection(section: ConfigSection, tab: string | null): ConfigTab | null {
  return tabsForSection(section).some((candidate) => candidate.id === tab) ? tab as ConfigTab : null;
}

export function ConfigPageView({ section = 'security' }: { section?: ConfigSection }) {
  const confirm = useConfirm();
  const isAdmin = useIsAdmin();
  const { refresh: refreshFeatures } = useFeatures();
  const [config, setConfig] = useState<AdminConfig>({
    ...operationsDefaults(),
    reportingRetentionDays: 365,
    reportingCacheMiB: 128,
    reportingCacheEntries: 200,
    reportingCacheTtlSeconds: 300,
    reportingSourceConcurrency: 2,
    reportingSourceQueueSize: 8,
    reportingSourceQueueWaitMs: 30000,
    auditLogRetentionDays: 0,
    gravatarEnabled: true,
    gravatarDefault: 'monsterid',
    reportingMtaStsChecksEnabled: false,
    reportingTlsrptChecksEnabled: false,
    reportingDaneChecksEnabled: false,
    reportingBimiChecksEnabled: false,
    reportingIntegrationEnabled: false,
    sessionTimeoutMinutes: 60,
    sessionAbsoluteLifetimeMinutes: 1440,
    maxLoginAttempts: 5,
    loginLockoutMinutes: 15,
    loginProtectionEnabled: true,
    loginMaxAttemptsPerEmail: 5,
    loginMaxAttemptsPerIp: 20,
    globalIpAllowlist: '',
    ingestionAuthRequired: true,
    ingestionAllowedCidrs: '',
    ingestionSecretConfigured: false,
    csrfProtectionEnabled: true,
    allowedOrigins: '',
    trustedProxyCidrs: '',
    allowPrivateServiceUrls: false,
    apiKeyMaxLifetimeDays: 365,
    fleetEnabled: false,
    mailboxesEnabled: false,
    monitoringEnabled: false,
    telemetryEnabled: false,
    modulesEnabled: false,
    robinConfigTableName: 'robin_config_store',
    alertDeliveryRetentionDays: 30,
    reportingDefaultWindowDays: 30,
    reportingStaleAfterDays: 7,
    reportingAnalysisDebounceMs: 10000,
    reportingAnalysisConcurrency: 4,
    reportingNonCompliantRateThreshold: 0.02,
    reportingNonCompliantMinVolume: 10,
    reportingNonCompliantAbsoluteFloor: 100,
    detectionUnknownSenderMinVolume: 50,
    detectionSpoofingMinFailCount: 100,
    detectionMisconfiguredMinVolume: 1000,
    detectionDmarcFailingPassRate: 0.95,
    detectionTlsFailureRate: 0.1,
    detectionTlsMinFailures: 10,
    detectionForensicSpikeMultiplier: 2,
    detectionForensicSpikeMinRecent: 3,
    detectionForensicClusterMinOccurrences: 2,
    detectionForensicClusterMaxIssues: 10,
    detectionRequiredRuns: 2,
    detectionGraceRuns: 2,
    sourceIdentityTtlDays: 30,
    sourceIdentityConcurrency: 12,
    sourceIdentityTimeoutMs: 3000,
    dnsResolvers: '1.1.1.1,8.8.8.8,9.9.9.9',
    senderEnrichmentDnsTimeoutMs: 3000,
    metricsPollIntervalMs: 60000,
    metricsRetentionDays: 14,
    logDefaultLines: 200,
    logMaxLines: 1000,
  });
  const [reportingUsage, setReportingUsage] = useState<ReportingUsageStats | null>(null);
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null);
  const [ipJailEntries, setIpJailEntries] = useState<IpJailEntry[]>([]);
  const [showInactiveJail, setShowInactiveJail] = useState(false);
  const [newJail, setNewJail] = useState<NewJailForm>({
    cidr: '',
    reason: '',
    expiresAt: '',
  });
  const [ingestionSecret, setIngestionSecret] = useState('');
  const [clearLockEmail, setClearLockEmail] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isCleaningReporting, setIsCleaningReporting] = useState(false);
  const [isCleaningAuditLog, setIsCleaningAuditLog] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const modulePoliciesRef = useRef<ModuleHostPoliciesHandle>(null);
  const [activeTab, setActiveTabState] = useState<ConfigTab>(() => initialTabForSection(section));

  useEffect(() => {
    fetchConfig();
  }, [section, isAdmin]);

  useEffect(() => {
    const queryTab = typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search).get('tab');
    setActiveTabState(tabForSection(section, queryTab) ?? initialTabForSection(section));
  }, [section]);

  const setActiveTab = (tab: ConfigTab) => {
    setActiveTabState(tab);
    localStorage.setItem(storageKeyForSection(section), tab);
  };

  useEffect(() => {
    if (isAdmin) {
      fetchIpJail();
    }
  }, [showInactiveJail]);

  const fetchConfig = async () => {
    try {
      const [configResponse, jailResponse] = await Promise.all([
        configApi.get(),
        isAdmin ? ipJailApi.list(showInactiveJail) : Promise.resolve(null),
      ]);
      const runtimeResponse = isAdmin ? await configApi.getRuntime() : null;
      if (configResponse.data) {
        setConfig(configResponse.data);
      }
      if (runtimeResponse?.data) {
        setRuntime(runtimeResponse.data);
      }
      if (jailResponse?.data) {
        setIpJailEntries(jailResponse.data);
      }
      if (section === 'reporting' && isAdmin) {
        const usageResponse = await configApi.getReportingUsage();
        setReportingUsage(usageResponse.data ?? null);
      }
    } catch (err) {
      console.error('Failed to load config');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchIpJail = async () => {
    if (!isAdmin) return;
    const response = await ipJailApi.list(showInactiveJail);
    setIpJailEntries(response.data ?? []);
  };

  const handleCreateJail = async () => {
    if (!isAdmin) return;
    setError('');
    setSuccess('');
    try {
      await ipJailApi.create({
        cidr: newJail.cidr.trim(),
        reason: newJail.reason || undefined,
        expiresAt: newJail.expiresAt ? new Date(newJail.expiresAt).toISOString() : null,
      });
      setSuccess('IP jail entry created');
      setNewJail({
        cidr: '',
        reason: '',
        expiresAt: '',
      });
      await fetchIpJail();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create jail entry');
    }
  };

  const handleLiftJail = async (id: number) => {
    if (!isAdmin || !(await confirm('Lift this jail entry?'))) return;
    try {
      await ipJailApi.lift(id);
      setSuccess('Jail entry lifted');
      await fetchIpJail();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to lift jail entry');
    }
  };

  const handleSetInfinite = async (id: number) => {
    if (!isAdmin) return;
    try {
      await ipJailApi.update(id, { expiresAt: null });
      setSuccess('Jail entry set to infinite');
      await fetchIpJail();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update jail entry');
    }
  };

  const handleRotateIngestionSecret = async () => {
    if (!isAdmin) return;
    try {
      await configApi.rotateIngestionSecret(ingestionSecret);
      setConfig({ ...config, ingestionSecretConfigured: true });
      setIngestionSecret('');
      setSuccess('Ingestion secret rotated');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to rotate ingestion secret');
    }
  };

  const handleClearLoginLocks = async () => {
    if (!isAdmin) return;
    try {
      const response = await configApi.clearLoginLocks(clearLockEmail || undefined);
      setSuccess(`Cleared ${response.data?.cleared ?? 0} login lock entries`);
      setClearLockEmail('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to clear login locks');
    }
  };

  const handleSave = async () => {
    if (!isAdmin) return;
    
    setError('');
    setSuccess('');
    setIsSaving(true);

    try {
      if (section === 'integration' && activeTab === 'modules') {
        if (!await modulePoliciesRef.current?.saveAll()) throw new Error('Module policies were not saved');
        setSuccess('Module policies saved successfully');
        return;
      }
      await configApi.update(config);
      await refreshFeatures();
      setSuccess('Configuration saved successfully');
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to save configuration');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleCleanupReporting = async () => {
    if (!isAdmin) return;
    
    if (!(await confirm(`This will delete DMARC, TLSRPT, and forensic reports older than ${config.reportingRetentionDays} days. Continue?`))) {
      return;
    }

    setIsCleaningReporting(true);
    try {
      const response = await configApi.cleanupReporting();
      const deleted = response.data ?? { dmarc: 0, tlsrpt: 0, forensic: 0, total: 0 };
      setSuccess(`Cleaned up ${deleted.total} old reports (${deleted.dmarc} DMARC, ${deleted.tlsrpt} TLSRPT, ${deleted.forensic} forensic)`);
      const usageResponse = await configApi.getReportingUsage();
      setReportingUsage(usageResponse.data ?? null);
    } catch (err) {
      setError('Failed to cleanup reporting reports');
    } finally {
      setIsCleaningReporting(false);
    }
  };

  const handleCleanupAuditLog = async () => {
    if (!isAdmin) return;

    if (!(await confirm(`This will delete audit log entries older than ${config.auditLogRetentionDays} days. Continue?`))) {
      return;
    }

    setIsCleaningAuditLog(true);
    try {
      const response = await configApi.cleanupAuditLog();
      const deleted = response.data?.deleted ?? 0;
      setSuccess(`Cleaned up ${deleted} old audit log entries`);
    } catch (err) {
      setError('Failed to cleanup audit log');
    } finally {
      setIsCleaningAuditLog(false);
    }
  };
  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner className="text-robin-orange" />
      </div>
    );
  }

  const show = (...sections: ConfigSection[]) => sections.includes(section);
  const pageMeta = {
    security: {
      icon: appIcons.security,
      title: 'Security',
      subtitle: 'Browser session policy, login defenses, network trust boundaries, and emergency IP blocks.',
    },
    integration: {
      icon: appIcons.integration,
      title: 'Integrations',
      subtitle: 'Optional capabilities, service registry behavior, and shared integration defaults.',
    },
    reporting: {
      icon: appIcons.reporting,
      title: 'Reporting',
      subtitle: 'Report-backed workspaces, posture advisories, and raw evidence retention.',
    },
  }[section];

  const avatarDefaultsCard = show('integration') ? (
    <SectionCard
      title="Avatar defaults"
      description="Choose whether mailbox and admin avatars use Gravatar and what fallback style to show."
      icon={Globe}
    >
      <div className="space-y-4">
        <label className="flex items-center gap-3 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
          <input
            type="checkbox"
            id="gravatarEnabled"
            checked={config.gravatarEnabled}
            onChange={(e) => setConfig({ ...config, gravatarEnabled: e.target.checked })}
            disabled={!isAdmin}
            className="h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange"
          />
          <div>
            <div className="text-sm font-medium">Enable Gravatar avatars</div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Uses email hashes to load avatars from Gravatar when available.
            </p>
          </div>
        </label>

        <div>
          <label className="block text-sm font-medium mb-1">
            Default avatar style
          </label>
          <select
            value={config.gravatarDefault}
            onChange={(e) => setConfig({ ...config, gravatarDefault: e.target.value })}
            disabled={!isAdmin || !config.gravatarEnabled}
            className="input w-full"
          >
            {GRAVATAR_DEFAULTS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </SectionCard>
  ) : null;

  const capabilitySwitchesCard = show('integration') ? (
    <SectionCard
      title="Capability switches"
      description="Choose which optional workspaces are enabled."
      icon={Server}
    >
      <div className="space-y-4">
        {CAPABILITY_SWITCHES.map(({ key, label, description }) => (
          <label key={key} className="flex items-start gap-3 rounded-lg border border-gray-200 p-4 dark:border-robin-gray-700">
            <input
              type="checkbox"
              checked={config[key]}
              onChange={(e) => setConfig({ ...config, [key]: e.target.checked })}
              disabled={!isAdmin}
              aria-labelledby={`${key}-label`}
              aria-describedby={`${key}-description`}
              className="mt-1 h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange"
            />
            <div>
              <div id={`${key}-label`} className="text-sm font-medium">{label}</div>
              <p id={`${key}-description`} className="mt-1 text-xs text-gray-500 dark:text-gray-400">{description}</p>
            </div>
          </label>
        ))}
      </div>
    </SectionCard>
  ) : null;

  const robinSharedConfigCard = show('integration') ? (
    <SectionCard
      title="Robin config store"
      description="Select the existing PostgreSQL table that matches Robin's shared and per-instance JSON5 configuration store."
      icon={Database}
    >
      <div className="space-y-3">
        <Input
          label="Config-store table name"
          type="text"
          value={config.robinConfigTableName}
          onChange={(e) => setConfig({ ...config, robinConfigTableName: e.target.value })}
          placeholder="robin_config_store"
          pattern="[A-Za-z_][A-Za-z0-9_]*"
          maxLength={63}
          required
          disabled={!isAdmin}
        />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Defaults to <code>robin_config_store</code>. Enter an existing base table using letters, numbers, and underscores only (63 characters maximum). It must have the Robin config columns and a unique <code>(server_id, file_name)</code> key.
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Saving takes effect immediately in Robin Admin; Robin must already target the same table. No server restart or data migration is performed.
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          The <code>default</code> scope is the shared base, with <code>server_id</code> scopes for per-instance overrides. This setting does not control Fleet availability or navigation.
        </p>
      </div>
    </SectionCard>
  ) : null;

  const fleetOperationsCard = show('integration') ? (
    <SectionCard
      title="Fleet operations"
      description="Fleet history, service log views, and agent command policy."
      icon={Activity}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Input
          label="Metrics poll interval (ms)"
          type="number"
          min={5000}
          max={3600000}
          value={config.metricsPollIntervalMs}
          onChange={(e) => setConfig({ ...config, metricsPollIntervalMs: parseInt(e.target.value) || 60000 })}
          disabled={!isAdmin}
        />
        <Input
          label="Metrics retention (days)"
          type="number"
          min={1}
          max={3650}
          value={config.metricsRetentionDays}
          onChange={(e) => setConfig({ ...config, metricsRetentionDays: parseInt(e.target.value) || 14 })}
          disabled={!isAdmin}
        />
        <Input
          label="Default log lines"
          type="number"
          min={1}
          max={config.logMaxLines}
          value={config.logDefaultLines}
          onChange={(e) => setConfig({ ...config, logDefaultLines: parseInt(e.target.value) || 200 })}
          disabled={!isAdmin}
        />
        <Input
          label="Maximum log lines"
          type="number"
          min={config.logDefaultLines}
          max={10000}
          value={config.logMaxLines}
          onChange={(e) => setConfig({ ...config, logMaxLines: parseInt(e.target.value) || 1000 })}
          disabled={!isAdmin}
        />
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Metrics retention applies during pruning.
      </p>
      <OperationsPolicyFields section="fleet" policy={config} disabled={!isAdmin}
        onChange={(key, value) => setConfig({ ...config, [key]: value })} />
    </SectionCard>
  ) : null;

  const moduleRuntimeCard = show('integration') ? (
    <SectionCard
      title="Module runtime status"
      description="Review module registry and local runtime settings supplied by deployment configuration."
      icon={Package}
    >
      <ReadOnlyList
        items={[
          { label: 'Sheriff catalog', value: runtime?.sheriff.catalogBaseUrl ?? 'Unknown' },
          { label: 'Installer', value: runtime?.moduleInstaller.url ?? 'Unknown' },
          { label: 'Root key', value: <ConfiguredStatus configured={Boolean(runtime?.sheriff.rootPublicKeyConfigured)} /> },
          { label: 'Installer signing', value: <ConfiguredStatus configured={Boolean(runtime?.moduleInstaller.signingSecretConfigured)} /> },
        ]}
      />
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Read-only deployment status. Module proxy secrets are hidden; configured module credentials: {runtime?.moduleProxySecretModules.length ? runtime.moduleProxySecretModules.join(', ') : 'none'}.
      </p>
    </SectionCard>
  ) : null;

  const reportsIntegrationCard = show('reporting') ? (
    <SectionCard
      title="Posture checks"
      description="Select the current policy checks included in report analysis."
      icon={Globe}
      className="xl:col-span-2"
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-start gap-3 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
            <input
              type="checkbox"
              id="reportingMtaStsChecksEnabled"
              checked={config.reportingMtaStsChecksEnabled}
              onChange={(e) => setConfig({ ...config, reportingMtaStsChecksEnabled: e.target.checked })}
              disabled={!isAdmin}
              className="mt-1 h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange"
            />
            <div>
              <div className="text-sm font-medium">MTA-STS</div>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Include current MTA-STS policy checks in reporting posture analysis.</p>
            </div>
          </label>

          <label className="flex items-start gap-3 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
            <input
              type="checkbox"
              id="reportingTlsrptChecksEnabled"
              checked={config.reportingTlsrptChecksEnabled}
              onChange={(e) => setConfig({ ...config, reportingTlsrptChecksEnabled: e.target.checked })}
              disabled={!isAdmin}
              className="mt-1 h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange"
            />
            <div>
              <div className="text-sm font-medium">TLSRPT</div>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Include <code>_smtp._tls</code> publication checks in reporting posture analysis.</p>
            </div>
          </label>

          <label className="flex items-start gap-3 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
            <input
              type="checkbox"
              id="reportingDaneChecksEnabled"
              checked={config.reportingDaneChecksEnabled}
              onChange={(e) => setConfig({ ...config, reportingDaneChecksEnabled: e.target.checked })}
              disabled={!isAdmin}
              className="mt-1 h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange"
            />
            <div>
              <div className="text-sm font-medium">DANE</div>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Include MX TLSA checks in TLS reporting posture analysis.</p>
            </div>
          </label>

          <label className="flex items-start gap-3 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
            <input
              type="checkbox"
              id="reportingBimiChecksEnabled"
              checked={config.reportingBimiChecksEnabled}
              onChange={(e) => setConfig({ ...config, reportingBimiChecksEnabled: e.target.checked })}
              disabled={!isAdmin}
              className="mt-1 h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange"
            />
            <div>
              <div className="text-sm font-medium">BIMI</div>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Include BIMI record checks in reporting posture analysis.</p>
            </div>
          </label>
        </div>
      </div>
    </SectionCard>
  ) : null;

  const reportingWindowsCard = show('reporting') ? (
    <SectionCard
      title="Analysis windows"
      description="Control the default report window and analysis scheduling."
      icon={Activity}
      className="xl:col-span-2"
    >
      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-1">
        <Input label="Default window (days)" type="number" min={1} max={3650} value={config.reportingDefaultWindowDays} onChange={(e) => setConfig({ ...config, reportingDefaultWindowDays: parseInt(e.target.value) || 30 })} disabled={!isAdmin} />
        <Input label="Stale after (days)" type="number" min={1} max={3650} value={config.reportingStaleAfterDays} onChange={(e) => setConfig({ ...config, reportingStaleAfterDays: parseInt(e.target.value) || 7 })} disabled={!isAdmin} />
        <Input label="Analysis debounce (ms)" type="number" min={1000} max={300000} value={config.reportingAnalysisDebounceMs} onChange={(e) => setConfig({ ...config, reportingAnalysisDebounceMs: parseInt(e.target.value) || 10000 })} disabled={!isAdmin} />
        <Input label="Analyses at once" type="number" min={1} max={32} value={config.reportingAnalysisConcurrency} onChange={(e) => setConfig({ ...config, reportingAnalysisConcurrency: parseInt(e.target.value) || 4 })} disabled={!isAdmin} />
      </div>
    </SectionCard>
  ) : null;

  const reportingResourcesCard = show('reporting') ? (
    <SectionCard title="Read capacity" icon={Database}>
      <div className="grid gap-4 md:grid-cols-2">
        {([
          ['reportingCacheMiB', 'Cache budget (MiB)', 16, 1024],
          ['reportingCacheEntries', 'Cache entries', 10, 1000],
          ['reportingCacheTtlSeconds', 'Cache lifetime (seconds)', 5, 900],
          ['reportingSourceConcurrency', 'Concurrent source reads', 1, 8],
          ['reportingSourceQueueSize', 'Waiting source reads', 0, 128],
          ['reportingSourceQueueWaitMs', 'Queue wait (ms)', 1000, 120000],
        ] as const).map(([key, label, min, max]) => (
          <Input key={key} label={label} type="number" min={min} max={max} step={1}
            value={config[key]} onChange={e => setConfig({ ...config, [key]: Number(e.target.value) })} disabled={!isAdmin} />
        ))}
      </div>
    </SectionCard>
  ) : null;

  const sourceClassificationCard = show('reporting') ? (
    <SectionCard
      title="Source classification"
      description="Tune sender aggregate thresholds used to separate incidental failures from meaningful source risk."
      icon={Globe}
    >
      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-1">
        <Input label="Source failure rate" type="number" min={0.0001} max={1} step={0.0001} value={config.reportingNonCompliantRateThreshold} onChange={(e) => setConfig({ ...config, reportingNonCompliantRateThreshold: parseFloat(e.target.value) || 0.02 })} disabled={!isAdmin} />
        <Input label="Source failure minimum" type="number" min={1} max={10000000} value={config.reportingNonCompliantMinVolume} onChange={(e) => setConfig({ ...config, reportingNonCompliantMinVolume: parseInt(e.target.value) || 10 })} disabled={!isAdmin} />
        <Input label="Source absolute floor" type="number" min={1} max={10000000} value={config.reportingNonCompliantAbsoluteFloor} onChange={(e) => setConfig({ ...config, reportingNonCompliantAbsoluteFloor: parseInt(e.target.value) || 100 })} disabled={!isAdmin} />
      </div>
    </SectionCard>
  ) : null;

  const issueDetectionCard = show('reporting') ? (
    <SectionCard
      title="Issue detection"
      description="Tune volume, rate, persistence, and forensic clustering thresholds for reporting issues."
      icon={Activity}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Input label="Unknown sender minimum" type="number" min={1} max={10000000} value={config.detectionUnknownSenderMinVolume} onChange={(e) => setConfig({ ...config, detectionUnknownSenderMinVolume: parseInt(e.target.value) || 50 })} disabled={!isAdmin} />
        <Input label="Spoofing failure minimum" type="number" min={1} max={10000000} value={config.detectionSpoofingMinFailCount} onChange={(e) => setConfig({ ...config, detectionSpoofingMinFailCount: parseInt(e.target.value) || 100 })} disabled={!isAdmin} />
        <Input label="Misconfiguration volume" type="number" min={1} max={10000000} value={config.detectionMisconfiguredMinVolume} onChange={(e) => setConfig({ ...config, detectionMisconfiguredMinVolume: parseInt(e.target.value) || 1000 })} disabled={!isAdmin} />
        <Input label="DMARC failing pass rate" type="number" min={0} max={1} step={0.01} value={config.detectionDmarcFailingPassRate} onChange={(e) => setConfig({ ...config, detectionDmarcFailingPassRate: Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : 0.95 })} disabled={!isAdmin} />
        <Input label="TLS failure rate" type="number" min={0} max={1} step={0.01} value={config.detectionTlsFailureRate} onChange={(e) => setConfig({ ...config, detectionTlsFailureRate: Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : 0.1 })} disabled={!isAdmin} />
        <Input label="TLS failure minimum" type="number" min={1} max={10000000} value={config.detectionTlsMinFailures} onChange={(e) => setConfig({ ...config, detectionTlsMinFailures: parseInt(e.target.value) || 10 })} disabled={!isAdmin} />
        <Input label="Forensic spike multiplier" type="number" min={1} max={100} step={0.1} value={config.detectionForensicSpikeMultiplier} onChange={(e) => setConfig({ ...config, detectionForensicSpikeMultiplier: parseFloat(e.target.value) || 2 })} disabled={!isAdmin} />
        <Input label="Forensic spike minimum" type="number" min={1} max={10000000} value={config.detectionForensicSpikeMinRecent} onChange={(e) => setConfig({ ...config, detectionForensicSpikeMinRecent: parseInt(e.target.value) || 3 })} disabled={!isAdmin} />
        <Input label="Forensic cluster minimum" type="number" min={1} max={10000000} value={config.detectionForensicClusterMinOccurrences} onChange={(e) => setConfig({ ...config, detectionForensicClusterMinOccurrences: parseInt(e.target.value) || 2 })} disabled={!isAdmin} />
        <Input label="Forensic cluster issue limit" type="number" min={1} max={1000} value={config.detectionForensicClusterMaxIssues} onChange={(e) => setConfig({ ...config, detectionForensicClusterMaxIssues: parseInt(e.target.value) || 10 })} disabled={!isAdmin} />
        <Input label="Required runs" type="number" min={1} max={20} value={config.detectionRequiredRuns} onChange={(e) => setConfig({ ...config, detectionRequiredRuns: parseInt(e.target.value) || 2 })} disabled={!isAdmin} />
        <Input label="Grace runs" type="number" min={1} max={20} value={config.detectionGraceRuns} onChange={(e) => setConfig({ ...config, detectionGraceRuns: parseInt(e.target.value) || 2 })} disabled={!isAdmin} />
      </div>
    </SectionCard>
  ) : null;

  const dnsEnrichmentCard = show('reporting') ? (
    <SectionCard
      title="DNS enrichment"
      description="Control DNS lookups used for source identity, SPF expansion, and posture evidence."
      icon={Radio}
      className="xl:col-span-2"
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Input label="Identity TTL (days)" type="number" min={1} max={3650} value={config.sourceIdentityTtlDays} onChange={(e) => setConfig({ ...config, sourceIdentityTtlDays: parseInt(e.target.value) || 30 })} disabled={!isAdmin} />
        <Input label="Identity concurrency" type="number" min={1} max={100} value={config.sourceIdentityConcurrency} onChange={(e) => setConfig({ ...config, sourceIdentityConcurrency: parseInt(e.target.value) || 12 })} disabled={!isAdmin} />
        <Input label="DNS timeout (ms)" type="number" min={500} max={30000} value={config.sourceIdentityTimeoutMs} onChange={(e) => setConfig({ ...config, sourceIdentityTimeoutMs: parseInt(e.target.value) || 3000 })} disabled={!isAdmin} />
        <Input label="Sender DNS timeout (ms)" type="number" min={500} max={30000} value={config.senderEnrichmentDnsTimeoutMs} onChange={(e) => setConfig({ ...config, senderEnrichmentDnsTimeoutMs: parseInt(e.target.value) || 3000 })} disabled={!isAdmin} />
      </div>
      <div className="grid gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">DNS resolvers</label>
          <textarea className="input min-h-20 w-full" value={config.dnsResolvers} onChange={(e) => setConfig({ ...config, dnsResolvers: e.target.value })} disabled={!isAdmin} />
        </div>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Shared by source identity lookups and sender enrichment (PTR, SPF expansion). Entries must be IP addresses separated by commas or new lines.
      </p>
    </SectionCard>
  ) : null;

  const reportIngestionCard = show('reporting') ? (
    <SectionCard
      title="Report ingestion"
      description="Control how DMARC, TLSRPT, and Forensic bots submit raw evidence."
      icon={KeyRound}
      className="xl:col-span-2"
    >
      <div className="space-y-4">
        <OperationsPolicyFields section="reporting" policy={config} disabled={!isAdmin}
          onChange={(key, value) => setConfig({ ...config, [key]: value })} />
        <label className="flex items-center gap-3 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
          <input
            type="checkbox"
            checked={config.ingestionAuthRequired}
            onChange={(e) => setConfig({ ...config, ingestionAuthRequired: e.target.checked })}
            disabled={!isAdmin}
            className="h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange"
          />
          <div>
            <div className="text-sm font-medium">Require ingestion authentication outside trusted CIDRs</div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Trusted source CIDRs can post directly. Other sources need a scoped API key or shared secret.</p>
          </div>
        </label>
        <div>
          <label className="block text-sm font-medium mb-1">Trusted ingestion source CIDRs</label>
          <textarea
            className="input min-h-20 w-full"
            value={config.ingestionAllowedCidrs}
            onChange={(e) => setConfig({ ...config, ingestionAllowedCidrs: e.target.value })}
            placeholder={'127.0.0.0/8\n172.16.0.0/12'}
            disabled={!isAdmin}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Enter IPv4 or IPv6 addresses and CIDRs separated by commas or new lines. Matching sources can ingest without credentials.
          </p>
        </div>
        {isAdmin && (
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              label={`Shared secret ${config.ingestionSecretConfigured ? '(configured)' : '(not configured)'}`}
              type="password"
              value={ingestionSecret}
              onChange={(e) => setIngestionSecret(e.target.value)}
              placeholder="New shared secret"
              minLength={20}
            />
            <div className="flex items-end">
              <Button variant="secondary" onClick={handleRotateIngestionSecret} disabled={ingestionSecret.length < 20}>
                <RefreshCw className="w-4 h-4" />
                Rotate secret
              </Button>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 md:col-span-2">
              Use at least 20 characters. The current secret cannot be retrieved after it is saved.
            </p>
          </div>
        )}
      </div>
    </SectionCard>
  ) : null;

  const runtimeHardeningCard = section === 'security' ? (
    <SectionCard
      title="Runtime status"
      description="Review read-only deployment settings supplied by environment configuration."
      icon={ScrollText}
      className="xl:col-span-2"
    >
      <ReadOnlyList
        items={[
          { label: 'Environment', value: runtime?.nodeEnv ?? 'Unknown' },
          { label: 'Cookie domain', value: runtime?.cookieDomain ?? 'Unknown' },
          { label: 'Secure cookie', value: <StatusBadge tone={runtime?.cookieSecure ? 'success' : 'warning'}>{runtime?.cookieSecure ? 'Enabled' : 'Disabled'}</StatusBadge> },
          { label: 'Body limit', value: runtime?.bodyLimit ?? 'Unknown' },
          { label: 'API rate limit', value: runtime ? `${runtime.rateLimit.maxRequests} per ${formatDurationMs(runtime.rateLimit.windowMs)}` : 'Unknown' },
          { label: 'Login rate limit', value: runtime ? `${runtime.rateLimit.loginMaxRequests} per ${formatDurationMs(runtime.rateLimit.windowMs)}` : 'Unknown' },
          { label: 'Robin API', value: runtime?.robin.apiUrl ?? 'Unknown' },
          { label: 'Robin API auth', value: <ConfiguredStatus configured={Boolean(runtime?.robin.apiAuthConfigured)} /> },
          { label: 'PostgreSQL', value: runtime ? `${runtime.postgres.user}@${runtime.postgres.host}:${runtime.postgres.port}/${runtime.postgres.database}` : 'Unknown' },
        ]}
      />
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Read-only runtime status. Passwords, API credentials, session secrets, and encryption keys are never displayed.
      </p>
    </SectionCard>
  ) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={pageMeta.icon}
        title={pageMeta.title}
        description={pageMeta.subtitle}
        actions={isAdmin ? (
          <>
            <Button onClick={handleSave} isLoading={isSaving}>
              <Save className="w-4 h-4" />
              Save settings
            </Button>
            <Button variant="secondary" onClick={() => { void fetchConfig(); void modulePoliciesRef.current?.reset(); }}>
              <RefreshCw className="w-4 h-4" />
              Reset
            </Button>
          </>
        ) : undefined}
      />

      {error && <AdminNotice tone="error">{error}</AdminNotice>}

      {success && <AdminNotice tone="success">{success}</AdminNotice>}

      <MetricTabs tabs={tabsForSection(section)} activeTab={activeTab} onChange={setActiveTab} />

      {section === 'integration' && (
        <div className="grid gap-6 xl:grid-cols-2" data-testid="integration-cards">
          {activeTab === 'capabilities' && (
            <>
              <div className="min-w-0" data-testid="capability-switches-card">{capabilitySwitchesCard}</div>
              <div className="min-w-0" data-testid="fleet-operations-card">{fleetOperationsCard}</div>
            </>
          )}
          {activeTab === 'configStore' && <div className="min-w-0 xl:col-span-2" data-testid="robin-config-store-card">{robinSharedConfigCard}</div>}
          {activeTab === 'modules' && <div className="min-w-0 xl:col-span-2" data-testid="module-runtime-card">{moduleRuntimeCard}</div>}
          {activeTab === 'modules' && <div className="min-w-0 xl:col-span-2" data-testid="module-host-policy-card"><ModuleHostPolicies ref={modulePoliciesRef} disabled={!isAdmin} /></div>}
          {activeTab === 'avatars' && <div className="min-w-0 xl:col-span-2" data-testid="avatar-defaults-card">{avatarDefaultsCard}</div>}
        </div>
      )}

      {section !== 'integration' && (
      <div
        className="grid gap-6 xl:grid-cols-2"
        data-testid={section === 'reporting' ? 'reporting-cards' : section === 'security' ? 'security-cards' : undefined}
      >
        <div className={section === 'reporting' || section === 'security' ? 'contents' : 'space-y-6'}>
          {activeTab === 'workspaces' && reportsIntegrationCard}
          {activeTab === 'analysis' && reportingWindowsCard}
          {activeTab === 'analysis' && reportingResourcesCard}
          {activeTab === 'detection' && sourceClassificationCard}
          {activeTab === 'detection' && issueDetectionCard}
          {activeTab === 'dns' && dnsEnrichmentCard}

          {section === 'security' && activeTab === 'login' && (
          <SectionCard
            title="Session and login policy"
            description="Configure browser-session limits and persistent defenses against repeated login failures."
            icon={Shield}
            className="xl:col-span-2"
          >
            <div className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="flex items-center gap-3 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
                  <input
                    type="checkbox"
                    checked={config.loginProtectionEnabled}
                    onChange={(e) => setConfig({ ...config, loginProtectionEnabled: e.target.checked })}
                    disabled={!isAdmin}
                    className="h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange"
                  />
                  <div>
                    <div className="text-sm font-medium">Enable persistent brute-force protection</div>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Enforces PostgreSQL-backed account and IP locks across restarts.</p>
                  </div>
                </label>
                <label className="flex items-center gap-3 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
                  <input
                    type="checkbox"
                    checked={config.csrfProtectionEnabled}
                    onChange={(e) => setConfig({ ...config, csrfProtectionEnabled: e.target.checked })}
                    disabled={!isAdmin}
                    className="h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange"
                  />
                  <div>
                    <div className="text-sm font-medium">Require CSRF token for UI writes</div>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Applies to cookie-authenticated POST, PUT, PATCH, and DELETE requests; API-key requests are exempt.</p>
                  </div>
                </label>
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                <Input
                  label="Idle timeout (minutes)"
                  type="number"
                  min={5}
                  max={1440}
                  value={config.sessionTimeoutMinutes}
                  onChange={(e) => setConfig({ ...config, sessionTimeoutMinutes: parseInt(e.target.value) || 60 })}
                  disabled={!isAdmin}
                />
                <Input
                  label="Absolute lifetime (minutes)"
                  type="number"
                  min={config.sessionTimeoutMinutes}
                  max={10080}
                  value={config.sessionAbsoluteLifetimeMinutes}
                  onChange={(e) => setConfig({ ...config, sessionAbsoluteLifetimeMinutes: parseInt(e.target.value) || 1440 })}
                  disabled={!isAdmin}
                />
                <Input
                  label="Lockout duration (minutes)"
                  type="number"
                  min={5}
                  max={60}
                  value={config.loginLockoutMinutes}
                  onChange={(e) => setConfig({ ...config, loginLockoutMinutes: parseInt(e.target.value) || 15 })}
                  disabled={!isAdmin}
                />
                <Input
                  label="Account attempt cap"
                  type="number"
                  min={3}
                  max={10}
                  value={config.maxLoginAttempts}
                  onChange={(e) => setConfig({ ...config, maxLoginAttempts: parseInt(e.target.value) || 5 })}
                  disabled={!isAdmin}
                />
                <Input
                  label="Attempts per account"
                  type="number"
                  min={3}
                  max={50}
                  value={config.loginMaxAttemptsPerEmail}
                  onChange={(e) => setConfig({ ...config, loginMaxAttemptsPerEmail: parseInt(e.target.value) || 5 })}
                  disabled={!isAdmin}
                />
                <Input
                  label="Attempts per IP"
                  type="number"
                  min={3}
                  max={500}
                  value={config.loginMaxAttemptsPerIp}
                  onChange={(e) => setConfig({ ...config, loginMaxAttemptsPerIp: parseInt(e.target.value) || 20 })}
                  disabled={!isAdmin}
                />
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Idle timeout allows 5-1440 minutes. Absolute lifetime allows up to 10080 minutes and cannot be shorter than idle timeout. Lockout duration is 5-60 minutes and is also the failed-attempt counting window.
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Account locks use the per-account threshold. Network locks use the per-IP threshold.
              </p>
              {isAdmin && (
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
                  <Input
                    label="Account email (blank clears all login locks)"
                    value={clearLockEmail}
                    onChange={(e) => setClearLockEmail(e.target.value)}
                    placeholder="admin@example.com"
                  />
                  <div className="flex items-end">
                    <Button variant="secondary" onClick={handleClearLoginLocks}>
                      <Ban className="w-4 h-4" />
                      Clear login locks
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </SectionCard>
          )}

          {section === 'security' && activeTab === 'audit' && (
          <SectionCard
            title="Audit log retention"
            description="Permanently delete audit trail entries outside the retention window."
            icon={ScrollText}
            className="xl:col-span-2"
          >
            <div className="space-y-4">
              <Input
                label="Audit log retention (days)"
                type="number"
                min={0}
                max={3650}
                value={config.auditLogRetentionDays}
                onChange={(e) => setConfig({ ...config, auditLogRetentionDays: parseInt(e.target.value) || 0 })}
                disabled={!isAdmin}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Cleanup permanently deletes audit log entries older than this many days. Use 0 to keep entries indefinitely. The allowed range is 0 to 3650 days.
              </p>
              {isAdmin && (
                <Button
                  variant="danger"
                  onClick={handleCleanupAuditLog}
                  isLoading={isCleaningAuditLog}
                >
                  <Trash2 className="w-4 h-4" />
                  Cleanup old audit log entries
                </Button>
              )}
            </div>
          </SectionCard>
          )}

          {activeTab === 'ingestion' && reportIngestionCard}
        </div>

        <div className={section === 'reporting' || section === 'security' ? 'contents' : 'space-y-6'}>
          {show('reporting') && activeTab === 'retention' && (
          <SectionCard
            title="Raw report retention"
            description="Review storage usage and permanently delete raw reporting evidence outside the retention window."
            icon={Clock}
            className="xl:col-span-2"
          >
            <div className="space-y-4">
              {reportingUsage && (
                <div className="grid gap-3 md:grid-cols-3">
                  <AdminStat
                    label="DMARC reports"
                    value={reportingUsage.dmarc.reports.toLocaleString()}
                    description={`${reportingUsage.dmarc.records.toLocaleString()} records, ${formatBytes(reportingUsage.dmarc.storageBytes)} · ${formatDate(reportingUsage.dmarc.oldestReportDate)} - ${formatDate(reportingUsage.dmarc.newestReportDate)}`}
                  />
                  <AdminStat
                    label="TLSRPT reports"
                    value={reportingUsage.tlsrpt.reports.toLocaleString()}
                    description={`${reportingUsage.tlsrpt.policies.toLocaleString()} policies, ${reportingUsage.tlsrpt.failures.toLocaleString()} failures, ${formatBytes(reportingUsage.tlsrpt.storageBytes)} · ${formatDate(reportingUsage.tlsrpt.oldestReportDate)} - ${formatDate(reportingUsage.tlsrpt.newestReportDate)}`}
                  />
                  <AdminStat
                    label="Forensic reports"
                    value={reportingUsage.forensic.reports.toLocaleString()}
                    description={`Raw reports, ${formatBytes(reportingUsage.forensic.storageBytes)} · ${formatDate(reportingUsage.forensic.oldestReportDate)} - ${formatDate(reportingUsage.forensic.newestReportDate)}`}
                  />
                </div>
              )}

              <Input
                label="Report retention (days)"
                type="number"
                min={1}
                max={3650}
                value={config.reportingRetentionDays}
                onChange={(e) => setConfig({ ...config, reportingRetentionDays: parseInt(e.target.value) || 365 })}
                disabled={!isAdmin}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Cleanup permanently deletes DMARC, TLSRPT, and forensic reports older than this many days. The allowed range is 1 to 3650 days.
              </p>

              {isAdmin && (
                <Button
                  variant="danger"
                  onClick={handleCleanupReporting}
                  isLoading={isCleaningReporting}
                >
                  <Trash2 className="w-4 h-4" />
                  Cleanup old reports
                </Button>
              )}
            </div>
          </SectionCard>
          )}

          {section === 'security' && activeTab === 'runtime' && (
            runtimeHardeningCard
          )}

          {section === 'security' && activeTab === 'identity' && (
            <div className="xl:col-span-2" data-testid="module-identity-rotation-card">
              <ModuleIdentityRotation disabled={!isAdmin} />
            </div>
          )}

          {section === 'security' && activeTab === 'network' && (
          <SectionCard
            title="Network and service trust"
            description="Set inbound API boundaries, browser-origin policy, trusted proxies, and outbound Fleet URL policy."
            icon={Globe}
            className="xl:col-span-2"
          >
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium mb-1">Global IP allowlist</label>
                <textarea
                  className="input min-h-24 w-full"
                  value={config.globalIpAllowlist}
                  onChange={(e) => setConfig({ ...config, globalIpAllowlist: e.target.value })}
                  placeholder={'203.0.113.0/24\n2001:db8::/32'}
                  disabled={!isAdmin}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  IPv4/IPv6 addresses or CIDRs, separated by commas or new lines. When non-empty, every API request must match.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Allowed CORS origins</label>
                <textarea
                  className="input min-h-24 w-full"
                  value={config.allowedOrigins}
                  onChange={(e) => setConfig({ ...config, allowedOrigins: e.target.value })}
                  placeholder={'https://admin.example.com\nhttps://ops.example.com'}
                  disabled={!isAdmin}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Exact HTTP(S) browser origins, separated by commas or new lines. This controls CORS only; it is not an IP allowlist.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Trusted proxy CIDRs</label>
                <textarea
                  className="input min-h-24 w-full"
                  value={config.trustedProxyCidrs}
                  onChange={(e) => setConfig({ ...config, trustedProxyCidrs: e.target.value })}
                  placeholder="172.18.0.0/16"
                  disabled={!isAdmin}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Only direct peers in these CIDRs may supply the forwarded client IP used by allowlists, login protection, and audit records.
                </p>
              </div>
              <label className="flex items-start gap-3 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
                <input
                  type="checkbox"
                  checked={config.allowPrivateServiceUrls}
                  onChange={(e) => setConfig({ ...config, allowPrivateServiceUrls: e.target.checked })}
                  disabled={!isAdmin}
                  className="mt-1 h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange"
                />
                <div>
                  <div className="text-sm font-medium">Allow private fleet service URLs</div>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Allows outbound Fleet connectors to use literal private, loopback, link-local, or reserved IP URLs and localhost names. Hostname resolution still depends on server egress policy.</p>
                </div>
              </label>
            </div>
          </SectionCard>
          )}

          {section === 'security' && activeTab === 'jail' && (
          <SectionCard
            title="IP jail"
            description="Immediately block abusive IPs and CIDR ranges from every API route, before authentication and other allowlists."
            icon={Ban}
            className="xl:col-span-2"
          >
            <div className="space-y-4">
              <label className="flex items-center gap-3 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
                <input
                  type="checkbox"
                  checked={showInactiveJail}
                  onChange={(e) => setShowInactiveJail(e.target.checked)}
                  disabled={!isAdmin}
                  className="h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange"
                />
                <span className="text-sm font-medium">Show inactive (expired/lifted) entries</span>
              </label>
              <div className="grid gap-3 md:grid-cols-2">
                <Input label="IP or CIDR" value={newJail.cidr} onChange={(e) => setNewJail({ ...newJail, cidr: e.target.value })} placeholder="203.0.113.42 or 203.0.113.0/24" disabled={!isAdmin} />
                <Input label="Expires at, local time (blank = infinite)" type="datetime-local" value={newJail.expiresAt} onChange={(e) => setNewJail({ ...newJail, expiresAt: e.target.value })} disabled={!isAdmin} />
              </div>
              <Input label="Reason (optional)" value={newJail.reason} onChange={(e) => setNewJail({ ...newJail, reason: e.target.value })} placeholder="Credential stuffing attempts" disabled={!isAdmin} />
              <Button onClick={handleCreateJail} disabled={!isAdmin || !newJail.cidr.trim()}>
                <Ban className="w-4 h-4" />
                Add jail entry
              </Button>
              <div className="space-y-3">
                {ipJailEntries.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">No IP jail entries.</p>
                ) : (
                  ipJailEntries.map((entry) => (
                    <div key={entry.id} className="rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-medium break-all">{entry.cidr}</div>
                          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                            {entry.reason || 'No reason provided'} · created {new Date(entry.createdAt).toLocaleString()}
                          </div>
                          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                            {entry.liftedAt ? `Lifted ${new Date(entry.liftedAt).toLocaleString()}` : entry.expiresAt ? `Expires ${new Date(entry.expiresAt).toLocaleString()}` : 'Infinite jail'}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          {!entry.liftedAt && entry.expiresAt && (
                            <Button variant="secondary" onClick={() => handleSetInfinite(entry.id)}>Set infinite</Button>
                          )}
                          {!entry.liftedAt && (
                            <Button variant="danger" onClick={() => handleLiftJail(entry.id)}>Lift</Button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </SectionCard>
          )}

        </div>
      </div>
      )}
    </div>
  );
}
