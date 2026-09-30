import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../common/api-key.guard';
import { WebhooksService } from './webhooks.service';

/**
 * Provider webhook ingress — Public (no X-API-Key) since Tatum can't send it.
 * Security comes from verification-by-refetch inside the service, not from
 * trusting this endpoint. Consider IP-allowlisting Tatum egress IPs at the
 * load balancer as an additional layer.
 */
@ApiExcludeController()
@Controller('api/v1/webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Public()
  @Post('tatum')
  @HttpCode(200)
  async tatum(@Body() payload: Record<string, unknown>) {
    // Always 200 quickly — providers retry on non-2xx, and processing is
    // internally idempotent anyway. Heavy work belongs in the service.
    return this.webhooks.handleTatumEvent(payload as any);
  }
}
