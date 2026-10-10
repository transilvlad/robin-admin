/**
 * GeoIP configuration form (geoip.json5).
 */

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { ConfigSection } from './ConfigSection';
import { TextField, ToggleField, SelectField } from './ConfigField';
import type { GeoIpConfig } from '../../types/robin-config';

interface GeoIpConfigFormProps {
  config: Partial<GeoIpConfig>;
  onChange: (config: Partial<GeoIpConfig>) => void;
  baseConfig?: Partial<GeoIpConfig>;
  disabled?: boolean;
}

const ACTIONS = [
  { value: 'allow', label: 'Allow' },
  { value: 'block', label: 'Block' },
  { value: 'limit', label: 'Limit (rate limiting)' },
];

export function GeoIpConfigForm({ config, onChange, disabled }: GeoIpConfigFormProps) {
  const [newCountry, setNewCountry] = useState('');
  const countries = config.countries ?? {};

  const update = <K extends keyof GeoIpConfig>(key: K, value: GeoIpConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  const updateCountry = (code: string, action: string) => {
    update('countries', { ...countries, [code]: action as GeoIpConfig['defaultAction'] });
  };

  const removeCountry = (code: string) => {
    const { [code]: _, ...rest } = countries;
    update('countries', rest);
  };

  const addCountry = () => {
    if (newCountry && newCountry.length === 2 && !countries[newCountry.toUpperCase()]) {
      update('countries', { ...countries, [newCountry.toUpperCase()]: 'allow' });
      setNewCountry('');
    }
  };

  return (
    <div className="space-y-4">
      <ConfigSection title="GeoIP Settings" description="Geographic IP filtering using MaxMind database">
        <ToggleField
          label="Enabled"
          value={config.enabled ?? false}
          onChange={(v) => update('enabled', v)}
          help="Enable GeoIP-based filtering"
          disabled={disabled}
        />

        <TextField
          label="Database path"
          value={config.databasePath ?? ''}
          onChange={(v) => update('databasePath', v)}
          help="Path to MaxMind GeoLite2 Country database (.mmdb file)"
          placeholder="/usr/local/robin/GeoLite2-Country.mmdb"
          disabled={disabled}
        />

        <SelectField
          label="Default action"
          value={config.defaultAction ?? 'allow'}
          onChange={(v) => update('defaultAction', v as GeoIpConfig['defaultAction'])}
          options={ACTIONS}
          help="Action for countries not explicitly configured or when database unavailable"
          disabled={disabled}
        />
      </ConfigSection>

      <ConfigSection title="Country rules" description="Configure actions per country (ISO 3166-1 alpha-2 codes)">
        <div className="space-y-2">
          {Object.entries(countries).length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center border border-dashed border-gray-300 dark:border-robin-gray-600 rounded-lg">
              No country rules configured. The default action will apply to all countries.
            </p>
          ) : (
            <div className="space-y-2">
              {Object.entries(countries).sort().map(([code, action]) => (
                <div key={code} className="flex items-center gap-3 p-2 bg-gray-50 dark:bg-robin-gray-900 rounded-lg">
                  <span className="font-mono font-medium w-12">{code}</span>
                  <SelectField
                    label=""
                    value={action}
                    onChange={(v) => updateCountry(code, v)}
                    options={ACTIONS}
                    disabled={disabled}
                  />
                  <button
                    type="button"
                    onClick={() => removeCountry(code)}
                    disabled={disabled}
                    className="p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-sm ml-auto"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 mt-4">
            <TextField
              label=""
              value={newCountry}
              onChange={setNewCountry}
              placeholder="Country code (e.g., US, GB, CN)"
              disabled={disabled}
            />
            <button
              type="button"
              onClick={addCountry}
              disabled={disabled || !newCountry || newCountry.length !== 2}
              className="flex items-center gap-1 px-3 py-2 text-robin-orange hover:bg-robin-orange/10 rounded-lg disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
              Add
            </button>
          </div>
        </div>
      </ConfigSection>

      <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg space-y-2">
        <p className="text-sm font-medium text-blue-700 dark:text-blue-300">GeoIP Database:</p>
        <p className="text-sm text-blue-600 dark:text-blue-400">
          Requires MaxMind GeoLite2 Country database. Sign up for a free license at{' '}
          <a href="https://www.maxmind.com/en/geolite2/signup" target="_blank" rel="noopener noreferrer" className="underline">
            maxmind.com
          </a>.
        </p>
        <p className="text-xs text-blue-500 dark:text-blue-500 mt-1">
          Common country codes: US (United States), GB (United Kingdom), DE (Germany), FR (France), CN (China), RU (Russia)
        </p>
      </div>
    </div>
  );
}
