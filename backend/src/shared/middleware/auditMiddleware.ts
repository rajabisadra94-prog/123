import { Request, Response, NextFunction } from 'express';
import prisma from '../utils/prisma';

export function auditMiddleware(entity: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      if (res.statusCode < 400 && req.user && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const action =
          req.method === 'POST' ? 'CREATE' :
          req.method === 'DELETE' ? 'DELETE' : 'UPDATE';
        prisma.auditLog.create({
          data: {
            userId: req.user!.id,
            action: action as any,
            entity,
            entityId: body?.id || req.params.id,
            changes: body,
            ipAddress: req.ip,
          },
        }).catch(console.error);
      }
      return originalJson(body);
    };
    next();
  };
}
