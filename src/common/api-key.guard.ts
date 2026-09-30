import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { SetMetadata } from '@nestjs/common';

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
    const key = req.headers['x-api-key'];
    const valid: string[] = this.config.get('service.apiKeys') ?? [];
    if (!key || !valid.includes(String(key))) {
      throw new UnauthorizedException('Invalid or missing X-API-Key');
    }
    return true;
  }
}
