import { HttpStatus } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

/**
 * Minimal fixed-window rate limiter for webhook ingress — the one unauthenticated
 * surface that accepts inbound traffic. Without it a hostile/buggy producer can
 * flood us into burning provider credits on verification lookups.
 *
 * In-memory per-process: correct for single-instance deployments; if the service
 * ever scales horizontally, move to Redis/token-bucket middleware.
 */
export function makeRateLimiter(opts: {
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
}): (req: Request, res: Response, next: NextFunction) => void {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const keyFn = opts.key ?? ((req: Request) => req.ip ?? 'unknown');
  return (req, res, next) => {
    const now = Date.now();
    const key = keyFn(req);
    let bucket = hits.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > opts.max) {
      res.status(HttpStatus.TOO_MANY_REQUESTS).json({
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: 'Rate limit exceeded',
      });
      return;
    }
    next();
  };
}
