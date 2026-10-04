import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Public } from '../../common/api-key.guard';
import { WebhooksService } from './webhooks.service';

/**
 * Provider webhook ingress — Public (no X-API-Key) since Tatum can't send
 * it. Two defenses:
 *  1. x-payload-hash (HMAC-SHA512 of the body, Base64) verified when
 *     TATUM_WEBHOOK_HMAC_SECRET is set — enabled per-API-key at boot.
 *  2. Verification-by-refetch inside the service — every event is pulled
 *     from the provider before it can move the ledger anyway.
 */
@ApiExcludeController()
@Controller('api/v1/webhooks')
export class WebhooksController {
  private readonly hmacSecret: string;

  constructor(
    private readonly webhooks: WebhooksService,
    config: ConfigService,
  ) {
    this.hmacSecret = config.get<string>('tatum.webhookHmacSecret') ?? '';
  }

  @Public()
  @Post('tatum')
  @HttpCode(200)
  async tatum(
    @Body() payload: Record<string, unknown>,
    @Headers('x-payload-hash') hash?: string,
  ) {
    if (this.hmacSecret) {
      // Fail closed: a configured secret means unsigned/invalid events are
      // rejected, not merely logged. JSON.stringify(req.body) is Tatum's
      // documented recipe — parse+restringify preserves their key order.
      const expected = createHmac('sha512', this.hmacSecret)
        .update(JSON.stringify(payload ?? {}))
        .digest('base64');
      const ok =
        !!hash &&
        hash.length === expected.length &&
        timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
      if (!ok) throw new UnauthorizedException('Invalid x-payload-hash');
    }
    return this.webhooks.handleTatumEvent(payload as any);
  }
}
