import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChartLine,
  CheckCircle,
  Circle,
  Cylinder,
  DatabaseZap,
  Inbox,
  Mail,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Server,
  Settings2,
  ShieldAlert,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react';
import { ApiError, fleetServicesApi } from '../api/client';
import { Button } from '../components/ui/Button';
import { FleetSyncPanel } from '../components/fleet/FleetSyncPanel';
import { RspamdServiceSettings } from '../components/fleet/RspamdServiceSettings';
import { Modal } from '../components/ui/Modal';
import { useConfirm } from '../context/ConfirmContext';
import { MetricCard } from '../components/ui/MetricCard';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import { getServiceTypeMeta } from '../constants/serviceTypes';
import { useAuth } from '../context/AuthContext';
import { useFeatures } from '../context/FeaturesContext';
import { useServices } from '../context/ServiceContext';
import type { FleetService, FleetServiceType } from '../types';

type ServiceFilter = 'all' | FleetServiceType;

interface ServiceFormData {
  serviceId: string;
  serviceType: FleetServiceType;
  name: string;
  description: string;
  apiUrl: string;
  metricsUrl: string;
  controllerUrl: string;
  normalUrl: string;
  telemetrySource: string;
  enabled: boolean;
}

const EMPTY_FORM: ServiceFormData = {
  serviceId: '',
  serviceType: 'robin',
  name: '',
  description: '',
  apiUrl: '',
  metricsUrl: '',
  controllerUrl: '',
  normalUrl: '',
  telemetrySource: '',
  enabled: true,
};

export function FleetPage() {
  const confirm = useConfirm();
  const { user } = useAuth();
  const { refreshServices } = useServices();
  const { features, refresh: refreshFeatures } = useFeatures();
  // Config sync shows only where an agent can deliver this service's config files.
  const canSyncConfig = (service: FleetService) => Boolean(
    features.capabilities?.services.find((entry) => entry.serviceId === service.serviceId)?.features.configSync?.available,
  );
  const [services, setServices] = useState<FleetService[]>([]);
  const [healthStatus, setHealthStatus] = useState<Record<string, boolean | null>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingService, setEditingService] = useState<FleetService | null>(null);
  const [syncService, setSyncService] = useState<FleetService | null>(null);
  const [formData, setFormData] = useState<ServiceFormData>(EMPTY_FORM);
  const [filter, setFilter] = useState<ServiceFilter>('all');
  const [search, setSearch] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  const isAdmin = user?.role === 'admin';

  const loadServices = useCallback(async (showRefreshing = false) => {
    if (showRefreshing) {
      setIsRefreshing(true);
    }

    try {
      const response = await fleetServicesApi.list();
      setServices(response.data ?? []);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load fleet services');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  const checkAllHealth = useCallback(async () => {
    const nextHealth: Record<string, boolean | null> = {};
    await Promise.all(services.map(async (service) => {
      try {
        const response = await fleetServicesApi.health(service.serviceId);
        nextHealth[String(service.id)] = response.data?.healthy ?? false;
      } catch {
        nextHealth[String(service.id)] = false;
      }
    }));
    setHealthStatus(nextHealth);
  }, [services]);

  useEffect(() => {
    void loadServices();
  }, [loadServices]);

  useEffect(() => {
    if (services.length > 0) {
      void checkAllHealth();
    } else {
      setHealthStatus({});
    }
  }, [checkAllHealth, services]);

  const filteredServices = useMemo(() => (
    services.filter((service) => {
      const matchesType = filter === 'all' || service.serviceType === filter;
      const normalizedSearch = search.trim().toLowerCase();
      const matchesSearch = normalizedSearch.length === 0
        || service.name.toLowerCase().includes(normalizedSearch)
        || service.serviceId.toLowerCase().includes(normalizedSearch)
        || (service.description ?? '').toLowerCase().includes(normalizedSearch);
      return matchesType && matchesSearch;
    })
  ), [filter, search, services]);

  const summary = useMemo(() => ({
    total: services.length,
    robin: services.filter((service) => service.serviceType === 'robin').length,
    rspamd: services.filter((service) => service.serviceType === 'rspamd').length,
    clamav: services.filter((service) => service.serviceType === 'clamav').length,
    cyrus: services.filter((service) => service.serviceType === 'cyrus').length,
    dovecot: services.filter((service) => service.serviceType === 'dovecot').length,
    postfix: services.filter((service) => service.serviceType === 'postfix').length,
    redis: services.filter((service) => service.serviceType === 'redis').length,
    postgres: services.filter((service) => service.serviceType === 'postgres').length,
    mariadb: services.filter((service) => service.serviceType === 'mariadb').length,
    healthy: services.filter((service) => healthStatus[String(service.id)]).length,
  }), [healthStatus, services]);

  const openCreateModal = () => {
    setEditingService(null);
    setFormData(EMPTY_FORM);
    setError('');
    setShowModal(true);
  };

  const openEditModal = (service: FleetService) => {
    setEditingService(service);
    setFormData({
      serviceId: service.serviceId,
      serviceType: service.serviceType,
        name: service.name,
        description: service.description ?? '',
        apiUrl: service.apiUrl ?? '',
        metricsUrl: service.metricsUrl ?? '',
        controllerUrl: service.controllerUrl ?? '',
        normalUrl: service.normalUrl ?? '',
        telemetrySource: service.telemetrySource ?? '',
        enabled: service.enabled,
      });
    setError('');
    setShowModal(true);
  };

  const handleDelete = async (service: FleetService) => {
    if (!(await confirm(`Delete ${service.serviceType} service "${service.name}"? This cannot be undone.`))) {
      return;
    }

    try {
      await fleetServicesApi.delete(service.serviceId);
      await Promise.all([loadServices(), refreshServices(), refreshFeatures()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete service');
    }
  };

  const handleToggleEnabled = async (service: FleetService) => {
    try {
      await fleetServicesApi.update(service.serviceId, { enabled: !service.enabled });
      await Promise.all([loadServices(), refreshServices(), refreshFeatures()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update service');
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    setError('');

    const apiUrl = formData.serviceType === 'rspamd' ? formData.normalUrl : formData.apiUrl;
    const metricsUrl = formData.serviceType === 'rspamd' ? formData.controllerUrl : formData.metricsUrl;

      try {
        if (editingService) {
          await fleetServicesApi.update(editingService.serviceId, {
            serviceId: formData.serviceId,
            name: formData.name,
            description: formData.description || null,
            apiUrl: apiUrl || null,
          healthUrl: null,
          metricsUrl: metricsUrl || null,
          controllerUrl: formData.serviceType === 'rspamd' ? formData.controllerUrl || null : null,
          normalUrl: formData.serviceType === 'rspamd' ? formData.normalUrl || null : null,
          telemetrySource: formData.telemetrySource.trim() || null,
          enabled: formData.enabled,
        });
      } else {
        await fleetServicesApi.create({
          serviceId: formData.serviceId,
          serviceType: formData.serviceType,
          name: formData.name,
          description: formData.description || undefined,
          apiUrl,
          metricsUrl: metricsUrl || undefined,
          controllerUrl: formData.serviceType === 'rspamd' ? formData.controllerUrl || undefined : undefined,
          normalUrl: formData.serviceType === 'rspamd' ? formData.normalUrl || undefined : undefined,
          telemetrySource: formData.telemetrySource.trim() || undefined,
          enabled: formData.enabled,
        });
      }

      setShowModal(false);
      await Promise.all([loadServices(), refreshServices(), refreshFeatures()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save service');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner className="text-robin-orange" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
        <PageHeader
          icon={appIcons.fleetInstances}
          title="Fleet services"
        description="Manage Robin, Rspamd, ClamAV, Dovecot, Cyrus IMAP, Postfix, Redis, PostgreSQL, and MariaDB services from one registry. Navigation and page selectors follow the enabled fleet services here."
          actions={(
          <>
            <Button variant="secondary" onClick={() => void checkAllHealth()}>
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              Check health
            </Button>
            {isAdmin && (
              <Button onClick={openCreateModal}>
                <Plus className="h-4 w-4" />
                Add service
              </Button>
            )}
          </>
        )}
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5 2xl:grid-cols-10">
        <MetricCard icon={<Server className="h-5 w-5" />} label="Total services" value={String(summary.total)} />
        <MetricCard icon={<Settings2 className="h-5 w-5" />} label="Robin services" value={String(summary.robin)} />
        <MetricCard icon={<ShieldAlert className="h-5 w-5" />} label="Rspamd services" value={String(summary.rspamd)} />
        <MetricCard icon={<Server className="h-5 w-5" />} label="ClamAV services" value={String(summary.clamav)} />
        <MetricCard icon={<Inbox className="h-5 w-5" />} label="Cyrus IMAP services" value={String(summary.cyrus)} />
        <MetricCard icon={<Inbox className="h-5 w-5" />} label="Dovecot services" value={String(summary.dovecot)} />
        <MetricCard icon={<Mail className="h-5 w-5" />} label="Postfix services" value={String(summary.postfix)} />
        <MetricCard icon={<Zap className="h-5 w-5" />} label="Redis services" value={String(summary.redis)} />
        <MetricCard icon={<Cylinder className="h-5 w-5" />} label="Postgres services" value={String(summary.postgres)} />
        <MetricCard icon={<DatabaseZap className="h-5 w-5" />} label="MariaDB services" value={String(summary.mariadb)} />
        <MetricCard icon={<CheckCircle className="h-5 w-5" />} label="Healthy services" value={String(summary.healthy)} />
      </div>

      <div className="card p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap gap-2">
            {([
              ['all', 'All services'],
              ['robin', 'Robin'],
              ['rspamd', 'Rspamd'],
              ['clamav', 'ClamAV'],
              ['dovecot', 'Dovecot'],
              ['cyrus', 'Cyrus IMAP'],
              ['postfix', 'Postfix'],
              ['redis', 'Redis'],
              ['postgres', 'PostgreSQL'],
              ['mariadb', 'MariaDB'],
            ] as Array<[ServiceFilter, string]>).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  filter === value
                    ? 'bg-robin-orange text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-robin-gray-800 dark:text-gray-200 dark:hover:bg-robin-gray-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name, id, or description"
            className="input w-full xl:max-w-sm"
          />
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
            {error}
          </div>
        )}

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Health</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Service</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Endpoints</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Enabled</th>
                {isAdmin && <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {filteredServices.map((service) => {
                const healthy = healthStatus[String(service.id)];
                return (
                  <tr key={service.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                    <td className="px-4 py-3">
                      {healthy === undefined || healthy === null ? (
                        <Circle className="h-5 w-5 text-gray-400" />
                      ) : healthy ? (
                        <CheckCircle className="h-5 w-5 text-green-500" />
                      ) : (
                        <XCircle className="h-5 w-5 text-red-500" />
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 dark:text-white">{service.name}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                        <span className="font-mono">{service.serviceId}</span>
                        <span className={`rounded-full px-2 py-0.5 font-medium ${getServiceTypeMeta(service.serviceType).badgeClass}`}>
                          {service.serviceType}
                        </span>
                      </div>
                      {service.description && (
                        <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">{service.description}</div>
                      )}
                      {features.telemetry && service.telemetrySource && (
                        <Link
                          to={`/telemetry/explore?source=${encodeURIComponent(service.telemetrySource)}`}
                          className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-robin-orange hover:underline"
                        >
                          <ChartLine aria-hidden="true" className="h-3.5 w-3.5" />
                          Metrics
                        </Link>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {getVisibleEndpoints(service).map((endpoint) => (
                        <EndpointLine key={endpoint.label} label={endpoint.label} value={endpoint.value} />
                      ))}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => isAdmin && void handleToggleEnabled(service)}
                        disabled={!isAdmin}
                        className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium ${
                          service.enabled
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
                        } ${isAdmin ? 'hover:opacity-80' : 'cursor-default'}`}
                      >
                        {service.enabled ? <Power className="h-3 w-3" /> : <PowerOff className="h-3 w-3" />}
                        {service.enabled ? 'Enabled' : 'Disabled'}
                      </button>
                    </td>
                    {isAdmin && (
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-2">
                          {canSyncConfig(service) && (
                            <Button size="sm" variant="secondary" onClick={() => setSyncService(service)}>
                              <RefreshCw className="h-4 w-4" />
                              Config sync
                            </Button>
                          )}
                          <Button size="sm" variant="secondary" onClick={() => openEditModal(service)}>
                            Edit
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => void handleDelete(service)}>
                            <Trash2 className="h-4 w-4" />
                            Delete
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}

              {filteredServices.length === 0 && (
                <tr>
                  <td colSpan={isAdmin ? 5 : 4} className="px-4 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                    No services match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        isOpen={syncService !== null}
        onClose={() => setSyncService(null)}
        title={`Config sync — ${syncService?.name ?? ''}`}
        size="xl"
      >
        {syncService && <FleetSyncPanel serviceId={syncService.serviceId} />}
      </Modal>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white shadow-xl dark:bg-gray-900">
            <div className="border-b border-gray-200 px-6 py-4 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                {editingService ? 'Edit fleet service' : 'Add fleet service'}
              </h2>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4 p-6">
              <div className="grid gap-4 md:grid-cols-2">
                {!editingService ? (
                  <label className="space-y-1 text-sm">
                    <span className="block font-medium text-gray-700 dark:text-gray-300">Service type</span>
                    <select
                      value={formData.serviceType}
                      onChange={(event) => setFormData((current) => ({
                        ...current,
                        serviceType: event.target.value as FleetServiceType,
                      }))}
                      className="input"
                      required
                    >
                      <option value="robin">Robin</option>
                      <option value="rspamd">Rspamd</option>
                      <option value="clamav">ClamAV</option>
                      <option value="dovecot">Dovecot</option>
                      <option value="cyrus">Cyrus IMAP</option>
                      <option value="postfix">Postfix</option>
                      <option value="redis">Redis</option>
                      <option value="postgres">PostgreSQL</option>
                      <option value="mariadb">MariaDB / MySQL</option>
                    </select>
                  </label>
                ) : (
                  <div className="space-y-1 text-sm">
                    <span className="block font-medium text-gray-700 dark:text-gray-300">Service type</span>
                    <div className="input flex items-center bg-gray-50 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300">
                      {formData.serviceType}
                    </div>
                  </div>
                )}

                <label className="space-y-1 text-sm">
                  <span className="block font-medium text-gray-700 dark:text-gray-300">Service ID</span>
                  <input
                    type="text"
                    value={formData.serviceId}
                    onChange={(event) => setFormData((current) => ({ ...current, serviceId: event.target.value }))}
                    className="input"
                    pattern="[a-zA-Z0-9_-]+"
                    placeholder={formData.serviceType === 'rspamd' ? 'rspamd-eu-1' : formData.serviceType === 'clamav' ? 'clamav-primary' : formData.serviceType === 'cyrus' ? 'cyrus-primary' : formData.serviceType === 'dovecot' ? 'dovecot-primary' : formData.serviceType === 'postfix' ? 'postfix-primary' : formData.serviceType === 'redis' ? 'redis-primary' : formData.serviceType === 'postgres' ? 'postgres-primary' : formData.serviceType === 'mariadb' ? 'mariadb-primary' : 'robin-primary'}
                    required
                  />
                </label>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-1 text-sm">
                  <span className="block font-medium text-gray-700 dark:text-gray-300">Name</span>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(event) => setFormData((current) => ({ ...current, name: event.target.value }))}
                    className="input"
                    placeholder={formData.serviceType === 'rspamd' ? 'Primary Rspamd' : formData.serviceType === 'clamav' ? 'Primary ClamAV' : formData.serviceType === 'cyrus' ? 'Primary Cyrus IMAP' : formData.serviceType === 'dovecot' ? 'Primary Dovecot' : formData.serviceType === 'postfix' ? 'Primary Postfix' : formData.serviceType === 'redis' ? 'Primary Redis' : formData.serviceType === 'postgres' ? 'Primary PostgreSQL' : formData.serviceType === 'mariadb' ? 'Primary MariaDB' : 'Primary Robin'}
                    required
                  />
                </label>

                <label className="space-y-1 text-sm">
                  <span className="block font-medium text-gray-700 dark:text-gray-300">Description</span>
                  <input
                    type="text"
                    value={formData.description}
                    onChange={(event) => setFormData((current) => ({ ...current, description: event.target.value }))}
                    className="input"
                    placeholder="Optional operator note"
                  />
                </label>

                {formData.serviceType === 'dovecot' || formData.serviceType === 'postfix' || formData.serviceType === 'redis' || formData.serviceType === 'postgres' || formData.serviceType === 'mariadb' ? (
                  <label className="space-y-1 text-sm md:col-span-2">
                    <span className="block font-medium text-gray-700 dark:text-gray-300">
                      {formData.serviceType === 'redis' ? 'Redis URL' : formData.serviceType === 'postgres' ? 'Postgres DSN' : formData.serviceType === 'mariadb' ? 'MariaDB DSN' : 'OpenMetrics URL'} <span className="text-gray-400">(optional)</span>
                    </span>
                    <input
                      type={formData.serviceType === 'redis' || formData.serviceType === 'postgres' || formData.serviceType === 'mariadb' ? 'text' : 'url'}
                      value={formData.metricsUrl}
                      onChange={(event) => setFormData((current) => ({ ...current, metricsUrl: event.target.value }))}
                      className="input"
                      placeholder={
                        formData.serviceType === 'postfix'
                          ? 'http://postfix-host:9154/metrics'
                          : formData.serviceType === 'redis'
                            ? 'redis://redis-host:6379/0'
                            : formData.serviceType === 'postgres'
                              ? 'postgresql://user:pass@postgres-host:5432/dbname'
                              : formData.serviceType === 'mariadb'
                                ? 'mysql://robin_monitor:pass@db-host:3306/'
                              : 'http://dovecot-host:9900/metrics'
                      }
                    />
                  </label>
                ) : formData.serviceType === 'robin' || formData.serviceType === 'clamav' ? (
                  <>
                    <label className="space-y-1 text-sm md:col-span-2">
                      <span className="block font-medium text-gray-700 dark:text-gray-300">API URL</span>
                      <input
                        type="url"
                        value={formData.apiUrl}
                        onChange={(event) => setFormData((current) => ({ ...current, apiUrl: event.target.value }))}
                        className="input"
                        placeholder={formData.serviceType === 'clamav' ? 'http://clamav-agent.example:8080' : 'http://robin.example:8080'}
                        required
                      />
                    </label>

                    <label className="space-y-1 text-sm md:col-span-2">
                      <span className="block font-medium text-gray-700 dark:text-gray-300">{formData.serviceType === 'clamav' ? 'Status URL' : 'Metrics URL'}</span>
                      <input
                        type="url"
                        value={formData.metricsUrl}
                        onChange={(event) => setFormData((current) => ({ ...current, metricsUrl: event.target.value }))}
                        className="input"
                        placeholder={formData.serviceType === 'clamav' ? 'http://clamav-agent.example:8080/status' : 'http://robin.example:8080'}
                        required
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label className="space-y-1 text-sm md:col-span-2">
                      <span className="block font-medium text-gray-700 dark:text-gray-300">Controller URL</span>
                      <input
                        type="url"
                        value={formData.controllerUrl}
                        onChange={(event) => setFormData((current) => ({ ...current, controllerUrl: event.target.value }))}
                        className="input"
                        placeholder="http://rspamd.example:11334"
                        required
                      />
                    </label>

                    <label className="space-y-1 text-sm md:col-span-2">
                      <span className="block font-medium text-gray-700 dark:text-gray-300">Normal worker URL</span>
                      <input
                        type="url"
                        value={formData.normalUrl}
                        onChange={(event) => setFormData((current) => ({ ...current, normalUrl: event.target.value }))}
                        className="input"
                        placeholder="http://rspamd.example:11333"
                        required
                      />
                    </label>
                  </>
                )}
              </div>

              <label className="block space-y-1 text-sm">
                <span className="block font-medium text-gray-700 dark:text-gray-300">
                  Telemetry source <span className="text-gray-400">(optional)</span>
                </span>
                <input
                  type="text"
                  value={formData.telemetrySource}
                  maxLength={255}
                  onChange={(event) => setFormData((current) => ({ ...current, telemetrySource: event.target.value }))}
                  className="input"
                  placeholder="node-a.example.test"
                />
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  Source identity value matching the configured Telemetry discovery label.
                </span>
              </label>

              <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300">
                <div className="font-medium text-gray-700 dark:text-gray-200">
                  Service ID is the external identifier used by the managed fleet service, and it can be changed here when the upstream node uses a different role-specific name.
                </div>
                <div className="mt-2">
                  {formData.serviceType === 'robin'
                    ? 'Robin health is derived from API URL + /health, so only API and metrics endpoints are required here.'
                    : formData.serviceType === 'clamav'
                      ? 'ClamAV health uses the generic endpoint fields; manage ClamD and FreshClam config overrides on the ClamAV Config page.'
                      : formData.serviceType === 'cyrus'
                        ? 'Cyrus IMAP requires a metrics agent with promstatsd reports and cyr_info, quota and mbpath. Assign the service in Fleet → Agents. Configuration is not managed.'
                      : formData.serviceType === 'dovecot'
                        ? 'Dovecot metrics come from a robin-agent on its host (doveadm, which also gives sessions, quota and config), or from Dovecot’s OpenMetrics exporter URL. Fleet → Docs shows what each setup supports.'
                        : formData.serviceType === 'postfix'
                          ? 'Postfix metrics come from a robin-agent on its host (postqueue, which also gives the queue browser, counters and config), or from a postfix_exporter URL, which reports queue depth only. Fleet → Docs shows what each setup supports.'
                        : formData.serviceType === 'redis'
                          ? 'Redis observability connects directly with a redis-cli/client using the Redis URL (defaults to localhost:6379 when left blank). Manage maxmemory/policy overrides on the Redis Config page.'
                        : formData.serviceType === 'postgres'
                          ? 'PostgreSQL observability connects directly with a Postgres client using the DSN, or POSTGRES_ADMIN_DSN when the service DSN is blank. Manage GUC overrides on the PostgreSQL Config page.'
                        : formData.serviceType === 'mariadb'
                          ? 'MariaDB (or MySQL 8) connects directly with the DSN, or MARIADB_ADMIN_DSN when the service DSN is blank. With no route from robin-admin (a loopback-only database), assign a robin-agent next to it for metrics and logs. Fleet → Docs shows what each setup supports.'
                        : 'Rspamd health and metrics are derived from the controller and normal worker URLs, so no extra generic API fields are needed.'}
                </div>
              </div>

              <label className="flex items-center gap-3 rounded-xl border border-gray-200 p-4 text-sm dark:border-robin-gray-700">
                <input
                  type="checkbox"
                  checked={formData.enabled}
                  onChange={(event) => setFormData((current) => ({ ...current, enabled: event.target.checked }))}
                  className="h-4 w-4 rounded-sm border-gray-300 accent-robin-orange focus:ring-robin-orange"
                />
                <div>
                  <div className="font-medium text-gray-700 dark:text-gray-300">Enabled</div>
                  <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    Only enabled services appear in selectors, Fleet &gt; Metrics, and the service-specific workspaces.
                  </div>
                </div>
              </label>

              <div className="flex justify-end gap-3 pt-2">
                <Button type="button" variant="secondary" onClick={() => setShowModal(false)}>
                  Cancel
                </Button>
                <Button type="submit" isLoading={isSaving}>
                  {editingService ? 'Save changes' : 'Create service'}
                </Button>
              </div>
            </form>
            {editingService?.serviceType === 'rspamd' && (
              <div className="px-6 pb-6">
                <RspamdServiceSettings serviceId={editingService.serviceId} onSaved={() => void refreshFeatures()} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function EndpointLine({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</span>
      <span className="break-all font-mono text-xs text-gray-600 dark:text-gray-300">{value ?? '—'}</span>
    </div>
  );
}

function getVisibleEndpoints(service: FleetService): Array<{ label: string; value: string | null }> {
  if (service.serviceType === 'rspamd') {
    return [
      { label: 'Controller', value: service.controllerUrl ?? service.metricsUrl },
      { label: 'Worker', value: service.normalUrl ?? service.apiUrl },
    ];
  }

  if (service.serviceType === 'clamav') {
    return [
      { label: 'Endpoint', value: service.apiUrl },
      { label: 'Status', value: service.metricsUrl ?? service.healthUrl ?? service.apiUrl },
    ];
  }

  if (service.serviceType === 'cyrus') {
    return [{ label: 'Metrics', value: 'promstatsd report (agent required)' }, { label: 'Operations', value: 'Sessions, quota and mailbox lookup' }];
  }
  if (service.serviceType === 'dovecot') {
    return [
      { label: 'Metrics', value: service.metricsUrl ? `OpenMetrics ${service.metricsUrl}` : 'doveadm stats dump (co-located)' },
      { label: 'Config', value: 'fleet DB → conf.d override' },
    ];
  }

  if (service.serviceType === 'postfix') {
    return [
      { label: 'Metrics', value: service.metricsUrl ? `exporter ${service.metricsUrl}` : 'postqueue (co-located)' },
      { label: 'Config', value: 'fleet DB → postconf apply' },
    ];
  }

  if (service.serviceType === 'redis') {
    return [
      { label: 'Client', value: service.metricsUrl ? service.metricsUrl : 'redis://localhost:6379 (co-located)' },
      { label: 'Config', value: 'fleet DB → CONFIG SET override' },
    ];
  }

  if (service.serviceType === 'mariadb') {
    return [
      { label: 'DSN', value: service.metricsUrl ? service.metricsUrl : 'MARIADB_ADMIN_DSN' },
      { label: 'Config', value: 'fleet DB → SET GLOBAL override' },
    ];
  }

  if (service.serviceType === 'postgres') {
    return [
      { label: 'DSN', value: service.metricsUrl ? service.metricsUrl : 'POSTGRES_ADMIN_DSN' },
      { label: 'Config', value: 'fleet DB → ALTER SYSTEM override' },
    ];
  }

  return [
    { label: 'API', value: service.apiUrl },
    { label: 'Metrics', value: service.metricsUrl ?? service.apiUrl },
  ];
}
