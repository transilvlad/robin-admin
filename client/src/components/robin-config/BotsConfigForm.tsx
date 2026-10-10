/**
 * Bots configuration form (bots.json5).
 */

import { useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { ConfigSection } from './ConfigSection';
import { TextField, ToggleField, SelectField } from './ConfigField';
import { ArrayEditor } from './ArrayEditor';
import type { BotsConfig, BotDefinition } from '../../types/robin-config';

interface BotsConfigFormProps {
  config: Partial<BotsConfig>;
  onChange: (config: Partial<BotsConfig>) => void;
  baseConfig?: Partial<BotsConfig>;
  disabled?: boolean;
}

function BotEditor({
  bot,
  onChange,
  onDelete,
  disabled,
}: {
  bot: BotDefinition;
  onChange: (bot: BotDefinition) => void;
  onDelete: () => void;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);

  const update = <K extends keyof BotDefinition>(key: K, value: BotDefinition[K]) => {
    onChange({ ...bot, [key]: value });
  };

  return (
    <div className="border border-gray-200 dark:border-robin-gray-700 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 p-3 bg-gray-50 dark:bg-robin-gray-900">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-gray-400 hover:text-gray-600"
        >
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <span className="font-medium flex-1">{bot.botName || 'New Bot'}</span>
        <span className="text-xs text-gray-500 font-mono truncate max-w-xs">
          {bot.addressPattern || 'No pattern'}
        </span>
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled}
          className="p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-sm"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
      {expanded && (
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SelectField
              label="Bot name"
              value={bot.botName}
              onChange={(v) => update('botName', v)}
              options={[
                { value: 'session', label: 'Session - SMTP session diagnostic info' },
                { value: 'email', label: 'Email - Comprehensive email security analysis' },
                { value: 'dmarc', label: 'DMARC - Extract and POST DMARC reports' },
              ]}
              help="Bot implementation to use"
              disabled={disabled}
            />
            <TextField
              label="Address pattern"
              value={bot.addressPattern}
              onChange={(v) => update('addressPattern', v)}
              help="Regex pattern to match bot addresses"
              placeholder="^robotSession(\+.+)?@example\.com$"
              disabled={disabled}
            />
          </div>

          <ArrayEditor
            label="Allowed IPs"
            value={bot.allowedIps}
            onChange={(v) => update('allowedIps', v)}
            help="IP addresses/CIDR blocks allowed to use this bot (empty = no IP auth)"
            placeholder="192.168.1.0/24"
            disabled={disabled}
          />

          <ArrayEditor
            label="Allowed tokens"
            value={bot.allowedTokens}
            onChange={(v) => update('allowedTokens', v)}
            help="Tokens extracted from address (e.g., bot+token@domain). Either IP or token must match."
            placeholder="secretToken123"
            disabled={disabled}
          />

          {bot.botName === 'dmarc' && (
            <>
              <TextField
                label="Endpoint URL"
                value={bot.endpoint ?? ''}
                onChange={(v) => update('endpoint', v)}
                help="URL to POST parsed DMARC reports to"
                placeholder="https://localhost/api/dmarc/reports"
                disabled={disabled}
              />
              <ToggleField
                label="Insecure (Skip TLS Verification)"
                value={bot.insecure ?? false}
                onChange={(v) => update('insecure', v)}
                help="Skip TLS certificate verification (for self-signed certs)"
                disabled={disabled}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function BotsConfigForm({ config, onChange, disabled }: BotsConfigFormProps) {
  const bots = config.bots ?? [];

  const updateBots = (newBots: BotDefinition[]) => {
    onChange({ ...config, bots: newBots });
  };

  const addBot = () => {
    updateBots([
      ...bots,
      {
        addressPattern: '^newBot(\\+.+)?@example\\.com$',
        allowedIps: ['127.0.0.1', '::1'],
        allowedTokens: [],
        botName: 'session',
      },
    ]);
  };

  const updateBot = (index: number, bot: BotDefinition) => {
    const newBots = [...bots];
    newBots[index] = bot;
    updateBots(newBots);
  };

  const deleteBot = (index: number) => {
    updateBots(bots.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-4">
      <ConfigSection title="Email bots" description="Automated email analysis and response bots">
        <div className="space-y-4">
          {bots.map((bot, index) => (
            <BotEditor
              key={index}
              bot={bot}
              onChange={(b) => updateBot(index, b)}
              onDelete={() => deleteBot(index)}
              disabled={disabled}
            />
          ))}
          <button
            type="button"
            onClick={addBot}
            disabled={disabled}
            className="flex items-center gap-2 px-4 py-2 text-robin-orange hover:bg-robin-orange/10 rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add bot
          </button>
        </div>
      </ConfigSection>

      <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg space-y-2">
        <p className="text-sm font-medium text-blue-700 dark:text-blue-300">Available Bot Types:</p>
        <ul className="text-sm text-blue-600 dark:text-blue-400 space-y-1">
          <li><strong>session</strong> - Returns SMTP session diagnostic information</li>
          <li><strong>email</strong> - Comprehensive email analysis (DNSBL, rDNS, SPF, DKIM, DMARC, MX, DANE)</li>
          <li><strong>dmarc</strong> - Extracts DMARC reports from incoming emails and POSTs to endpoint</li>
        </ul>
      </div>
    </div>
  );
}
