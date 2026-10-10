/**
 * Shared tab strip for the Mailboxes section (Users / Aliases / Auto Aliases).
 * Aliases and Auto Aliases are occasional setup surfaces, so they live beside
 * Users as in-page tabs while the sidebar keeps one stable Mailboxes entry.
 */

import { NavLink } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { appIcons } from '../../constants/appIcons';

interface MailboxTab {
  to: string;
  label: string;
  icon: LucideIcon;
}

export function MailboxTabs() {
  const tabs: MailboxTab[] = [
    { to: '/users', label: 'Users', icon: appIcons.users },
    { to: '/aliases', label: 'Aliases', icon: appIcons.aliases },
    { to: '/auto-aliases', label: 'Auto aliases', icon: appIcons.autoAliases },
  ];

  return (
    <div className="mb-6 flex flex-wrap gap-1 border-b border-gray-200 dark:border-robin-gray-700">
      {tabs.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) => `flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
            isActive
              ? 'border-robin-orange text-robin-orange'
              : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
          }`}
        >
          <Icon className="h-4 w-4" />
          {label}
        </NavLink>
      ))}
    </div>
  );
}
