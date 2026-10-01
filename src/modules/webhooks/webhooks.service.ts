import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectEntityManager, InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { EntityManager, Repository } from 'typeorm';
import { WebhookEvent } from '../../database/entities/webhook-event.entity';
import { DepositAddress } from '../../database/entities/deposit-address.entity';
import { Transaction } from '../../database/entities/transaction.entity';
import { WalletAccount } from '../../database/entities/wallet-account.entity';
import {
  BLOCKCHAIN_PROVIDER,
  BlockchainProvider,
} from '../../providers/provider.interface';
import { LedgerService } from '../../ledger/ledger.service';
import { NotifierService } from '../notifications/notifier.service';
import { errMsg } from '../../common/errors';

interface TatumAddressEvent {
  address?: string;
  amount?: string;
  asset?: string;
  txId?: string;
  blockNumber?: number;
  counterAddress?: string;
  type?: string;
  subscriptionType?: string;
}

/**
 * Inbound webhook processing — the most security-sensitive path in the system.
 *
 * Rules that MUST hold:
 *  1. The webhook body is a hint, never proof. We re-fetch the transaction
 *     from the provider and verify outputs before recording anything.
 *  2. Crediting is idempotent at two gates: webhook_events(provider, key)
 *     and transactions(txid, address, asset) unique constraints.
 *  3. Credit only after required on-chain confirmations — first-seen events
 *     record a `pending` Transaction; the cron sweeper confirms them.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @InjectRepository(WebhookEvent) private readonly events: Repository<WebhookEvent>,
    @InjectRepository(DepositAddress) private readonly addresses: Repository<DepositAddress>,
    @InjectRepository(Transaction) private readonly txs: Repository<Transaction>,
    @InjectEntityManager() private readonly em: EntityManager,
    @Inject(BLOCKCHAIN_PROVIDER) private readonly provider: BlockchainProvider,
    private readonly ledger: LedgerService,
    private readonly notifier: NotifierService,
    private readonly config: ConfigService,
  ) {}

  async handleTatumEvent(payload: TatumAddressEvent): Promise<{ status: string }> {
    const key = `${payload.txId}:${payload.address}:${payload.asset}`;
    const inserted = await this.events
      .createQueryBuilder()
      .insert()
      .into(WebhookEvent)
      .values({ provider: 'tatum', externalEventKey: key, payload: payload as any })
      .orIgnore()
      .execute();

    if (inserted.identifiers.length === 0) {
      return { status: 'duplicate' }; // replay — acknowledged, not reprocessed
    }

    try {
      const result = await this.process(payload);
      await this.events.update(
        { provider: 'tatum', externalEventKey: key },
        { status: 'processed', processedAt: new Date() },
      );
      return result;
    } catch (e) {
      await this.events.update(
        { provider: 'tatum', externalEventKey: key },
        { status: 'failed', error: errMsg(e) },
      );
      throw e;
    }
  }

  private async process(payload: TatumAddressEvent): Promise<{ status: string }> {
    const dep = await this.addresses.findOne({
      where: { address: payload.address },
      relations: ['account', 'account.wallet'],
    });
    if (!dep) {
      this.logger.warn(`Event for unknown address ${payload.address}`);
      return { status: 'unknown_address' };
    }

    // VERIFY, don't trust: pull the real tx from the provider.
    const chainTx = await this.provider.getTransaction(payload.txId, dep.chain as any);
    if (!chainTx) {
      this.logger.warn(`tx ${payload.txId} not yet visible on ${dep.chain} — will retry via sweep`);
      return { status: 'deferred' };
    }
    const output = chainTx.outputs.find(
      (o) => o.address.toLowerCase() === payload.address.toLowerCase(),
    );
    if (!output) {
      this.logger.error(
        `tx ${payload.txId} does not pay ${payload.address} — possible spoofed webhook`,
      );
      return { status: 'rejected' };
    }

    const required = this.requiredConfirmations(dep.chain);
    const confirmed = chainTx.confirmations >= required;

    const tx = await this.em.transaction(async (m) => {
      const t = await this.upsertTransaction(m, dep, payload, output.amount, chainTx, required, confirmed);
      if (confirmed && t.status === 'confirmed') {
        await this.ledger.postEntry(
          m, dep.account.wallet, t, 'deposit_confirmed', output.amount, 'credit',
        );
      }
      return t;
    });

    await this.notifier.notify(
      confirmed ? 'deposit.confirmed' : 'deposit.pending',
      tx,
    );
    return { status: confirmed ? 'credited' : 'pending_confirmations' };
  }

  private async upsertTransaction(
    m: EntityManager,
    dep: DepositAddress,
    payload: TatumAddressEvent,
    amount: string,
    chainTx: { confirmations: number; blockNumber: number | null; raw: any },
    required: number,
    confirmed: boolean,
  ): Promise<Transaction> {
    const existing = await m.findOne(Transaction, {
      where: { txid: payload.txId, address: dep.address, asset: dep.asset },
    });
    if (existing) {
      // Update confirmation progress; a reorg can also un-confirm — reflect it.
      existing.confirmations = chainTx.confirmations;
      existing.status = confirmed ? 'confirmed' : 'pending';
      existing.blockNumber = chainTx.blockNumber;
      return m.save(existing);
    }
    return m.save(
      m.create(Transaction, {
        wallet: dep.account.wallet,
        direction: 'inbound',
        chain: dep.chain,
        asset: dep.asset,
        txid: payload.txId,
        address: dep.address,
        amount,
        confirmations: chainTx.confirmations,
        requiredConfirmations: required,
        blockNumber: chainTx.blockNumber,
        status: confirmed ? 'confirmed' : 'pending',
        reference: dep.reference,
        raw: chainTx.raw,
      }),
    );
  }

  /**
   * Fallback sweeper — the safety net for webhook failures. Periodically
   * re-fetches pending inbound transactions and confirms/credits them.
   * This is what makes missed webhooks non-fatal.
   */
  @Cron('*/2 * * * *')
  async sweepPending(): Promise<void> {
    const pending = await this.txs.find({
      where: { direction: 'inbound', status: 'pending' },
      relations: ['wallet'],
      take: 200,
    });
    for (const tx of pending) {
      try {
        const chainTx = await this.provider.getTransaction(tx.txid, tx.chain as any);
        if (!chainTx) continue;
        const required = tx.requiredConfirmations || this.requiredConfirmations(tx.chain);
        if (chainTx.confirmations < required) {
          tx.confirmations = chainTx.confirmations;
          await this.txs.save(tx);
          continue;
        }
        await this.em.transaction(async (m) => {
          tx.confirmations = chainTx.confirmations;
          tx.status = 'confirmed';
          tx.blockNumber = chainTx.blockNumber;
          await m.save(tx);
          const out = chainTx.outputs.find(
            (o) => o.address.toLowerCase() === tx.address.toLowerCase(),
          );
          await this.ledger.postEntry(
            m, tx.wallet, tx, 'deposit_confirmed', out?.amount ?? tx.amount, 'credit',
          );
        });
        await this.notifier.notify('deposit.confirmed', tx);
      } catch (e) {
        this.logger.error(`Sweep failed for tx ${tx.txid}: ${errMsg(e)}`);
      }
    }
  }

  private requiredConfirmations(chain: string): number {
    const map = this.config.get<Record<string, number>>('confirmations') ?? {};
    return map[chain] ?? 1;
  }
}
