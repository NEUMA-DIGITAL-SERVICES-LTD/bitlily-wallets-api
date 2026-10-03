import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectEntityManager, InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { EntityManager, Repository, IsNull, MoreThan, Or } from 'typeorm';
import { DepositAddress } from '../../database/entities/deposit-address.entity';
import { Transaction } from '../../database/entities/transaction.entity';
import { AssetDef, getAsset } from '../../config/assets';
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

      // Reorg guard BEFORE delta math: re-verify recently-confirmed deposits
      // that carry a real txid. If one vanished or fell below the
      // confirmation threshold, reverse it — otherwise the balance drop
      // would just look like a withdrawal and the phantom credit stands.
      // Reverify may adjust creditedAmount — re-read before computing delta.
      await this.reverifyRecent(dep, asset);
      const { creditedAmount } = await this.addresses.findOneOrFail({
        where: { id: dep.id },
        select: ['creditedAmount'],
      });
      dep.creditedAmount = creditedAmount;

      const delta = parseFloat(observed) - parseFloat(dep.creditedAmount);
      if (delta < 0) {
        // Balance dropped below our credited baseline — funds left the
        // address (sweep, withdrawal). Rebaseline so the next deposit
        // credits its full amount instead of the shrunken delta.
        await this.addresses.update(dep.id, { creditedAmount: observed });
        this.logger.log(
          `Rebaselined ${dep.address} ${asset.code}: credited ${dep.creditedAmount} → ${observed}`,
        );
        return;
      }
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

      // Tatum's address-history entries carry blockNumber but NOT a
      // confirmations field — derive from chain tip (same as webhook path).
      if (hit?.blockNumber != null && !hit.confirmations) {
        try {
          const head = await this.provider.getLatestBlock(dep.chain as any);
          if (head > 0) hit.confirmations = Math.max(0, head - hit.blockNumber + 1);
        } catch { /* stays pending until derivable */ }
      }

      const txid = hit?.txid ?? `poll:${dep.address}:${asset.code}:${observed}`;
      const req = this.requiredConfirmations(dep.chain);
      const confirmed = hit ? hit.confirmations >= req : true;
      // Balance reads are post-confirmation for account chains; UTXO balance
      // may include mempool — when we have a real txid we keep the
      // confirmation policy, without one we credit (documented tradeoff).
      const reportConfs = hit?.confirmations ?? (confirmed ? req : 0);

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

        // A pending record from an earlier poll shares this txid — advance
        // its confirmation count instead of inserting a duplicate.
        // direction:'inbound' matters: an outbound send TO our own watched
        // address (self-transfer, consolidation) has the same on-chain txid —
        // without the filter it would swallow this deposit's credit.
        const existing = await m.findOne(Transaction, {
          where: { txid, address: dep.address, asset: asset.code, direction: 'inbound' },
        });
        if (existing) {
          existing.confirmations = reportConfs;
          existing.blockNumber = hit?.blockNumber ?? existing.blockNumber;
          if (existing.status === 'confirmed') {
            // Already credited — sync the marker or this delta re-detects
            // every poll forever (seen live: reactivated row whose tx had
            // confirmed while retired).
            if (parseFloat(fresh.creditedAmount) < parseFloat(observed)) {
              fresh.creditedAmount = observed;
              await m.save(fresh);
            }
            return m.save(existing);
          }
          if (confirmed) {
            existing.status = 'confirmed';
            // Credit only THIS tx's recorded amount; a newer uncredited
            // remainder re-detects on the next poll under a fresh txid.
            await this.ledger.postEntry(
              m, dep.account.wallet, existing, 'deposit_confirmed',
              existing.amount, 'credit',
            );
            fresh.creditedAmount =
              (parseFloat(fresh.creditedAmount) + parseFloat(existing.amount)).toFixed(8);
            await m.save(fresh);
          }
          return m.save(existing);
        }

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
            confirmations: reportConfs,
            requiredConfirmations: req,
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
        // The webhook path recorded this txid first (cross-strategy race).
        // Sync our delta marker so polling doesn't re-detect the same funds.
        await this.addresses.update(dep.id, { creditedAmount: observed });
      } else {
        this.logger.error(`Poll failed for ${dep.address}: ${errMsg(e)}`);
      }
    }
  }

  /**
   * Re-verify recently-confirmed deposits that carry a real (non-synthetic)
   * txid. Deposits still under the finality window are re-fetched; a tx that
   * disappeared or fell below the confirmation threshold gets status
   * 'reorged', a deposit_reversal ledger debit, and its amount removed from
   * the address's credited baseline. Synthetic poll:* entries can't be
   * re-verified this way — account-chain reorgs deep enough to matter are
   * rare; UTXO chains are where this guard earns its keep.
   */
  private async reverifyRecent(dep: DepositAddress, asset: AssetDef): Promise<void> {
    const req = this.requiredConfirmations(dep.chain);
    const finality = Math.max(req * 3, 6);
    const candidates = await this.txs.find({
      where: {
        address: dep.address,
        asset: asset.code,
        direction: 'inbound',
        status: 'confirmed',
      },
      order: { createdAt: 'DESC' },
      take: 50,
    });
    for (const t of candidates) {
      if (!t.txid || t.txid.includes(':')) continue; // synthetic — unverifiable
      if ((t.confirmations ?? 0) >= finality) continue; // past reorg horizon

      let chainTx = await this.provider
        .getTransaction(t.txid, dep.chain as any, asset as any)
        .catch(() => null);
      if (chainTx?.blockNumber != null) {
        try {
          const head = await this.provider.getLatestBlock(dep.chain as any);
          if (head > 0) chainTx.confirmations = Math.max(0, head - chainTx.blockNumber + 1);
        } catch { /* keep reported value */ }
      }
      if (chainTx && (chainTx.confirmations ?? 0) >= req) {
        if ((chainTx.confirmations ?? 0) !== t.confirmations) {
          await this.txs.update(t.id, { confirmations: chainTx.confirmations });
        }
        continue;
      }

      // Reorged or unverifiable — reverse it.
      await this.em.transaction(async (m) => {
        await m.update(Transaction, t.id, { status: 'reorged', confirmations: chainTx?.confirmations ?? 0 });
        await this.ledger.postEntry(
          m, dep.account.wallet, t, 'deposit_reversal', t.amount, 'debit',
        );
        const fresh = await m.findOne(DepositAddress, {
          where: { id: dep.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (fresh) {
          fresh.creditedAmount = Math.max(
            0, parseFloat(fresh.creditedAmount) - parseFloat(t.amount),
          ).toFixed(8);
          await m.save(fresh);
        }
      });
      await this.notifier.notify('deposit.reorged', t);
      this.logger.warn(
        `Deposit ${t.txid} on ${dep.address} reorged below ${req} confs — reversed ${t.amount} ${asset.code}`,
      );
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
