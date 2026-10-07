import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { SetMetadata } from '@nestjs/common';
import { ClientsService } from './clients.service';
import { ipAllowed } from './ip-match';

/** Marks routes that skip API-key auth (webhook ingress, health). */
export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Marks routes that move money — require the 'wallet' scope. Keys with
 *  scopes ['read'] (general keys) pass shared endpoints but get 403 here. */
export const REQUIRED_SCOPE = 'requiredScope';
export const RequireScope = (scope: string) => SetMetadata(REQUIRED_SCOPE, scope);

/**
 * Service-to-service auth: an integrating app authenticates with an
 * X-API-Key header. The key resolves to a tenant (req.appId) via
 * ClientsService — env API_CLIENTS, then the api_clients table, then
 * legacy SERVICE_API_KEYS ('default' tenant). Every wallet lookup is
 * scoped by appId — app A cannot read or spend app B's wallets.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
    private readonly clients: ClientsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const key = String(req.headers['x-api-key'] ?? '');

    const resolved = await this.clients.resolve(key);
    if (!resolved) {
      throw new UnauthorizedException('Invalid or missing X-API-Key');
    }
    // Per-tenant IP allowlist — a leaked key is dead outside the tenant's
    // egress. req.ip is only honest if TRUST_PROXY_HOPS matches the real
    // ingress hops (unset = socket peer = unspoofable but proxy-blind).
    if (resolved.allowedIps?.length && !ipAllowed(req.ip, resolved.allowedIps)) {
      throw new ForbiddenException('X-API-Key not allowed from this IP');
    }
    req.appId = resolved.appId;
    req.clientScopes = resolved.scopes;

    const required = this.reflector.getAllAndOverride<string>(REQUIRED_SCOPE, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (required && !resolved.scopes.includes(required)) {
      throw new ForbiddenException(
        `This key lacks the '${required}' scope — it can only reach read/general endpoints`,
      );
    }
    return true;
  }
}
