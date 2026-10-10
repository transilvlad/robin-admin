/**
 * Storage configuration form (storage.json5).
 */

import { ConfigSection } from './ConfigSection';
import { TextField, ToggleField } from './ConfigField';
import { ArrayEditor } from './ArrayEditor';
import type { StorageConfig } from '../../types/robin-config';

interface StorageConfigFormProps {
  config: Partial<StorageConfig>;
  onChange: (config: Partial<StorageConfig>) => void;
  baseConfig?: Partial<StorageConfig>;
  disabled?: boolean;
}

export function StorageConfigForm({ config, onChange, baseConfig, disabled }: StorageConfigFormProps) {
  const update = <K extends keyof StorageConfig>(key: K, value: StorageConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  const isOverridden = (key: keyof StorageConfig) => 
    baseConfig && config[key] !== undefined && JSON.stringify(config[key]) !== JSON.stringify(baseConfig[key]);

  return (
    <div className="space-y-4">
      <ConfigSection title="Storage settings" description="Email storage configuration">
        <div className="space-y-3">
          <ToggleField
            label="Storage enabled"
            value={config.enabled ?? true}
            onChange={(v) => update('enabled', v)}
            help="If disabled, emails are not stored on disk, scanned, or delivered to Dovecot"
            disabled={disabled}
            isOverridden={isOverridden('enabled')}
          />
          <ToggleField
            label="Auto delete"
            value={config.autoDelete ?? true}
            onChange={(v) => update('autoDelete', v)}
            help="Auto delete files at connection/session end (queued items are copied before deletion)"
            disabled={disabled}
            isOverridden={isOverridden('autoDelete')}
          />
          <ToggleField
            label="Clean on start"
            value={config.clean ?? false}
            onChange={(v) => update('clean', v)}
            help="Auto clean storage folder on service start"
            disabled={disabled}
            isOverridden={isOverridden('clean')}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="Paths" description="Storage folder configuration">
        <div className="grid grid-cols-1 gap-4">
          <TextField
            label="Storage path"
            value={config.path ?? '/usr/local/robin/store/robin/'}
            onChange={(v) => update('path', v)}
            help="Base path to storage folder"
            placeholder="/usr/local/robin/store/robin/"
            disabled={disabled}
            isOverridden={isOverridden('path')}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <TextField
              label="Inbound folder"
              value={config.inboundFolder ?? 'new'}
              onChange={(v) => update('inboundFolder', v)}
              help="Folder for inbound emails (leave empty to disable)"
              placeholder="new"
              disabled={disabled}
              isOverridden={isOverridden('inboundFolder')}
            />
            <TextField
              label="Outbound folder"
              value={config.outboundFolder ?? '.Sent/new'}
              onChange={(v) => update('outboundFolder', v)}
              help="Folder for outbound emails (leave empty to disable)"
              placeholder=".Sent/new"
              disabled={disabled}
              isOverridden={isOverridden('outboundFolder')}
            />
          </div>
        </div>
      </ConfigSection>

      <ConfigSection title="RocksDB Backend" description="RocksDB-based mailbox storage" defaultExpanded={config.rocksdb?.enabled ?? false}>
        <ToggleField
          label="RocksDB Enabled"
          value={config.rocksdb?.enabled ?? false}
          onChange={(v) => update('rocksdb', { ...config.rocksdb, enabled: v })}
          help="Enable RocksDB for mailbox storage"
          disabled={disabled}
        />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
          <TextField
            label="RocksDB Path"
            value={config.rocksdb?.path ?? '/usr/local/robin/store/robin-rocksdb'}
            onChange={(v) => update('rocksdb', { ...config.rocksdb, path: v })}
            help="Path to RocksDB data directory"
            placeholder="/usr/local/robin/store/robin-rocksdb"
            disabled={disabled}
          />
          <TextField
            label="Inbox folder"
            value={config.rocksdb?.inboxFolder ?? 'Inbox'}
            onChange={(v) => update('rocksdb', { ...config.rocksdb, inboxFolder: v })}
            help="Folder name for inbox"
            placeholder="Inbox"
            disabled={disabled}
          />
          <TextField
            label="Sent folder"
            value={config.rocksdb?.sentFolder ?? 'Sent'}
            onChange={(v) => update('rocksdb', { ...config.rocksdb, sentFolder: v })}
            help="Folder name for sent mail"
            placeholder="Sent"
            disabled={disabled}
          />
        </div>
      </ConfigSection>

      <ConfigSection title="Clean patterns" description="Patterns for auto-clean (regex)" defaultExpanded={false}>
        <ArrayEditor
          label="File patterns"
          value={config.patterns ?? ['^([0-9]{8}\\.)'] }
          onChange={(v) => update('patterns', v)}
          help="Regex patterns to match filenames for auto-clean (delete matching files only)"
          placeholder="^([0-9]{8}\.)"
          disabled={disabled}
          isOverridden={isOverridden('patterns')}
        />
      </ConfigSection>

      <ConfigSection
        title="Local test storage"
        description="Mailbox copy and magic-header behavior used in local/e2e verification flows"
        badge="E2E"
      >
        <div className="space-y-3">
          <ToggleField
            label="Local mailbox"
            value={config.localMailbox ?? false}
            onChange={(v) => update('localMailbox', v)}
            help="Copy emails to recipient-specific mailbox folders. Primarily useful for local mailbox/dev workflows and end-to-end verification."
            disabled={disabled}
            isOverridden={isOverridden('localMailbox')}
          />
          <ToggleField
            label="Disable rename header"
            value={config.disableRenameHeader ?? true}
            onChange={(v) => update('disableRenameHeader', v)}
            help="Disable Robin's magic rename-header behavior. Keep this disabled only when you intentionally need header-driven rename behavior for testing."
            disabled={disabled}
            isOverridden={isOverridden('disableRenameHeader')}
          />
        </div>
      </ConfigSection>
    </div>
  );
}
