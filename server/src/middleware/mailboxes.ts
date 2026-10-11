import type { Request, Response, NextFunction } from 'express';
import { getConfig } from '../db/queries/config.js';
import { tableExists } from '../db/queries/users.js';
import { aliasesTableExists, autoAliasesTableExists } from '../db/queries/aliases.js';
import { logger } from '../logger.js';

export function requireMailboxBackend(section: 'users' | 'aliases') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!(await getConfig()).mailboxesEnabled) {
        res.status(403).json({ success: false, error: 'Mailboxes is disabled. Enable it under Administration -> Integrations.' });
        return;
      }
      const automatic = section === 'aliases' && (req.path === '/auto' || req.path.startsWith('/auto/'));
      const ready = await (section === 'users' ? tableExists() : automatic ? autoAliasesTableExists() : aliasesTableExists());
      if (!ready) {
        res.status(503).json({ success: false, error: 'Mailbox backend is not configured or its schema is unsupported.' });
        return;
      }
      next();
    } catch (error) {
      logger.error('Failed to verify mailbox backend', { error: (error as Error).message });
      res.status(503).json({ success: false, error: 'Mailbox backend is unavailable.' });
    }
  };
}
