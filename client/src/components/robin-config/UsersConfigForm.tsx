import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { ConfigSection } from './ConfigSection';
import { TextField, ToggleField } from './ConfigField';
import type { UsersConfig, UsersConfigEntry } from '../../types/robin-config';

interface UsersConfigFormProps {
  config: Partial<UsersConfig>;
  onChange: (config: Partial<UsersConfig>) => void;
  baseConfig?: Partial<UsersConfig>;
  disabled?: boolean;
}

const EMPTY_USER: UsersConfigEntry = {
  name: '',
  pass: '',
};

export function UsersConfigForm({ config, onChange, disabled }: UsersConfigFormProps) {
  const users = config.list ?? [];

  const update = <K extends keyof UsersConfig>(key: K, value: UsersConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  const updateUser = (index: number, nextUser: UsersConfigEntry) => {
    const next = [...users];
    next[index] = nextUser;
    update('list', next);
  };

  const addUser = () => {
    update('list', [...users, EMPTY_USER]);
  };

  const removeUser = (index: number) => {
    update('list', users.filter((_, currentIndex) => currentIndex !== index));
  };

  const enabled = config.listEnabled ?? false;

  return (
    <div className="space-y-4">
      <ConfigSection
        title="Static test users"
        description={(
          <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
            <AlertTriangle aria-hidden="true" className="h-4 w-4" />
            Do NOT enable in production
          </span>
        )}
        defaultExpanded={enabled}
        badge="E2E"
      >
        <ToggleField
          label="Enable test user list"
          value={enabled}
          onChange={(value) => update('listEnabled', value)}
          help="Turns on static test-user authentication for development and e2e scenarios only."
          disabled={disabled}
        />

        <div className="space-y-4">
          {users.map((user, index) => (
            <div key={`${user.name}-${index}`} className="rounded-lg border border-gray-200 p-4 dark:border-robin-gray-700">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="font-medium text-gray-900 dark:text-white">
                  {user.name || `Test user ${index + 1}`}
                </div>
                <button
                  type="button"
                  onClick={() => removeUser(index)}
                  disabled={disabled}
                  className="rounded-sm p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <TextField
                  label="Email / Username"
                  value={user.name}
                  onChange={(value) => updateUser(index, { ...user, name: value })}
                  placeholder="tony@example.com"
                  disabled={disabled}
                />
                <TextField
                  label="Password"
                  type="password"
                  value={user.pass}
                  onChange={(value) => updateUser(index, { ...user, pass: value })}
                  placeholder="stark"
                  disabled={disabled}
                />
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={addUser}
            disabled={disabled}
            className="flex items-center gap-2 rounded-lg px-4 py-2 text-robin-orange hover:bg-robin-orange/10"
          >
            <Plus className="h-4 w-4" />
            Add test user
          </button>
        </div>
      </ConfigSection>
    </div>
  );
}
