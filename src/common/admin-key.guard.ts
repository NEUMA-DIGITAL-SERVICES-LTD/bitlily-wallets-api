import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Privilege separation for ops endpoints (custody enrollment, withdrawal
 * approval). The main app's X-API-Key is held by Bitlily's backend and used
 * on every deposit check — it will leak before an ops key does. Admin
 * endpoints therefore require ADMIN_API_KEYS when configured.
 *
 * Fail-closed posture: when ADMIN_API_KEYS is unset, admin endpoints refuse
 * ALL callers in production (TATUM_USE_KMS=true or NODE_ENV=production) and
 * warn loudly at first use in dev. Don't silently fall back to the service
 * key — an unset admin key in prod means nobody approved the control model.
 */
@Injectable()
export class AdminKeyGuard implements CanActivate {
  private readonly logger = new Logger(AdminKeyGuard.name);
  private warned = false;

  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const key = String(req.headers['x-admin-key'] ?? '');
    const adminKeys = this.config.get<string[]>('service.adminApiKeys') ?? [];

    if (adminKeys.length) {
      if (!key || !adminKeys.includes(key)) {
        throw new UnauthorizedException('Invalid or missing X-Admin-Key');
      }
      return true;
    }

    const prod =
      process.env.NODE_ENV === 'production' ||
      this.config.get('tatum.useKms') === true;
    if (prod) {
      throw new UnauthorizedException(
        'ADMIN_API_KEYS not configured — admin endpoints disabled in production',
      );
    }
    if (!this.warned) {
      this.warned = true;
      this.logger.warn(
        'ADMIN_API_KEYS unset — admin endpoints gated only by service key. Set it before production.',
      );
    }
    return true;
  }
}
