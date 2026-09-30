import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthUser {
  id: string;
  username: string;
  email: string | null;   // ایمیل دیگر اجباری نیست — شناسهٔ ورود، username است
  role: string;
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  // EventSource (SSE) نمی‌تواند هدر Authorization بفرستد؛ برای آن مسیرها توکن از query خوانده می‌شود.
  // فقط برای درخواست‌های GET مجاز است تا توکن در لاگِ عملیاتِ تغییردهنده ننشیند.
  const queryToken = req.method === 'GET' && typeof req.query.token === 'string' ? req.query.token : null;
  if (!header?.startsWith('Bearer ') && !queryToken) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  const token = header?.startsWith('Bearer ') ? header.slice(7) : queryToken!;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as AuthUser;
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Insufficient permissions' });
    }
    next();
  };
}
