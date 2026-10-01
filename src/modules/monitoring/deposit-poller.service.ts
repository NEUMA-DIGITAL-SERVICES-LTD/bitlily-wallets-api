import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectEntityManager, InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { EntityManager, Repository, IsNull, MoreThan, Or } from 'typeorm';
import { DepositAddress } from '../../database/entities/deposit-address.entity';
import { Transaction } from '../../database/entities/transaction.entity';
import { getAsset } from '../../config/assets';
import {
  BLOCKCHAIN_PROVIDER,
  BlockchainProvider,
} from '../../providers/provider.interface';
import { LedgerService } from '../../ledger/ledger.service';
import { NotifierService } from '../notifications/notifier.service';
import { errCode, errMsg } from '../../common/errors';

/**
 * Credit-minimal deposit detection — the free-plan strategy.
 *
 * Instead of Tatum webhook subscriptions (50 credits/day each, burning even
 * when idle, plus a 100-notifications/month free cap), we poll balances of
 * active deposit addresses only. Cost is bounded: ~1–3 credits per call,
 * only while an address awaits payment. An order open 30 min at 2-min polls
 * ≈ 15–45 credits total; an unused address costs nothing.
 *
 * Idempotency: synthetic txid `poll:{address}:{asset}:{observedBalance}` —
 * re-polling the same balance hits the unique (txid,address,asset) gate and
 * is skipped; a new deposit produces a different observed balance → new row.
 * The authoritative dedupe is `credited_amount` updated in the same DB tx.
 */
@Injectable()
export class DepositPollerService {
  private readonly logger = new Logger(DepositPollerService.name);
  private running = false;

  constructor(
    @InjectRepository(DepositAddress)
    private readonly addresses: Repository<DepositAddress>,
    @InjectRepository(Transaction)
    private readonly txs: Repository<Transaction>,
    @InjectEntityManager() private readonly em: EntityManager,
    @Inject(BLOCKCHAIN_PROVIDER) private readonly provider: BlockchainProvider,
    private readonly ledger: LedgerService,
    private readonly notifier: NotifierService,
    private readonly config: ConfigService,
  ) {}

  @Cron('*/2 * * * *')
  async poll(): Promise<void> {
    if (this.config.get('detection.strategy') !== 'polling') return;
    if (this.running) return; // overlap guard
    this.running = true;
    try {
      const active = await this.addresses.find({
        where: {
          status: 'active',
          expiresAt: Or(IsNull(), MoreThan(new Date())),
        },
        relations: ['account', 'account.wallet'],
        take: 500,
      });
      for (const dep of active) await this.checkAddress(dep);
    } finally {
      this.running = false;
    }
  }

  private async checkAddress(dep: DepositAddress): Promise<void> {
    const asset = getAsset(dep.asset);
    if (!asset) return;
    let observed: string;
    try {
      observed = await this.provider.getAddressBalance(dep.address, asset);
      const delta = parseFloat(observed) - parseFloat(dep.creditedAmount);
      if (delta <= 0) return;

      // Best-effort txid attribution (UTXO chains expose address history).
      const candidates =
        (await this.provider.getAddressTransactions?.(dep.address, asset, 5)) ?? [];
      const hit = candidates.find((t) =>
        t.outputs.some(
          (o) =>
            o.address.toLowerCase() === dep.address.toLowerCase() &&
            Math.abs(parseFloat(o.amount) - delta) < 1e-8,
        ),
      );
      const txid = hit?.txid ?? `poll:${dep.address}:${asset.code}:${observed}`;
      const confirmed = hit ? this.isConfirmed(hit.confirmations, dep.chain) : true;
      // Balance reads are post-confirmation for account chains; UTXO balance
      // may include mempool — when we have a real txid we keep the
      // confirmation policy, without one we credit (documented tradeoff).

      const tx = await this.em.transaction(async (m) => {
        // Lock just this row (no join — FOR UPDATE can't hit nullable
        // outer-join sides on Postgres). Wallet/account refs are immutable
        // and already loaded on `dep`.
        const fresh = await m.findOne(DepositAddress, {
          where: { id: dep.id },
          lock: { mode: 'pessimistic_write' },
        });
        const freshDelta = parseFloat(observed) - parseFloat(fresh.creditedAmount);
        if (freshDelta <= 0) return null;

        const t = await m.save(
          m.create(Transaction, {
            wallet: dep.account.wallet,
            direction: 'inbound',
            chain: dep.chain,
            asset: dep.asset,
            txid,
            address: dep.address,
            amount: freshDelta.toFixed(8),
            status: confirmed ? 'confirmed' : 'pending',
            confirmations: hit?.confirmations ?? 0,
            requiredConfirmations: this.requiredConfirmations(dep.chain),
            blockNumber: hit?.blockNumber ?? null,
            reference: dep.reference,
            raw: { detectedVia: 'polling', observedBalance: observed },
          }),
        );
        if (confirmed) {
          await this.ledger.postEntry(
            m, dep.account.wallet, t, 'deposit_confirmed',
            freshDelta.toFixed(8), 'credit',
          );
          fresh.creditedAmount = observed;
          await m.save(fresh);
        }
        return t;
      });
      if (tx) await this.notifier.notify(
        confirmed ? 'deposit.confirmed' : 'deposit.pending', tx,
      );
    } catch (e) {
      if (errCode(e) === '23505') {
        // Already-detected tx (e.g. pending UTXO awaiting confirmations).
        // Advance creditedAmount so we stop re-detecting the same delta.
        await this.addresses.update(dep.id, { creditedAmount: observed });
      } else {
        this.logger.error(`Poll failed for ${dep.address}: ${errMsg(e)}`);
      }
    }
  }

  /** Retire addresses past their expiry — keeps the poll set bounded. */
  @Cron('*/10 * * * *')
  async retireExpired(): Promise<void> {
    if (this.config.get('detection.strategy') !== 'polling') return;
    await this.addresses
      .createQueryBuilder()
      .update()
      .set({ status: 'retired' })
      .where(`status = 'active' AND expires_at IS NOT NULL AND expires_at < now()`)
      .execute();
  }

  private isConfirmed(confirmations: number, chain: string): boolean {
    return confirmations >= this.requiredConfirmations(chain);
  }

  private requiredConfirmations(chain: string): number {
    const map = this.config.get<Record<string, number>>('confirmations') ?? {};
    return map[chain] ?? 1;
  }
}
