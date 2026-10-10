/**
 * Config Diff page - shows differences between default and server-specific overrides.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  RefreshCw,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  GitCompare,
  Trash2,
  AlertTriangle,
  CheckCircle,
} from 'lucide-react';
import { robinConfigApi } from '../api/client';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { useConfirm } from '../context/ConfirmContext';

interface ConfigDiff {
  serverId: string;
  fileName: string;
  overrideFields: Record<string, { override: unknown; base: unknown }>;
  overrideOnly: Record<string, unknown>;
}

interface ConfigEntry {
  serverId: string;
  fileName: string;
  config: Record<string, unknown>;
}

export function ConfigDiffPage() {
  const confirm = useConfirm();
  const [diffs, setDiffs] = useState<ConfigDiff[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    fetchDiffs();
  }, []);

  const fetchDiffs = async () => {
    setIsLoading(true);
    setError('');
    
    try {
      // Fetch all configs
      const res = await robinConfigApi.getAll();
      const configs = res.data as ConfigEntry[] || [];
      
      // Group by file name
      const byFile = new Map<string, ConfigEntry[]>();
      for (const config of configs) {
        const list = byFile.get(config.fileName) || [];
        list.push(config);
        byFile.set(config.fileName, list);
      }
      
      // Compute diffs
      const computedDiffs: ConfigDiff[] = [];
      
      for (const [fileName, entries] of byFile) {
        const defaultEntry = entries.find(e => e.serverId === 'default');
        if (!defaultEntry) continue;
        
        for (const entry of entries) {
          if (entry.serverId === 'default') continue;
          
          const overrideFields: Record<string, { override: unknown; base: unknown }> = {};
          const overrideOnly: Record<string, unknown> = {};
          
          for (const [key, value] of Object.entries(entry.config)) {
            const baseValue = defaultEntry.config[key];
            if (baseValue === undefined) {
              overrideOnly[key] = value;
            } else if (JSON.stringify(value) !== JSON.stringify(baseValue)) {
              overrideFields[key] = { override: value, base: baseValue };
            }
          }
          
          if (Object.keys(overrideFields).length > 0 || Object.keys(overrideOnly).length > 0) {
            computedDiffs.push({
              serverId: entry.serverId,
              fileName,
              overrideFields,
              overrideOnly,
            });
          }
        }
      }
      
      // Sort by server, then file
      computedDiffs.sort((a, b) => 
        a.serverId.localeCompare(b.serverId) || a.fileName.localeCompare(b.fileName)
      );
      
      setDiffs(computedDiffs);
      
      // Auto-expand all servers
      const servers = new Set(computedDiffs.map(d => d.serverId));
      setExpandedServers(servers);
    } catch (err) {
      setError('Failed to load configurations');
    } finally {
      setIsLoading(false);
    }
  };

  const toggleServer = (serverId: string) => {
    setExpandedServers(prev => {
      const next = new Set(prev);
      if (next.has(serverId)) {
        next.delete(serverId);
      } else {
        next.add(serverId);
      }
      return next;
    });
  };

  const handleDeleteOverride = async (serverId: string, fileName: string) => {
    const id = `${serverId}/${fileName}`;
    if (!(await confirm(`Delete override for ${fileName} on server "${serverId}"?`))) {
      return;
    }
    
    setDeletingId(id);
    setError('');
    setSuccess('');
    
    try {
      await robinConfigApi.delete(serverId, fileName);
      setSuccess(`Deleted override: ${serverId}/${fileName}`);
      await fetchDiffs();
    } catch (err) {
      setError(`Failed to delete override: ${serverId}/${fileName}`);
    } finally {
      setDeletingId(null);
    }
  };

  const formatValue = (value: unknown): string => {
    if (typeof value === 'object') {
      return JSON.stringify(value, null, 2);
    }
    return String(value);
  };

  // Group diffs by server
  const byServer = new Map<string, ConfigDiff[]>();
  for (const diff of diffs) {
    const list = byServer.get(diff.serverId) || [];
    list.push(diff);
    byServer.set(diff.serverId, list);
  }

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
          icon={GitCompare}
          title="Robin config diff"
          description="Compare server-specific overrides against the shared defaults, file by file."
          actions={
            <>
              <Link to="/robin/config" className="btn btn-secondary">
                <ArrowLeft className="w-4 h-4" />
                Back
              </Link>
              <button
                onClick={fetchDiffs}
                className="btn btn-secondary"
                disabled={isLoading}
              >
                <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </>
          }
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

      {byServer.size === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-gray-500 dark:text-gray-400">
            No server-specific overrides found. All servers use the default configuration.
          </p>
          <Link to="/robin/config" className="text-robin-orange hover:underline mt-2 inline-block">
            Go to config editor to create overrides
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {Array.from(byServer.entries()).map(([serverId, serverDiffs]) => (
            <div key={serverId} className="card">
              <button
                onClick={() => toggleServer(serverId)}
                className="w-full flex items-center justify-between p-4 hover:bg-gray-50 dark:hover:bg-robin-gray-700 rounded-t-lg"
              >
                <div className="flex items-center gap-3">
                  {expandedServers.has(serverId) ? (
                    <ChevronDown className="w-5 h-5 text-gray-400" />
                  ) : (
                    <ChevronRight className="w-5 h-5 text-gray-400" />
                  )}
                  <span className="font-semibold text-lg">{serverId}</span>
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    {serverDiffs.length} file{serverDiffs.length !== 1 ? 's' : ''} with overrides
                  </span>
                </div>
                <span className="text-sm bg-robin-orange/20 text-robin-orange px-2 py-1 rounded-sm">
                  {serverDiffs.reduce((sum, d) => sum + Object.keys(d.overrideFields).length + Object.keys(d.overrideOnly).length, 0)} total changes
                </span>
              </button>

              {expandedServers.has(serverId) && (
                <div className="border-t border-gray-200 dark:border-robin-gray-700">
                  {serverDiffs.map((diff) => (
                    <div key={diff.fileName} className="border-b border-gray-100 dark:border-robin-gray-700 last:border-b-0">
                      <div className="flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-robin-gray-900">
                        <span className="font-medium">{diff.fileName}</span>
                        <button
                          onClick={() => handleDeleteOverride(diff.serverId, diff.fileName)}
                          disabled={deletingId === `${diff.serverId}/${diff.fileName}`}
                          className="text-red-500 hover:text-red-700 p-1"
                          title="Delete this override"
                        >
                          {deletingId === `${diff.serverId}/${diff.fileName}` ? (
                            <RefreshCw className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                      <div className="p-4 space-y-3">
                        {Object.entries(diff.overrideFields).map(([key, { override, base }]) => (
                          <div key={key} className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                                {key} (default)
                              </span>
                              <pre className="mt-1 p-2 bg-gray-100 dark:bg-robin-gray-800 rounded-sm text-sm font-mono overflow-x-auto text-red-600 dark:text-red-400">
                                {formatValue(base)}
                              </pre>
                            </div>
                            <div>
                              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                                {key} ({serverId})
                              </span>
                              <pre className="mt-1 p-2 bg-gray-100 dark:bg-robin-gray-800 rounded-sm text-sm font-mono overflow-x-auto text-green-600 dark:text-green-400">
                                {formatValue(override)}
                              </pre>
                            </div>
                          </div>
                        ))}
                        {Object.entries(diff.overrideOnly).map(([key, value]) => (
                          <div key={key}>
                            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                              {key} (new field - not in default)
                            </span>
                            <pre className="mt-1 p-2 bg-green-50 dark:bg-green-900/20 rounded-sm text-sm font-mono overflow-x-auto text-green-600 dark:text-green-400">
                              {formatValue(value)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
