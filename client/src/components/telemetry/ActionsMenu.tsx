import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

export interface MenuAction {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  danger?: boolean;
}

/** A "More" button with a short list of actions. */
export function ActionsMenu({ actions, label = 'More actions' }: { actions: MenuAction[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  if (actions.length === 0) return null;
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className="btn btn-secondary px-2.5 py-1.5 text-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1 w-56 rounded-lg border border-gray-200 bg-white p-1 shadow-lg dark:border-robin-gray-700 dark:bg-robin-gray-800">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              className={`flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-robin-gray-700 ${action.danger ? 'text-red-600 dark:text-red-400' : ''}`}
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
