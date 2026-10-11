/**
 * Robin Configuration page with tabs for each config file.
 */

import { useEffect, useState, useCallback } from 'react';
import {
  RefreshCw,
  Save,
  Server,
  ListOrdered,
  HardDrive,
  ArrowRightLeft,
  Key,
  Shield,
  ShieldAlert,
  Bot,
  Webhook,
  CheckCircle,
  XCircle,
  Trash2,
  Globe,
  BarChart3,
  Gauge,
  AlertTriangle,
  Layers,
  Send,
  Settings,
  Copy,
  GitCompare,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { clamavApi, robinConfigApi } from '../api/client';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import { ServerConfigForm } from '../components/robin-config/ServerConfigForm';
import { QueueConfigForm } from '../components/robin-config/QueueConfigForm';
import { StorageConfigForm } from '../components/robin-config/StorageConfigForm';
import { RelayConfigForm } from '../components/robin-config/RelayConfigForm';
import { DovecotConfigForm } from '../components/robin-config/DovecotConfigForm';
import { ClamavConfigForm } from '../components/robin-config/ClamavConfigForm';
import { RspamdConfigForm } from '../components/robin-config/RspamdConfigForm';
import { BotsConfigForm } from '../components/robin-config/BotsConfigForm';
import { WebhooksConfigForm } from '../components/robin-config/WebhooksConfigForm';
import { WhitelistConfigForm } from '../components/robin-config/WhitelistConfigForm';
import { BlocklistConfigForm } from '../components/robin-config/BlocklistConfigForm';
import { BlackholeConfigForm } from '../components/robin-config/BlackholeConfigForm';
import { GeoIpConfigForm } from '../components/robin-config/GeoIpConfigForm';
import { PrometheusConfigForm } from '../components/robin-config/PrometheusConfigForm';
import { DistributedRateConfigForm } from '../components/robin-config/DistributedRateConfigForm';
import ClientConfigForm from '../components/robin-config/ClientConfigForm';
import PropertiesConfigForm from '../components/robin-config/PropertiesConfigForm';
import { ProxyConfigForm } from '../components/robin-config/ProxyConfigForm';
import { StalwartConfigForm } from '../components/robin-config/StalwartConfigForm';
import { UsersConfigForm } from '../components/robin-config/UsersConfigForm';
import { VaultConfigForm } from '../components/robin-config/VaultConfigForm';
import { JsonConfigForm } from '../components/robin-config/JsonConfigForm';
import { useServices } from '../context/ServiceContext';
import type { ClamavConfigState } from '../types';
import type { ConfigFileInfo, ConfigFileData } from '../types/robin-config';

// Icon mapping for config files
const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'server.json5': Server,
  'queue.json5': ListOrdered,
  'storage.json5': HardDrive,
  'relay.json5': ArrowRightLeft,
  'dovecot.json5': Key,
  'client.json5': Send,
  'properties.json5': Settings,
  'clamav.json5': Shield,
  'rspamd.json5': ShieldAlert,
  'bots.json5': Bot,
  'webhooks.json5': Webhook,
  'whitelist.json5': CheckCircle,
  'blocklist.json5': XCircle,
  'blackhole.json5': Trash2,
  'geoip.json5': Globe,
  'prometheus.json5': BarChart3,
  'distributed-rate.json5': Gauge,
  'vault.json5': Shield,
};

// Config file labels
const LABELS: Record<string, string> = {
  'server.json5': 'Server',
  'queue.json5': 'Queue',
  'storage.json5': 'Storage',
  'relay.json5': 'Relay',
  'dovecot.json5': 'Dovecot',
  'clamav.json5': 'ClamAV',
  'rspamd.json5': 'Rspamd',
  'bots.json5': 'Bots',
  'webhooks.json5': 'Webhooks',
  'whitelist.json5': 'Whitelist',
  'blocklist.json5': 'Blocklist',
  'blackhole.json5': 'Blackhole',
  'geoip.json5': 'GeoIP',
  'prometheus.json5': 'Prometheus',
  'distributed-rate.json5': 'Distributed rate',
  'properties.json5': 'Properties',
  'client.json5': 'Client',
  'routes.json5': 'Routes',
  'scenarios.json5': 'Scenarios',
  'users.json5': 'Users',
  'vault.json5': 'Vault',
  'proxy.json5': 'Proxy',
  'stalwart.json5': 'Stalwart',
};

export function RobinConfigPage() {
  const { clamavServices } = useServices();
  const [files, setFiles] = useState<ConfigFileInfo[]>([]);
  const [serverIds, setServerIds] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedServerId, setSelectedServerId] = useState('default');
  const [configData, setConfigData] = useState<ConfigFileData | null>(null);
  const [editedConfig, setEditedConfig] = useState<Record<string, unknown> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingConfig, setIsLoadingConfig] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [showSaveAsModal, setShowSaveAsModal] = useState(false);
  const [newServerId, setNewServerId] = useState('');
  const [clamavLink, setClamavLink] = useState<string | null>(null);
  const [loadedClamavLink, setLoadedClamavLink] = useState<string | null>(null);
  const [clamavLinkInherited, setClamavLinkInherited] = useState(false);
  const [linkedClamavConfig, setLinkedClamavConfig] = useState<ClamavConfigState | null>(null);

  // Fetch files list and server IDs
  const fetchFiles = useCallback(async () => {
    try {
      const [filesRes, serverIdsRes] = await Promise.all([
        robinConfigApi.getFiles(),
        robinConfigApi.getServerIds(),
      ]);
      setFiles(filesRes.data ?? []);
      setServerIds(serverIdsRes.data ?? []);

      // Select the first file only if none is selected yet — done via a
      // functional update so this callback doesn't depend on selectedFile
      // (which would recreate it and fire a redundant second fetch on load,
      // and reset the selection on manual Refresh).
      const list = filesRes.data;
      if (list?.length) {
        const preferred = list.find((file) => file.fileName === 'server.json5')?.fileName ?? list[0].fileName;
        setSelectedFile((current) => current ?? preferred);
      }
      setError('');
    } catch (err) {
      setError('Failed to load configuration files');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  // Fetch specific config file
  const fetchConfig = useCallback(async () => {
    if (!selectedFile) return;

    setIsLoadingConfig(true);
    try {
      const [response, clamavLinkResponse] = await Promise.all([
        robinConfigApi.getFile(selectedFile, selectedServerId),
        selectedFile === 'clamav.json5'
          ? robinConfigApi.getClamavLink(selectedServerId)
          : Promise.resolve(null),
      ]);
      setConfigData(response.data ?? null);
      
      // For non-default server, merge base with override for editing
      if (selectedServerId !== 'default' && response.data?.override) {
        setEditedConfig({ ...response.data.base.config, ...response.data.override.config });
      } else {
        setEditedConfig(response.data?.base.config ?? null);
      }

      if (clamavLinkResponse?.data) {
        setClamavLink(clamavLinkResponse.data.serviceId);
        setLoadedClamavLink(clamavLinkResponse.data.serviceId);
        setClamavLinkInherited(clamavLinkResponse.data.inherited);
      } else {
        setClamavLink(null);
        setLoadedClamavLink(null);
        setClamavLinkInherited(false);
        setLinkedClamavConfig(null);
      }
      
      setHasChanges(false);
      setError('');
    } catch (err) {
      setError('Failed to load configuration');
      setConfigData(null);
      setEditedConfig(null);
    } finally {
      setIsLoadingConfig(false);
    }
  }, [selectedFile, selectedServerId]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  useEffect(() => {
    if (selectedFile !== 'clamav.json5' || !clamavLink) {
      setLinkedClamavConfig(null);
      return;
    }

    let cancelled = false;
    clamavApi.getConfig(clamavLink)
      .then((response) => {
        if (!cancelled) {
          setLinkedClamavConfig(response.data ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLinkedClamavConfig(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [clamavLink, selectedFile]);

  // Handle config change
  const handleConfigChange = (newConfig: Record<string, unknown>) => {
    setEditedConfig(newConfig);
    setHasChanges(true);
    setSuccess('');
  };

  // Save config
  const handleSave = async () => {
    if (!selectedFile || !editedConfig) return;

    setIsSaving(true);
    setError('');
    setSuccess('');

    try {
      // For non-default server, save only the override
      let configToSave = editedConfig;
      if (selectedServerId !== 'default' && configData?.base.config) {
        // Extract only changed fields
        const overrideConfig: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(editedConfig)) {
          if (JSON.stringify(value) !== JSON.stringify(configData.base.config[key])) {
            overrideConfig[key] = value;
          }
        }
        configToSave = overrideConfig;
      }

      await robinConfigApi.update(selectedServerId, selectedFile, configToSave);
      if (selectedFile === 'clamav.json5' && clamavLink !== loadedClamavLink) {
        await robinConfigApi.setClamavLink(selectedServerId, clamavLink);
        setLoadedClamavLink(clamavLink);
        setClamavLinkInherited(false);
      }
      setSuccess('Configuration saved successfully');
      setHasChanges(false);
      await fetchConfig(); // Refresh to get updated data
      await fetchFiles(); // Refresh server IDs list
    } catch (err) {
      setError('Failed to save configuration');
    } finally {
      setIsSaving(false);
    }
  };

  // Save As - create new server override
  const handleSaveAs = async () => {
    if (!selectedFile || !editedConfig || !newServerId.trim()) return;

    const serverId = newServerId.trim();
    if (serverId === 'default') {
      setError('Cannot use "default" as server ID');
      return;
    }

    setIsSaving(true);
    setError('');
    setSuccess('');

    try {
      // Extract only changed fields from base
      const overrideConfig: Record<string, unknown> = {};
      const baseConfig = configData?.base.config || {};
      
      for (const [key, value] of Object.entries(editedConfig)) {
        if (JSON.stringify(value) !== JSON.stringify(baseConfig[key])) {
          overrideConfig[key] = value;
        }
      }

      if (Object.keys(overrideConfig).length === 0) {
        setError('No differences from base config to save');
        setIsSaving(false);
        return;
      }

      await robinConfigApi.update(serverId, selectedFile, overrideConfig);
      if (selectedFile === 'clamav.json5' && clamavLink) {
        await robinConfigApi.setClamavLink(serverId, clamavLink);
      }
      setSuccess(`Override saved for server "${serverId}" with ${Object.keys(overrideConfig).length} field(s)`);
      setShowSaveAsModal(false);
      setNewServerId('');
      setHasChanges(false);
      setSelectedServerId(serverId); // Switch to new server
      await fetchFiles(); // Refresh server IDs list
      await fetchConfig();
    } catch (err) {
      setError('Failed to save configuration');
    } finally {
      setIsSaving(false);
    }
  };

  // Render config form based on file type
  const handleClamavLinkChange = async (serviceId: string | null) => {
    setError('');
    setClamavLink(serviceId);
    setHasChanges(true);
    setSuccess('');

    if (!serviceId) {
      setLinkedClamavConfig(null);
      return;
    }

    try {
      const response = await clamavApi.getConfig(serviceId);
      const nextConfig = response.data ?? null;
      setLinkedClamavConfig(nextConfig);
      if (nextConfig?.clamd) {
        setEditedConfig((current) => current ? ({
          ...current,
          host: nextConfig.clamd.tcpAddr,
          port: nextConfig.clamd.tcpPort,
        }) : current);
        setHasChanges(true);
      }
    } catch {
      setError('Failed to load linked ClamAV service endpoint');
    }
  };

  const renderConfigForm = () => {
    if (!editedConfig) return null;

    const baseConfig = selectedServerId !== 'default' ? configData?.base.config : undefined;
    const commonProps = {
      config: editedConfig,
      onChange: handleConfigChange,
      baseConfig,
    };

    switch (selectedFile) {
      case 'server.json5':
        return <ServerConfigForm {...commonProps} />;
      case 'queue.json5':
        return <QueueConfigForm {...commonProps} />;
      case 'storage.json5':
        return <StorageConfigForm {...commonProps} />;
      case 'relay.json5':
        return <RelayConfigForm {...commonProps} />;
      case 'dovecot.json5':
        return <DovecotConfigForm {...commonProps} />;
      case 'client.json5':
        return <ClientConfigForm {...commonProps} />;
      case 'properties.json5':
        return <PropertiesConfigForm {...commonProps} />;
      case 'clamav.json5':
        return (
          <ClamavConfigForm
            {...commonProps}
            clamavServices={clamavServices}
            linkedServiceId={clamavLink}
            onLinkedServiceChange={handleClamavLinkChange}
            linkedEndpoint={linkedClamavConfig ? {
              host: linkedClamavConfig.clamd.tcpAddr,
              port: linkedClamavConfig.clamd.tcpPort,
            } : null}
            linkInherited={clamavLinkInherited}
          />
        );
      case 'rspamd.json5':
        return <RspamdConfigForm {...commonProps} />;
      case 'bots.json5':
        return <BotsConfigForm {...commonProps} />;
      case 'webhooks.json5':
        return <WebhooksConfigForm {...commonProps} />;
      case 'whitelist.json5':
        return <WhitelistConfigForm {...commonProps} />;
      case 'blocklist.json5':
        return <BlocklistConfigForm {...commonProps} />;
      case 'blackhole.json5':
        return <BlackholeConfigForm {...commonProps} />;
      case 'geoip.json5':
        return <GeoIpConfigForm {...commonProps} />;
      case 'prometheus.json5':
        return <PrometheusConfigForm {...commonProps} />;
      case 'distributed-rate.json5':
        return <DistributedRateConfigForm {...commonProps} />;
      case 'users.json5':
        return <UsersConfigForm {...commonProps} />;
      case 'proxy.json5':
        return <ProxyConfigForm {...commonProps} />;
      case 'stalwart.json5':
        return <StalwartConfigForm {...commonProps} />;
      case 'vault.json5':
        return <VaultConfigForm {...commonProps} />;
      default:
        return (
          <JsonConfigForm
            config={editedConfig}
            onChange={handleConfigChange}
          />
        );
    }
  };

  // Force Robin to re-pull config from the DB and hot-reload. Robin self-syncs,
  // so this is the "sync" for Robin — the applied/skipped detail lands in Robin's
  // own logs (Robin Logs page).
  const handleSync = async () => {
    setIsSyncing(true);
    setError('');
    setSuccess('');
    try {
      const target = selectedServerId === 'default' ? undefined : selectedServerId;
      const res = await robinConfigApi.reload(target);
      setSuccess(res.data?.message || 'Robin re-pulled config and reloaded. See Robin logs for applied/skipped detail.');
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Failed to trigger Robin config reload');
    } finally {
      setIsSyncing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Spinner className="text-robin-orange" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <PageHeader
          icon={appIcons.robinConfig}
          title="Robin config"
          description="Per-file managed config with a shared Default (base) and per-server overrides. Robin pulls this config itself — use Sync now to force a re-pull + reload (no fleet agent, so no Sync tab)."
          actions={(
            <div className="flex items-center gap-2">
              <button onClick={fetchFiles} className="btn btn-secondary">
                <RefreshCw className="w-4 h-4" />
                Refresh
              </button>
              <button onClick={() => void handleSync()} disabled={isSyncing} className="btn btn-primary">
                <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
                {isSyncing ? 'Syncing…' : 'Sync now'}
              </button>
            </div>
          )}
        />
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 p-4 rounded-lg mb-6 flex items-center gap-2">
          <AlertTriangle className="w-5 h-5" />
          {error}
        </div>
      )}

      {success && (
        <div className="bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 p-4 rounded-lg mb-6 flex items-center gap-2">
          <CheckCircle className="w-5 h-5" />
          {success}
        </div>
      )}

      {files.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-gray-500 dark:text-gray-400 mb-4">
            No configuration files found in the database.
          </p>
          <p className="text-sm text-gray-400">
            Configuration files are synced from Robin's config directory when the server starts.
          </p>
        </div>
      ) : (
        <div className="flex flex-col lg:flex-row gap-6">
          {/* File tabs sidebar */}
          <div className="lg:w-64 shrink-0">
            <div className="card p-2 sticky top-4">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 px-3 py-2">
                Config files
              </div>
              <nav className="space-y-1">
                {files.map((file) => {
                  const Icon = ICONS[file.fileName] || Layers;
                  const isActive = selectedFile === file.fileName;
                  const hasOverride = file.serverIds.length > 1;
                  return (
                    <button
                      key={file.fileName}
                      onClick={() => setSelectedFile(file.fileName)}
                      className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm transition-colors ${
                        isActive
                          ? 'bg-robin-orange/10 text-robin-orange'
                          : 'hover:bg-gray-100 dark:hover:bg-robin-gray-700'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="flex-1 truncate">{LABELS[file.fileName] || file.fileName.replace('.json5', '')}</span>
                      {hasOverride && (
                        <span className="text-xs bg-robin-orange/20 text-robin-orange px-1.5 py-0.5 rounded-sm">
                          {file.serverIds.length}
                        </span>
                      )}
                    </button>
                  );
                })}
              </nav>
            </div>
          </div>

          {/* Config editor */}
          <div className="flex-1 min-w-0">
            <div className="card">
              {/* Header */}
              <div className="p-4 border-b border-gray-200 dark:border-robin-gray-700">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold">
                      {LABELS[selectedFile || ''] || selectedFile}
                    </h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {configData?.base.updatedAt && (
                        <>Last updated: {new Date(configData.base.updatedAt).toLocaleString()}</>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {/* Server ID selector */}
                    <div className="flex items-center gap-2">
                      <label className="text-sm text-gray-600 dark:text-gray-400">Server:</label>
                      <select
                        value={selectedServerId}
                        onChange={(e) => setSelectedServerId(e.target.value)}
                        className="input py-1.5 text-sm"
                      >
                        {serverIds.map((id) => (
                          <option key={id} value={id}>
                            {id === 'default' ? 'Default (base)' : id}
                          </option>
                        ))}
                      </select>
                    </div>
                    {/* View Diff link */}
                    <Link
                      to="/robin/config/diff"
                      className="btn btn-secondary"
                    >
                      <GitCompare className="w-4 h-4" />
                      Diff
                    </Link>
                    {/* Save As button */}
                    <button
                      onClick={() => setShowSaveAsModal(true)}
                      disabled={isSaving}
                      className="btn btn-secondary"
                    >
                      <Copy className="w-4 h-4" />
                      Save as
                    </button>
                    {/* Save button */}
                    <button
                      onClick={handleSave}
                      disabled={isSaving || !hasChanges}
                      className="btn btn-primary"
                    >
                      {isSaving ? (
                        <RefreshCw className="w-4 h-4 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4" />
                      )}
                      Save
                    </button>
                  </div>
                </div>

                {/* Override indicator */}
                {selectedServerId !== 'default' && (
                  <div className="mt-3 p-3 bg-robin-orange/10 rounded-lg">
                    <p className="text-sm text-robin-orange">
                      Editing override for <strong>{selectedServerId}</strong>. 
                      {configData?.override ? (
                        <> This server has {Object.keys(configData.override.config).length} overridden fields.</>
                      ) : (
                        <> No overrides exist yet. Changes will create a new override.</>
                      )}
                    </p>
                  </div>
                )}
              </div>

              {/* Form */}
              <div className="p-4">
                {isLoadingConfig ? (
                  <div className="flex justify-center py-8">
                    <Spinner className="text-robin-orange" />
                  </div>
                ) : (
                  renderConfigForm()
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Save As Modal */}
      {showSaveAsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-robin-gray-800 rounded-lg shadow-xl max-w-md w-full mx-4">
            <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-robin-gray-700">
              <h3 className="text-lg font-semibold">Save as server override</h3>
              <button
                onClick={() => setShowSaveAsModal(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Create a server-specific override that will be merged with the default configuration.
                Only fields that differ from the default will be saved.
              </p>
              <div>
                <label className="form-label">Server ID</label>
                <input
                  type="text"
                  value={newServerId}
                  onChange={(e) => setNewServerId(e.target.value)}
                  placeholder="e.g., robin1, production, staging"
                  className="form-input"
                  autoFocus
                />
                <p className="form-hint">
                  Unique identifier for this server configuration
                </p>
              </div>
              {serverIds.filter(id => id !== 'default').length > 0 && (
                <div className="text-sm">
                  <span className="text-gray-500 dark:text-gray-400">Existing servers: </span>
                  {serverIds.filter(id => id !== 'default').map((id, i) => (
                    <span key={id}>
                      {i > 0 && ', '}
                      <button
                        type="button"
                        className="text-robin-orange hover:underline"
                        onClick={() => setNewServerId(id)}
                      >
                        {id}
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-gray-200 dark:border-robin-gray-700">
              <button
                onClick={() => setShowSaveAsModal(false)}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveAs}
                disabled={isSaving || !newServerId.trim()}
                className="btn btn-primary"
              >
                {isSaving ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
                Save Override
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
