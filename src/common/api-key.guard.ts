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
import { ApiClient } from '../config/configuration';

/** Marks routes that skip API-key auth (webhook ingress, health). */
export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Service-to-service auth: an integrating app authenticates with an
 * X-API-Key header. Keys come from two sources:
 *   SERVICE_API_KEYS — legacy flat list; all resolve to the 'default' tenant
 *   API_CLIENTS      — JSON [{slug, apiKey, webhookUrl, webhookSecret}];
 *                      each key resolves to that client's slug
 * The resolved slug is attached to req.appId and scopes every wallet
 * lookup — app A cannot read or spend app B's wallets.
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

    const appId = this.resolveAppId(key);
    if (!appId) {
      throw new UnauthorizedException('Invalid or missing X-API-Key');
    }
    req.appId = appId;
    return true;
  }

  private resolveAppId(key: string): string | null {
    if (!key) return null;
    const matches = (candidate: string) =>
      candidate.length === key.length &&
      timingSafeEqual(Buffer.from(key), Buffer.from(candidate));

    for (const client of this.config.get<ApiClient[]>('service.clients') ?? []) {
      if (matches(client.apiKey)) return client.slug;
    }
    for (const legacy of this.config.get<string[]>('service.apiKeys') ?? []) {
      if (matches(legacy)) return 'default';
    }
    return null;
  }
}
