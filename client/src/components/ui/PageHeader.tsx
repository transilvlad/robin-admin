import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

interface PageHeaderProps {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  iconTone?: 'brand' | 'neutral';
}

export function PageHeader({
  icon: Icon,
  title,
  description,
  actions,
  iconTone = 'brand',
}: PageHeaderProps) {
  const iconToneClasses = iconTone === 'neutral'
    ? 'bg-gray-100 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300'
    : 'bg-robin-orange/10 text-robin-orange dark:bg-robin-orange/15';

  return (
    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
      <div className="space-y-2">
        <div className="flex items-start gap-3">
          <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${iconToneClasses}`}>
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{title}</h1>
            {description && (
              <p className="mt-1 max-w-5xl text-sm text-gray-500 dark:text-gray-400">
                {description}
              </p>
            )}
          </div>
        </div>
      </div>

      {actions && <div className="flex flex-wrap gap-3">{actions}</div>}
    </div>
  );
}
