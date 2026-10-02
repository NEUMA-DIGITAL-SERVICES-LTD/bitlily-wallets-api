import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

/**
 * Stamps every request with an id — honours an inbound X-Request-Id (bounded
 * length, sanitized) so the main app can correlate its calls, otherwise mints
 * one. Echoed on the response for support/debug traces.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get('x-request-id');
  const id =
    incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
