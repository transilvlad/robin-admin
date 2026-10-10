import type { ComponentType, ReactNode } from 'react';

type Tone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

const toneClasses: Record<Tone, { badge: string; stat: string; notice: string }> = {
  neutral: {
    badge: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200',
    stat: 'border-gray-200 bg-white text-gray-950 dark:border-gray-700 dark:bg-robin-gray-900 dark:text-white',
    notice: 'border-gray-200 bg-white text-gray-700 dark:border-gray-700 dark:bg-robin-gray-900 dark:text-gray-200',
  },
  success: {
    badge: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200',
    stat: 'border-green-200 bg-green-50 text-green-700 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-200',
    notice: 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300',
  },
  warning: {
    badge: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
    stat: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200',
    notice: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300',
  },
  error: {
    badge: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200',
    stat: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200',
    notice: 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300',
  },
  info: {
    badge: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200',
    stat: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200',
    notice: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300',
  },
};

export function AdminStat({ label, value, description, tone = 'neutral' }: { label: string; value: ReactNode; description?: ReactNode; tone?: Tone }) {
  return (
    <div className={`rounded-lg border p-4 ${toneClasses[tone].stat}`}>
      <div className="text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-sm opacity-80">{label}</div>
      {description && <div className="mt-2 text-xs opacity-75">{description}</div>}
    </div>
  );
}

export function AdminNotice({ children, tone }: { children: ReactNode; tone: Extract<Tone, 'success' | 'warning' | 'error' | 'info'> }) {
  return <div className={`rounded-lg border p-3 text-sm ${toneClasses[tone].notice}`}>{children}</div>;
}

export function StatusBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${toneClasses[tone].badge}`}>{children}</span>;
}

export function SettingsCard({ title, description, children, action, icon: Icon, className = '', bodyClassName = 'p-5' }: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`card overflow-hidden ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-200 p-5 dark:border-gray-700">
        <div className="flex min-w-0 items-start gap-3">
          {Icon && (
            <div className="mt-0.5 rounded-lg bg-robin-orange/10 p-2 text-robin-orange">
              <Icon className="h-5 w-5" />
            </div>
          )}
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{title}</h2>
            {description && <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{description}</p>}
          </div>
        </div>
        {action}
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function ReadOnlyList({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="grid gap-x-6 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className="min-w-0 border-t border-gray-200 py-2 dark:border-gray-700">
          <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">{item.label}</dt>
          <dd className="mt-1 wrap-break-word text-sm text-gray-900 dark:text-gray-100">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
