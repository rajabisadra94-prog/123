import { Request, Response, NextFunction } from 'express';
import prisma from '../utils/prisma';

/**
 * Permission middleware backed by the ROLE_PERMISSIONS matrix saved in SystemSetting
 * (managed from Settings → نقش‌ها و سطوح دسترسی).
 * - SUPER_ADMIN always passes.
 * - If no matrix is configured yet, access is allowed (so the app keeps working before setup).
 */
export function requirePermission(module: string, action: 'view' | 'create' | 'edit' | 'delete') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (!role) return res.status(401).json({ message: 'Authentication required' });
    if (role === 'SUPER_ADMIN') return next();

    try {
      const row = await prisma.systemSetting.findUnique({ where: { key: 'ROLE_PERMISSIONS' } });
      if (!row) return next(); // not configured yet → allow
      const matrix = JSON.parse(row.value);
      const allowed = matrix?.[role]?.[module]?.[action];
      if (allowed) return next();
      return res.status(403).json({ message: `دسترسی «${action}» در ماژول «${module}» برای نقش شما مجاز نیست` });
    } catch {
      return next(); // on any parse error, fail open to avoid blocking work
    }
  };
}
