import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import { ipAllowed } from './ip-match';

/**
 * Privilege separation for ops endpoints (custody enrollment, withdrawal
 * approval). The main app's X-API-Key is held by Bitlily's backend and used
 * on every deposit check — it will leak before an ops key does. Admin
 * endpoints therefore require ADMIN_API_KEYS (raw) or ADMIN_API_KEY_HASHES
 * (hex SHA-256 digests — preferred: a leaked .env yields unusable digests)
 * when configured.
 *
 * Fail-closed posture: when neither is set, admin endpoints refuse
 * ALL callers in production (TATUM_USE_KMS=true or NODE_ENV=production) and
 * warn loudly at first use in dev. Don't silently fall back to the service
 * key — an unset admin key in prod means nobody approved the control model.
 */
@Injectable()
export class AdminKeyGuard implements CanActivate {
  private readonly logger = new Logger(AdminKeyGuard.name);
  private warned = false;

  constructor(private readonly config: ConfigService) {}

  private badHashWarned = false;

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const key = String(req.headers['x-admin-key'] ?? '');
    const adminKeys = this.config.get<string[]>('service.adminApiKeys') ?? [];
    const keyHashes =
      this.config.get<string[]>('service.adminApiKeyHashes') ?? [];

    if (adminKeys.length || keyHashes.length) {
      // Everything normalizes to a SHA-256 digest: configured hashes match
      // directly, raw keys hash on the fly — one constant-time comparison
      // path either way. Callers always send the raw key.
      const digests = keyHashes
        .filter((h) => {
          if (/^[0-9a-f]{64}$/i.test(h)) return true;
          if (!this.badHashWarned) {
            this.badHashWarned = true;
            this.logger.warn(
              'ADMIN_API_KEY_HASHES entry is not 64-char hex — it can never match',
            );
          }
          return false;
        })
        .map((h) => Buffer.from(h, 'hex'));
      for (const raw of adminKeys) {
        digests.push(createHash('sha256').update(raw).digest());
      }
      const provided = key
        ? createHash('sha256').update(key).digest()
        : null;
      const ok =
        !!provided && digests.some((d) => timingSafeEqual(d, provided));
      if (!ok) {
        throw new UnauthorizedException('Invalid or missing X-Admin-Key');
      }
      // Ops-source restriction: ADMIN_ALLOWED_IPS pins the admin key to ops
      // egress CIDRs. Empty = unrestricted. This key mints spend-capable
      // credentials — its blast radius justifies a second factor.
      const allowedIps = this.config.get<string[]>('service.adminAllowedIps') ?? [];
      if (allowedIps.length && !ipAllowed(req.ip, allowedIps)) {
        throw new UnauthorizedException('X-Admin-Key not allowed from this IP');
      }
      return true;
    }

    const prod =
      process.env.NODE_ENV === 'production' ||
      this.config.get('tatum.useKms') === true;
    if (prod) {
      throw new UnauthorizedException(
        'ADMIN_API_KEYS / ADMIN_API_KEY_HASHES not configured — admin endpoints disabled in production',
      );
    }
    if (!this.warned) {
      this.warned = true;
      this.logger.warn(
        'ADMIN_API_KEYS/ADMIN_API_KEY_HASHES unset — admin endpoints gated only by service key. Set it before production.',
      );
    }
    return true;
  }
}
