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
 * endpoints therefore require an admin key when configured.
 *
 * Client-side hashing (client requirement): callers send the hex SHA-256
 * DIGEST of their key, compared directly to ADMIN_API_KEY_HASHES — or to
 * sha256() of each raw key in ADMIN_API_KEYS. Consequence: the digest IS
 * the credential and is replayable if .env leaks — the theft bound lives
 * in ADMIN_ALLOWED_IPS + rotation, not in at-rest secrecy.
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
      // Callers present the hex digest itself — one constant-time compare
      // against stored digests (plus sha256 of any raw env keys).
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
        .map((h) => Buffer.from(h.toLowerCase(), 'hex'));
      for (const raw of adminKeys) {
        digests.push(createHash('sha256').update(raw).digest());
      }
      const provided = /^[0-9a-f]{64}$/i.test(key)
        ? Buffer.from(key.toLowerCase(), 'hex')
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
