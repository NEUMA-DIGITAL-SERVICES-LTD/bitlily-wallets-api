import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createHmac } from 'crypto';
import { Transaction } from '../../database/entities/transaction.entity';

/**
 * Outbound notifier — pushes confirmed events to the main Bitlily app.
 * Payloads are HMAC-SHA256 signed (X-Webhook-Signature) so the main app can
 * verify authenticity. Retries are the caller's concern for now — events are
 * persisted (webhook_events / transactions) so a retry sweep can replay them.
 */
@Injectable()
export class NotifierService {
  private readonly logger = new Logger(NotifierService.name);
  private readonly url: string;
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.url = config.get('webhook.mainAppUrl') ?? '';
    this.secret = config.get('webhook.signingSecret') ?? '';
  }

  async notify(event: string, tx: Transaction): Promise<void> {
    if (!this.url) return;
    const body = {
      event,
      data: {
        transactionId: tx.id,
        walletId: tx.wallet?.id,
        direction: tx.direction,
        asset: tx.asset,
        chain: tx.chain,
        txid: tx.txid,
        address: tx.address,
        amount: tx.amount,
        status: tx.status,
        confirmations: tx.confirmations,
        reference: tx.reference,
      },
    };
    const raw = JSON.stringify(body);
    const signature = createHmac('sha256', this.secret).update(raw).digest('hex');
    try {
      await axios.post(this.url, raw, {
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `sha256=${signature}`,
        },
        timeout: 10_000,
      });
    } catch (e) {
      this.logger.error(`Outbound webhook failed for tx ${tx.id}: ${e.message}`);
    }
  }
}
