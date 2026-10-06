import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { createHmac } from 'crypto';
import { LessThanOrEqual, Repository } from 'typeorm';
import { Transaction } from '../../database/entities/transaction.entity';
import { OutboundEvent } from '../../database/entities/outbound-event.entity';
import { Wallet } from '../../database/entities/wallet.entity';
import { ClientsService, WebhookRoute } from '../../common/clients.service';
import { errMsg } from '../../common/errors';

/** ~4h of exponential retries (1,2,4,8…128 min) before dead-lettering. */
const MAX_ATTEMPTS = 8;

/**
 * Outbound notifier — transactional outbox for events owed to an
 * integrating app. Every event is persisted BEFORE delivery is attempted,
 * then retried by a cron sweep with exponential backoff. A consumer that is
 * down no longer loses deposit confirmations — the worst case is delay.
 *
 * Routing is per-tenant: the event's wallet.appId selects the client's
 * webhookUrl/webhookSecret from API_CLIENTS. App A's deposits never reach
 * app B's server. Events with no wallet context (ops alerts) go to the
 * global MAIN_APP_WEBHOOK_URL channel.
 *
 * Payloads are HMAC-SHA256 signed (X-Webhook-Signature) so the consumer can
 * verify authenticity. Consumers MUST be idempotent: events may be delivered
 * more than once if a response is lost after processing.
 */
@Injectable()
export class NotifierService {
  private readonly logger = new Logger(NotifierService.name);

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(OutboundEvent)
    private readonly outbox: Repository<OutboundEvent>,
    @InjectRepository(Wallet)
    private readonly wallets: Repository<Wallet>,
    private readonly clients: ClientsService,
  ) {}

  /** Persist the event, then attempt immediate delivery. */
  async notify(event: string, tx: Transaction): Promise<void> {
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
    const row = await this.enqueue(event, body, tx.id, await this.appIdFor(tx));
    if (!row) return;
    await this.deliver(row);
  }

  /**
   * Non-transaction events (reconciliation divergence, ops alerts) — same
   * outbox durability, arbitrary payload. No appId → global env channel.
   */
  async notifyEvent(event: string, data: Record<string, unknown>): Promise<void> {
    const row = await this.enqueue(event, { event, data }, undefined);
    if (!row) return;
    await this.deliver(row);
  }

  /**
   * tx.wallet may be a loaded entity or just { id } depending on the call
   * site — fall back to a fetch so routing never silently defaults.
   */
  private async appIdFor(tx: Transaction): Promise<string | undefined> {
    if (tx.wallet?.appId) return tx.wallet.appId;
    if (!tx.wallet?.id) return undefined;
    const w = await this.wallets.findOne({ where: { id: tx.wallet.id } });
    return w?.appId;
  }

  private async enqueue(
    event: string,
    payload: object,
    transactionId?: string,
    appId?: string,
  ): Promise<OutboundEvent | null> {
    const row = await this.outbox.save(
      this.outbox.create({
        event,
        transactionId: transactionId ?? null,
        appId: appId ?? null,
        payload,
      }),
    );
    if (!(await this.routeFor(row.appId)).url) {
      // No consumer configured (local dev) — leave pending; the sweep would
      // burn attempts pointlessly. Mark sent so the outbox stays clean.
      await this.outbox.update(row.id, { status: 'sent', sentAt: new Date() });
      return null;
    }
    return row;
  }

  /** Retry sweep — picks up pending events past their backoff gate. */
  @Cron('* * * * *')
  async sweep(): Promise<void> {
    const due = await this.outbox.find({
      where: { status: 'pending', nextAttemptAt: LessThanOrEqual(new Date()) },
      order: { createdAt: 'ASC' },
      take: 50,
    });
    for (const row of due) await this.deliver(row);
  }

  private routeFor(appId: string | null | undefined): Promise<WebhookRoute> {
    return this.clients.routeFor(appId);
  }

  private async deliver(row: OutboundEvent): Promise<void> {
    const { url, secret } = await this.routeFor(row.appId);
    if (!url) return;
    const raw = JSON.stringify(row.payload);
    const signature = createHmac('sha256', secret).update(raw).digest('hex');
    try {
      await axios.post(url, raw, {
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `sha256=${signature}`,
          'X-Webhook-Event-Id': row.id,
        },
        timeout: 10_000,
      });
      await this.outbox.update(row.id, { status: 'sent', sentAt: new Date() });
    } catch (e) {
      const attempts = row.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await this.outbox.update(row.id, {
        attempts,
        status: dead ? 'dead' : 'pending',
        lastError: errMsg(e).slice(0, 2000),
        nextAttemptAt: new Date(Date.now() + 2 ** attempts * 60_000),
      });
      if (dead) {
        this.logger.error(
          `Outbound event ${row.id} dead-lettered after ${attempts} attempts: ${errMsg(e)}`,
        );
      } else {
        this.logger.warn(
          `Outbound event ${row.id} attempt ${attempts}/${MAX_ATTEMPTS} failed: ${errMsg(e)}`,
        );
      }
    }
  }
}
