import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { SetMetadata } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

/** Marks routes that skip API-key auth (webhook ingress, health). */
export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Service-to-service auth: the main Bitlily app authenticates with an
 * X-API-Key header. Keys are provisioned via SERVICE_API_KEYS env and are
 * the only thing separating this API from the open internet — rotate
 * regularly and prefer per-environment keys.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const key = String(req.headers['x-api-key'] ?? '');
    const valid: string[] = this.config.get('service.apiKeys') ?? [];
    // Constant-time compare — Array.includes short-circuits and leaks
    // match position via response timing.
    const buf = Buffer.from(key);
    const ok = key.length > 0 && valid.some(
      (v) => v.length === key.length && timingSafeEqual(buf, Buffer.from(v)),
    );
    if (!ok) {
      throw new UnauthorizedException('Invalid or missing X-API-Key');
    }
    return true;
  }
}
