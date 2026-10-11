/**
 * Promise-based confirm dialog, replacing the browser-native `confirm()`.
 *
 * A native confirm() blocks the page's main thread with UI the app can't
 * style or theme, and (observed directly) can hang automation/E2E tooling
 * that has no dialog handler wired up. useConfirm() is a drop-in swap for
 * call sites already written as `if (!confirm(msg)) return;` — just add
 * `await`.
 *
 * Usage:
 *   const confirm = useConfirm();
 *   if (!(await confirm('Delete this item?'))) return;
 */

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Modal } from '../components/ui/Modal';
import { Button } from '../components/ui/Button';

type ConfirmFn = (message: string) => Promise<boolean>;

interface PendingConfirm {
  message: string;
  resolve: (value: boolean) => void;
}

const ConfirmContext = createContext<ConfirmFn | undefined>(undefined);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback<ConfirmFn>((message) => (
    new Promise<boolean>((resolve) => {
      setPending({ message, resolve });
    })
  ), []);

  const settle = (value: boolean) => {
    pending?.resolve(value);
    setPending(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal isOpen={pending !== null} onClose={() => settle(false)} title="Confirm" size="sm">
        <p className="whitespace-pre-line text-sm text-gray-600 dark:text-gray-300">{pending?.message}</p>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="secondary" onClick={() => settle(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => settle(true)}>Confirm</Button>
        </div>
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const context = useContext(ConfirmContext);
  if (context === undefined) {
    throw new Error('useConfirm must be used within a ConfirmProvider');
  }
  return context;
}
