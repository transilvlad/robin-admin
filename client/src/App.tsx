import { Suspense, lazy, useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { FeaturesProvider, capabilityAvailable, useFeatures } from './context/FeaturesContext';
import type { FleetServiceType } from './types';
import { ServiceProvider } from './context/ServiceContext';
import { ModulesProvider } from './context/ModulesContext';
import { ConfirmProvider } from './context/ConfirmContext';
import { Layout } from './components/layout/Layout';
import { MailboxBackendGate } from './components/layout/MailboxBackendGate';
import { Spinner } from './components/ui/Spinner';
import { ConfigPageView } from './pages/Config';
import { normalizeBasePath } from './utils/basePath';

const LoginPage = lazy(() => import('./pages/Login').then((m) => ({ default: m.LoginPage })));
const SetupPage = lazy(() => import('./pages/Setup').then((m) => ({ default: m.SetupPage })));
const ResetPasswordPage = lazy(() => import('./pages/ResetPassword').then((m) => ({ default: m.ResetPasswordPage })));
const DashboardPage = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.DashboardPage })));
const AlertSettingsPage = lazy(() => import('./pages/AlertSettings').then((m) => ({ default: m.AlertSettingsPage })));
const MonitoringPage = lazy(() => import('./pages/Monitoring').then((m) => ({ default: m.MonitoringPage })));
const ObservabilitySettingsPage = lazy(() => import('./pages/ObservabilitySettings').then((m) => ({ default: m.ObservabilitySettingsPage })));
const MonitoringEmailDeliveryPage = lazy(() => import('./pages/MonitoringEmailDelivery').then((m) => ({ default: m.MonitoringEmailDeliveryPage })));
const StatusPageAdmin = lazy(() => import('./pages/StatusPageAdmin').then((m) => ({ default: m.StatusPageAdmin })));
const TelemetryPage = lazy(() => import('./pages/Telemetry').then((m) => ({ default: m.TelemetryPage })));
const TelemetryExplorePage = lazy(() => import('./pages/TelemetryExplore').then((m) => ({ default: m.TelemetryExplorePage })));
const TelemetrySourcesPage = lazy(() => import('./pages/TelemetrySources').then((m) => ({ default: m.TelemetrySourcesPage })));
const StatusPagePublic = lazy(() => import('./pages/StatusPagePublic').then((m) => ({ default: m.StatusPagePublic })));
const EmailDeliveryPage = lazy(() => import('./pages/EmailDelivery').then((m) => ({ default: m.EmailDeliveryPage })));
const UsersPage = lazy(() => import('./pages/Users').then((m) => ({ default: m.UsersPage })));
const AliasesPage = lazy(() => import('./pages/Aliases').then((m) => ({ default: m.AliasesPage })));
const AutoAliasesPage = lazy(() => import('./pages/AutoAliases').then((m) => ({ default: m.AutoAliasesPage })));
const QueuePage = lazy(() => import('./pages/Queue').then((m) => ({ default: m.QueuePage })));
const AdminsPage = lazy(() => import('./pages/Admins').then((m) => ({ default: m.AdminsPage })));
const DmarcPage = lazy(() => import('./pages/Dmarc').then((m) => ({ default: m.DmarcPage })));
const TlsrptPage = lazy(() => import('./pages/Tlsrpt').then((m) => ({ default: m.TlsrptPage })));
const ForensicPage = lazy(() => import('./pages/Forensic').then((m) => ({ default: m.ForensicPage })));
const ProfilePage = lazy(() => import('./pages/Profile').then((m) => ({ default: m.ProfilePage })));
const RobinConfigPage = lazy(() => import('./pages/RobinConfigPage').then((m) => ({ default: m.RobinConfigPage })));
const ConfigDiffPage = lazy(() => import('./pages/ConfigDiffPage').then((m) => ({ default: m.ConfigDiffPage })));
const SendEmailPage = lazy(() => import('./pages/SendEmailPage').then((m) => ({ default: m.SendEmailPage })));
const MetricsPage = lazy(() => import('./pages/Metrics').then((m) => ({ default: m.MetricsPage })));
const FleetPage = lazy(() => import('./pages/Fleet').then((m) => ({ default: m.FleetPage })));
const AgentsPage = lazy(() => import('./pages/Agents').then((m) => ({ default: m.AgentsPage })));
const FleetDocsPage = lazy(() => import('./pages/FleetDocs').then((m) => ({ default: m.FleetDocsPage })));
const FleetMetricsPage = lazy(() => import('./pages/FleetMetrics').then((m) => ({ default: m.FleetMetricsPage })));
const ReportingOverviewPage = lazy(() => import('./pages/ReportingOverview'));
const SourcesPage = lazy(() => import('./pages/Sources'));
const ExplorerPage = lazy(() => import('./pages/Explorer'));
const DomainsPage = lazy(() => import('./pages/Domains'));
const DomainWorkspacePage = lazy(() => import('./pages/DomainWorkspace'));
const RspamdConfigPage = lazy(() => import('./pages/RspamdConfig').then((m) => ({ default: m.RspamdConfigPage })));
const RspamdRulesPage = lazy(() => import('./pages/RspamdRules').then((m) => ({ default: m.RspamdRulesPage })));
const RspamdDkimPage = lazy(() => import('./pages/RspamdDkim').then((m) => ({ default: m.RspamdDkimPage })));
const RspamdScanPage = lazy(() => import('./pages/RspamdScan').then((m) => ({ default: m.RspamdScanPage })));
const RspamdTrainingPage = lazy(() => import('./pages/RspamdTraining').then((m) => ({ default: m.RspamdTrainingPage })));
const RspamdMetricsPage = lazy(() => import('./pages/RspamdMetrics').then((m) => ({ default: m.RspamdMetricsPage })));
const ClamavConfigPage = lazy(() => import('./pages/ClamavConfig').then((m) => ({ default: m.ClamavConfigPage })));
const ClamavMetricsPage = lazy(() => import('./pages/ClamavMetrics').then((m) => ({ default: m.ClamavMetricsPage })));
const ClamavScanPage = lazy(() => import('./pages/ClamavScan').then((m) => ({ default: m.ClamavScanPage })));
const DovecotConfigPage = lazy(() => import('./pages/DovecotConfig').then((m) => ({ default: m.DovecotConfigPage })));
const DovecotMetricsPage = lazy(() => import('./pages/DovecotMetrics').then((m) => ({ default: m.DovecotMetricsPage })));
const PostfixConfigPage = lazy(() => import('./pages/PostfixConfig').then((m) => ({ default: m.PostfixConfigPage })));
const PostfixMetricsPage = lazy(() => import('./pages/PostfixMetrics').then((m) => ({ default: m.PostfixMetricsPage })));
const PostfixQueuePage = lazy(() => import('./pages/PostfixQueue').then((m) => ({ default: m.PostfixQueuePage })));
const RedisConfigPage = lazy(() => import('./pages/RedisConfig').then((m) => ({ default: m.RedisConfigPage })));
const RedisMetricsPage = lazy(() => import('./pages/RedisMetrics').then((m) => ({ default: m.RedisMetricsPage })));
const PostgresConfigPage = lazy(() => import('./pages/PostgresConfig').then((m) => ({ default: m.PostgresConfigPage })));
const PostgresMetricsPage = lazy(() => import('./pages/PostgresMetrics').then((m) => ({ default: m.PostgresMetricsPage })));
const MariadbConfigPage = lazy(() => import('./pages/MariadbConfig').then((m) => ({ default: m.MariadbConfigPage })));
const MariadbMetricsPage = lazy(() => import('./pages/MariadbMetrics').then((m) => ({ default: m.MariadbMetricsPage })));
const ServiceLogsPage = lazy(() => import('./pages/ServiceLogsPage').then((m) => ({ default: m.ServiceLogsPage })));
const ModulesPage = lazy(() => import('./pages/Modules').then((m) => ({ default: m.ModulesPage })));
const ModuleHostPage = lazy(() => import('./pages/ModuleHost').then((m) => ({ default: m.ModuleHostPage })));

function RouteFallback() {
  return (
    <div className="flex justify-center py-10">
      <Spinner className="text-robin-orange" />
    </div>
  );
}

function Suspended({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * Protected route wrapper that checks authentication.
 */
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-robin-gray-800">
        <Spinner className="text-robin-orange" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

/**
 * Admin-only route wrapper.
 */
function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  if (user?.role !== 'admin') {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

function FeatureRoute({
  enabled,
  requireAdmin = false,
  children,
}: {
  enabled: boolean;
  requireAdmin?: boolean;
  children: React.ReactNode;
}) {
  const { isLoading } = useFeatures();
  const { user } = useAuth();

  if (isLoading) {
    return <RouteFallback />;
  }

  if (!enabled) {
    return <Navigate to="/" replace />;
  }

  if (requireAdmin && user?.role !== 'admin') {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

function FleetRoute({ children, requireAdmin = false }: { children: React.ReactNode; requireAdmin?: boolean }) {
  const { features } = useFeatures();
  return (
    <FeatureRoute enabled={features.fleet} requireAdmin={requireAdmin}>
      {children}
    </FeatureRoute>
  );
}

function ServiceRoute({
  type,
  capability,
  requireAdmin = false,
  children,
}: {
  type: FleetServiceType;
  capability: string;
  requireAdmin?: boolean;
  children: React.ReactNode;
}) {
  const { features, capabilitiesSettled } = useFeatures();
  if (!features.capabilities && !capabilitiesSettled) {
    return <RouteFallback />;
  }
  return (
    <FeatureRoute enabled={features[type] && capabilityAvailable(features, type, capability)} requireAdmin={requireAdmin}>
      {children}
    </FeatureRoute>
  );
}

function ReportingRoute({ children }: { children: React.ReactNode }) {
  const { features } = useFeatures();
  return <FeatureRoute enabled={features.reporting}>{children}</FeatureRoute>;
}

function MailboxRoute({ section, children }: { section: 'users' | 'aliases' | 'autoAliases'; children: React.ReactNode }) {
  const { features } = useFeatures();
  return (
    <FeatureRoute enabled={features.mailboxes}>
      <MailboxBackendGate section={section}>{children}</MailboxBackendGate>
    </FeatureRoute>
  );
}

function MonitoringRoute({ children }: { children: React.ReactNode }) {
  const { features } = useFeatures();
  return <FeatureRoute enabled={features.monitoring} requireAdmin>{children}</FeatureRoute>;
}

function TelemetryRoute({ children }: { children: React.ReactNode }) {
  const { features } = useFeatures();
  return <FeatureRoute enabled={features.telemetry}>{children}</FeatureRoute>;
}

function ModulesRoute({ children }: { children: React.ReactNode }) {
  const { features } = useFeatures();
  return <FeatureRoute enabled={features.modules}>{children}</FeatureRoute>;
}

/**
 * Main application component with routing.
 */
// Vite injects BASE_URL based on the `--base` flag at build time. Strip the
// trailing slash so React Router treats `/admin/` and `/admin` consistently.
const BASE_PATH = normalizeBasePath(import.meta.env.BASE_URL).replace(/\/$/, '') || '/';

/**
 * A reverse proxy may route paths outside the base path (for example the site
 * root or /status when the UI lives under /admin) to this UI to publish the
 * status page there. Those paths render only the public status page.
 */
export function isOutsideBasePath(pathname: string, basePath = BASE_PATH): boolean {
  return basePath !== '/' && pathname !== basePath && !pathname.startsWith(`${basePath}/`);
}

// FeaturesProvider wraps AuthProvider, so its one-time mount refresh runs while
// still logged out — the admin-only logs-capabilities probe fails and the Logs
// nav items never appear until a manual reload. Re-run the features refresh once
// the user becomes authenticated so those probes run with the session.
const FEATURES_REFRESH_MS = 60_000;
// Focus and visibilitychange both fire on a tab switch; one refresh is enough.
const FEATURES_REFRESH_MIN_GAP_MS = 5_000;

function FeaturesAuthSync() {
  const { isAuthenticated } = useAuth();
  const { refresh } = useFeatures();
  const wasAuthed = useRef(false);
  useEffect(() => {
    if (isAuthenticated && !wasAuthed.current) {
      wasAuthed.current = true;
      void refresh();
    } else if (!isAuthenticated) {
      wasAuthed.current = false;
    }
  }, [isAuthenticated, refresh]);

  // Menu items gated on agent capabilities (Postfix Queue, Logs) reflect the
  // fleet at the last refresh, and agents connect and drop while the app is
  // open. Refresh when the window regains focus and every minute while visible.
  useEffect(() => {
    if (!isAuthenticated) return;
    let lastRefreshAt = Date.now();
    const refreshIfVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRefreshAt < FEATURES_REFRESH_MIN_GAP_MS) return;
      lastRefreshAt = Date.now();
      void refresh();
    };
    const interval = window.setInterval(refreshIfVisible, FEATURES_REFRESH_MS);
    window.addEventListener('focus', refreshIfVisible);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshIfVisible);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [isAuthenticated, refresh]);
  return null;
}

export function App() {
  if (isOutsideBasePath(window.location.pathname)) {
    return (
      <BrowserRouter>
        <Suspended><StatusPagePublic basePath="" /></Suspended>
      </BrowserRouter>
    );
  }
  return (
    <BrowserRouter basename={BASE_PATH}>
      <ThemeProvider>
        <FeaturesProvider>
          <AuthProvider>
            <FeaturesAuthSync />
            <ModulesProvider>
              <ServiceProvider>
                <ConfirmProvider>
                <Routes>
                {/* Public routes */}
                <Route path="/login" element={<Suspended><LoginPage /></Suspended>} />
                <Route path="/setup" element={<Suspended><SetupPage /></Suspended>} />
                <Route path="/reset-password" element={<Suspended><ResetPasswordPage /></Suspended>} />
                <Route path="/status/*" element={<Suspended><StatusPagePublic basePath="/status" /></Suspended>} />

                {/* Protected routes */}
                <Route
                  path="/"
                  element={
                    <ProtectedRoute>
                      <Layout />
                    </ProtectedRoute>
                  }
                >
                  <Route index element={<Suspended><DashboardPage /></Suspended>} />
                  <Route path="users" element={<MailboxRoute section="users"><Suspended><UsersPage /></Suspended></MailboxRoute>} />
                  <Route path="aliases" element={<MailboxRoute section="aliases"><Suspended><AliasesPage /></Suspended></MailboxRoute>} />
                  <Route path="auto-aliases" element={<MailboxRoute section="autoAliases"><Suspended><AutoAliasesPage /></Suspended></MailboxRoute>} />
                  <Route path="robin/queue" element={<ServiceRoute type="robin" capability="queue"><Suspended><QueuePage /></Suspended></ServiceRoute>} />
                  <Route path="robin/config" element={<ServiceRoute type="robin" capability="config" requireAdmin><Suspended><RobinConfigPage /></Suspended></ServiceRoute>} />
                  <Route path="robin/config/diff" element={<ServiceRoute type="robin" capability="config" requireAdmin><Suspended><ConfigDiffPage /></Suspended></ServiceRoute>} />
                  <Route path="robin/delivery-test" element={<ServiceRoute type="robin" capability="deliveryTest"><Suspended><SendEmailPage /></Suspended></ServiceRoute>} />
                  <Route path="robin/metrics" element={<ServiceRoute type="robin" capability="metrics"><Suspended><MetricsPage /></Suspended></ServiceRoute>} />
                  <Route path="robin/logs" element={<ServiceRoute type="robin" capability="logs" requireAdmin><Suspended><ServiceLogsPage serviceType="robin" /></Suspended></ServiceRoute>} />
                  <Route path="fleet" element={<FleetRoute requireAdmin><Suspended><FleetPage /></Suspended></FleetRoute>} />
                  <Route path="fleet/agents" element={<FleetRoute requireAdmin><Suspended><AgentsPage /></Suspended></FleetRoute>} />
                  <Route path="fleet/docs" element={<FleetRoute requireAdmin><Suspended><FleetDocsPage /></Suspended></FleetRoute>} />
                  <Route path="fleet/metrics" element={<FleetRoute><Suspended><FleetMetricsPage /></Suspended></FleetRoute>} />
                  <Route path="monitoring" element={<MonitoringRoute><Suspended><MonitoringPage /></Suspended></MonitoringRoute>} />
                  <Route path="monitoring/email-delivery" element={<MonitoringRoute><Suspended><MonitoringEmailDeliveryPage /></Suspended></MonitoringRoute>} />
                  <Route path="status-page" element={<MonitoringRoute><Suspended><StatusPageAdmin /></Suspended></MonitoringRoute>} />
                  <Route path="telemetry" element={<TelemetryRoute><Suspended><TelemetryPage /></Suspended></TelemetryRoute>} />
                  <Route path="telemetry/explore" element={<TelemetryRoute><Suspended><TelemetryExplorePage /></Suspended></TelemetryRoute>} />
                  <Route path="telemetry/sources" element={<TelemetryRoute><Suspended><TelemetrySourcesPage /></Suspended></TelemetryRoute>} />
                  <Route path="dmarc" element={<ReportingRoute><Suspended><DmarcPage /></Suspended></ReportingRoute>} />
                  <Route path="tlsrpt" element={<ReportingRoute><Suspended><TlsrptPage /></Suspended></ReportingRoute>} />
                  <Route path="forensic" element={<ReportingRoute><Suspended><ForensicPage /></Suspended></ReportingRoute>} />
                  <Route path="reporting" element={<ReportingRoute><Suspended><ReportingOverviewPage /></Suspended></ReportingRoute>} />
                  <Route path="reporting/sources" element={<ReportingRoute><Suspended><SourcesPage /></Suspended></ReportingRoute>} />
                  <Route path="reporting/explorer" element={<ReportingRoute><Suspended><ExplorerPage /></Suspended></ReportingRoute>} />
                  <Route path="reporting/domains" element={<ReportingRoute><Suspended><DomainsPage /></Suspended></ReportingRoute>} />
                  <Route path="reporting/domains/:domain" element={<ReportingRoute><Suspended><DomainWorkspacePage /></Suspended></ReportingRoute>} />
                  <Route path="profile" element={<Suspended><ProfilePage /></Suspended>} />
                  <Route path="rspamd/config" element={<ServiceRoute type="rspamd" capability="config" requireAdmin><Suspended><RspamdConfigPage /></Suspended></ServiceRoute>} />
                  <Route path="rspamd/rules" element={<ServiceRoute type="rspamd" capability="rules" requireAdmin><Suspended><RspamdRulesPage /></Suspended></ServiceRoute>} />
                  <Route path="rspamd/dkim" element={<ServiceRoute type="rspamd" capability="dkim" requireAdmin><Suspended><RspamdDkimPage /></Suspended></ServiceRoute>} />
                  <Route path="rspamd/scan" element={<ServiceRoute type="rspamd" capability="scan" requireAdmin><Suspended><RspamdScanPage /></Suspended></ServiceRoute>} />
                  <Route path="rspamd/training" element={<ServiceRoute type="rspamd" capability="training" requireAdmin><Suspended><RspamdTrainingPage /></Suspended></ServiceRoute>} />
                  <Route path="rspamd/metrics" element={<ServiceRoute type="rspamd" capability="metrics"><Suspended><RspamdMetricsPage /></Suspended></ServiceRoute>} />
                  <Route path="clamav/config" element={<ServiceRoute type="clamav" capability="config" requireAdmin><Suspended><ClamavConfigPage /></Suspended></ServiceRoute>} />
                  <Route path="clamav/metrics" element={<ServiceRoute type="clamav" capability="metrics"><Suspended><ClamavMetricsPage /></Suspended></ServiceRoute>} />
                  <Route path="clamav/scan" element={<ServiceRoute type="clamav" capability="scan" requireAdmin><Suspended><ClamavScanPage /></Suspended></ServiceRoute>} />
                  <Route path="dovecot/config" element={<ServiceRoute type="dovecot" capability="config" requireAdmin><Suspended><DovecotConfigPage /></Suspended></ServiceRoute>} />
                  <Route path="dovecot/metrics" element={<ServiceRoute type="dovecot" capability="metrics"><Suspended><DovecotMetricsPage /></Suspended></ServiceRoute>} />
                  <Route path="postfix/config" element={<ServiceRoute type="postfix" capability="config" requireAdmin><Suspended><PostfixConfigPage /></Suspended></ServiceRoute>} />
                  <Route path="postfix/queue" element={<ServiceRoute type="postfix" capability="postfixQueue" requireAdmin><Suspended><PostfixQueuePage /></Suspended></ServiceRoute>} />
                  <Route path="postfix/metrics" element={<ServiceRoute type="postfix" capability="metrics"><Suspended><PostfixMetricsPage /></Suspended></ServiceRoute>} />
                  <Route path="redis/config" element={<ServiceRoute type="redis" capability="config" requireAdmin><Suspended><RedisConfigPage /></Suspended></ServiceRoute>} />
                  <Route path="redis/metrics" element={<ServiceRoute type="redis" capability="metrics"><Suspended><RedisMetricsPage /></Suspended></ServiceRoute>} />
                  <Route path="postgres/config" element={<ServiceRoute type="postgres" capability="config" requireAdmin><Suspended><PostgresConfigPage /></Suspended></ServiceRoute>} />
                  <Route path="postgres/metrics" element={<ServiceRoute type="postgres" capability="metrics"><Suspended><PostgresMetricsPage /></Suspended></ServiceRoute>} />
                  <Route path="mariadb/config" element={<ServiceRoute type="mariadb" capability="config" requireAdmin><Suspended><MariadbConfigPage /></Suspended></ServiceRoute>} />
                  <Route path="mariadb/metrics" element={<ServiceRoute type="mariadb" capability="metrics"><Suspended><MariadbMetricsPage /></Suspended></ServiceRoute>} />
                  <Route path="rspamd/logs" element={<ServiceRoute type="rspamd" capability="logs" requireAdmin><Suspended><ServiceLogsPage serviceType="rspamd" /></Suspended></ServiceRoute>} />
                  <Route path="clamav/logs" element={<ServiceRoute type="clamav" capability="logs" requireAdmin><Suspended><ServiceLogsPage serviceType="clamav" /></Suspended></ServiceRoute>} />
                  <Route path="dovecot/logs" element={<ServiceRoute type="dovecot" capability="logs" requireAdmin><Suspended><ServiceLogsPage serviceType="dovecot" /></Suspended></ServiceRoute>} />
                  <Route path="postfix/logs" element={<ServiceRoute type="postfix" capability="logs" requireAdmin><Suspended><ServiceLogsPage serviceType="postfix" /></Suspended></ServiceRoute>} />
                  <Route path="redis/logs" element={<ServiceRoute type="redis" capability="logs" requireAdmin><Suspended><ServiceLogsPage serviceType="redis" /></Suspended></ServiceRoute>} />
                  <Route path="postgres/logs" element={<ServiceRoute type="postgres" capability="logs" requireAdmin><Suspended><ServiceLogsPage serviceType="postgres" /></Suspended></ServiceRoute>} />
                  <Route path="mariadb/logs" element={<ServiceRoute type="mariadb" capability="logs" requireAdmin><Suspended><ServiceLogsPage serviceType="mariadb" /></Suspended></ServiceRoute>} />
                  <Route path="modules" element={<ModulesRoute><Suspended><ModulesPage /></Suspended></ModulesRoute>} />
                  <Route path="modules/:slug/*" element={<ModulesRoute><Suspended><ModuleHostPage /></Suspended></ModulesRoute>} />
                  <Route path="administration/security" element={<ConfigPageView section="security" />} />
                  <Route path="administration/integration" element={<ConfigPageView section="integration" />} />
                  <Route path="administration/reporting" element={<ConfigPageView section="reporting" />} />
                  <Route path="administration/telemetry" element={<AdminRoute><Suspended><ObservabilitySettingsPage section="telemetry" /></Suspended></AdminRoute>} />
                  <Route path="administration/monitoring" element={<AdminRoute><Suspended><ObservabilitySettingsPage section="monitoring" /></Suspended></AdminRoute>} />
                  <Route path="administration/email" element={
                    <AdminRoute>
                      <Suspended><EmailDeliveryPage /></Suspended>
                    </AdminRoute>
                  } />
                  <Route path="administration/alerts" element={
                    <AdminRoute>
                      <Suspended><AlertSettingsPage /></Suspended>
                    </AdminRoute>
                  } />
                  <Route path="administration/access" element={
                    <AdminRoute>
                      <Suspended><AdminsPage /></Suspended>
                    </AdminRoute>
                  } />
                </Route>

                {/* Fallback */}
                <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
                </ConfirmProvider>
              </ServiceProvider>
            </ModulesProvider>
          </AuthProvider>
        </FeaturesProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
