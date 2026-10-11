import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectEntityManager, InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { EntityManager, Repository } from 'typeorm';
import { Transaction } from '../../database/entities/transaction.entity';
import { DepositAddress } from '../../database/entities/deposit-address.entity';
// DepositAddress is loaded via the EntityManager so bumps share the
// poller's row lock — imported for the m.find() calls in inflow accounting.
import { getAsset } from '../../config/assets';
import {
  BLOCKCHAIN_PROVIDER,
  BlockchainProvider,
} from '../../providers/provider.interface';
import { LedgerService } from '../../ledger/ledger.service';
import { NotifierService } from '../notifications/notifier.service';
import { errMsg } from '../../common/errors';

/**
 * Outbound transaction status sweeper.
 *
 * sendTransaction records status='pending' at broadcast time; nothing on the
 * happy path advances it. Without this job every payout would report
 * "pending" forever — a support-ticket generator for Bitlily's ops team.
 * Each tick re-fetches pending outbound txids, derives confirmations from
 * the chain tip, and marks confirmed once the threshold is met.
 *
 * Transactions broadcast but never visible on-chain (dropped, replaced)
 * are marked 'failed' after FAIL_AFTER_MS — conservative because provider
 * propagation can lag.
 */
const FAIL_AFTER_MS = 60 * 60 * 1000;
const KMS_STALL_MS = 10 * 60 * 1000;
/** Internal sends zombie-fail window — see flagStalledSignature. */
const INTERNAL_FAIL_MS = 60 * 60 * 1000;

@Injectable()
export class OutboundStatusService {
  private readonly logger = new Logger(OutboundStatusService.name);
  private running = false;

  constructor(
    @InjectRepository(Transaction)
    private readonly txs: Repository<Transaction>,
    @InjectEntityManager() private readonly em: EntityManager,
    @Inject(BLOCKCHAIN_PROVIDER) private readonly provider: BlockchainProvider,
    private readonly ledger: LedgerService,
    private readonly notifier: NotifierService,
    private readonly config: ConfigService,
  ) {}

  @Cron('*/2 * * * *')
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const pending = await this.txs.find({
        where: { direction: 'outbound', status: 'pending' },
        relations: ['wallet'],
        order: { createdAt: 'ASC' },
        take: 100,
      });
      for (const tx of pending) await this.refresh(tx);
    } finally {
      this.running = false;
    }
  }

  private async refresh(tx: Transaction): Promise<void> {
    // Synthetic txids are never on-chain. poll:* are inbound detections;
    // pending:* are outbound rows created before the real txid is known —
    // one that stays pending:* means the process died between debit-commit
    // and broadcast, OR between broadcast and the txid write. The second
    // case is dangerous: funds may have moved with no txid recorded.
    // We can't auto-resolve it without knowing what the provider actually
    // broadcast — so detect it and alert loudly, once.
    if (tx.txid?.startsWith('pending:')) {
      const kmsRequestId = (tx.raw as any)?.kmsRequestId;
      // KMS path: the send entered Tatum's pending-signature queue — ask
      // the provider for its status instead of alerting.
      if (kmsRequestId && this.provider.getPendingSignature) {
        try {
          const sig = await this.provider.getPendingSignature(kmsRequestId);
          if (sig?.txid) {
            tx.txid = sig.txid;
            tx.raw = { ...(tx.raw ?? {}), signingComplete: true };
            await this.txs.save(tx);
            await this.accountInternalInflow(tx);
            if (!this.isInternal(tx)) {
              await this.notifier.notify('withdrawal.broadcast', tx);
            }
            // Fall through below — next statement continues the refresh.
          } else if (sig?.status === 'failed' || sig === null) {
            // Daemon rejected/dropped the request — never broadcast.
            // Internal sends (sweeps, gas pumps) never debited the ledger —
            // a reversal credit on them would mint free balance.
            const internal = this.isInternal(tx);
            await this.em.transaction(async (m) => {
              await m.update(Transaction, tx.id, { status: 'failed' });
              if (!internal) {
                await this.ledger.postEntry(
                  m, tx.wallet, tx, 'withdrawal_reversal', tx.amount, 'credit',
                );
              }
            });
            if (internal) {
              await this.notifyInternal(tx, 'sweep.failed', 'KMS request rejected/dropped');
            } else {
              await this.notifier.notify('withdrawal.failed', tx);
            }
            this.logger.warn(
              `KMS request ${kmsRequestId} for tx ${tx.id} ` +
              `${sig === null ? 'not found' : 'rejected'} — ` +
              `${internal ? 'internal send failed' : 'debit reversed'}`,
            );
            return;
          }
          if (!tx.txid.startsWith('pending:')) {
            return this.refresh(tx); // got real txid — continue lifecycle
          }
          return this.flagStalledSignature(tx, kmsRequestId);
        } catch (e) {
          this.logger.warn(`KMS status check failed for tx ${tx.id}: ${errMsg(e)}`);
          return;
        }
      }
      const stale = Date.now() - tx.createdAt.getTime() > 10 * 60 * 1000;
      const alerted = (tx.raw as any)?.reconcileAlerted === true;
      if (stale && !alerted) {
        tx.raw = { ...(tx.raw ?? {}), reconcileAlerted: true };
        await this.txs.save(tx);
        if (this.isInternal(tx)) {
          await this.notifyInternal(tx, 'sweep.stalled', 'placeholder txid never resolved');
        } else {
          await this.notifier.notify('withdrawal.reconcile_required', tx);
        }
        this.logger.error(
          `tx ${tx.id} has placeholder txid ${tx.txid} — crash between debit and ` +
          `broadcast suspected. RECONCILE MANUALLY: check chain for a ` +
          `${tx.asset} send to ${tx.address} of ${tx.amount} near ${tx.createdAt.toISOString()}.`,
        );
      }
      return;
    }
    if (!tx.txid || tx.txid.startsWith('poll:')) return;
    const asset = getAsset(tx.asset);
    try {
      const chainTx = await this.provider.getTransaction(
        tx.txid,
        tx.chain as any,
        asset,
      );
      if (!chainTx) {
        if (Date.now() - tx.createdAt.getTime() > FAIL_AFTER_MS) {
          tx.status = 'failed';
          await this.txs.save(tx);
          await this.unaccountInternalInflow(tx); // broadcast never landed
          if (this.isInternal(tx)) {
            await this.notifyInternal(tx, 'sweep.failed', 'never appeared on-chain');
          } else {
            await this.notifier.notify('withdrawal.failed', tx);
          }
          this.logger.warn(`tx ${tx.id} (${tx.txid}) never appeared on-chain — failed`);
        }
        return;
      }
      // Providers may only report "mined" (confirmations=1) — always refine
      // from the chain tip when a blockNumber is known, same as the
      // webhook path.
      if (chainTx.blockNumber != null) {
        try {
          const head = await this.provider.getLatestBlock(tx.chain as any);
          if (head > 0) {
            chainTx.confirmations = Math.max(0, head - chainTx.blockNumber + 1);
          }
        } catch { /* keep provider-reported value */ }
      }
      tx.confirmations = chainTx.confirmations;
      tx.blockNumber = chainTx.blockNumber;
      tx.fee = chainTx.fee ?? tx.fee;
      // First on-chain sighting — the send is real. Account its inflow to
      // watched addresses now, ahead of confirmation, so the deposit
      // poller never sees an unexplained delta.
      await this.accountInternalInflow(tx);
      const required = this.requiredConfirmations(tx.chain);
      tx.requiredConfirmations = required;
      if (chainTx.confirmations >= required && tx.status !== 'confirmed') {
        tx.status = 'confirmed';
        await this.txs.save(tx);
        if (!this.isInternal(tx)) {
          await this.notifier.notify('withdrawal.confirmed', tx);
        }
        this.logger.log(`tx ${tx.id} confirmed (${chainTx.confirmations} confs)`);
        return;
      }
      await this.txs.save(tx);
    } catch (e) {
      this.logger.warn(`Outbound refresh failed for tx ${tx.id}: ${errMsg(e)}`);
    }
  }

  /**
   * A KMS request still 'pending' past the stall window means the signing
   * daemon is down or the request expired chain-side (TRON serialized
   * payloads die after ~1 minute — a daemon outage longer than that
   * silently orphans them). User withdrawals only alert — the request may
   * still sign, and auto-failing risks a double-send.
   *
   * INTERNAL sends fail closed at INTERNAL_FAIL_MS instead: a zombie sweep
   * only ever moves OUR balance between OUR addresses, so the worst case
   * of the request signing late is a benign double-consolidation — while
   * leaving it pending pins the deposit address's in-flight guard forever.
   */
  private async flagStalledSignature(
    tx: Transaction,
    kmsRequestId: string,
  ): Promise<void> {
    const ageMs = Date.now() - tx.createdAt.getTime();
    if (ageMs <= KMS_STALL_MS) return;
    if (this.isInternal(tx) && ageMs > INTERNAL_FAIL_MS) {
      tx.status = 'failed';
      await this.txs.save(tx);
      await this.unaccountInternalInflow(tx);
      await this.notifyInternal(
        tx, 'sweep.failed', `KMS request unsigned >${INTERNAL_FAIL_MS / 60000}m — failed for retry`,
      );
      this.logger.warn(
        `Internal send ${tx.id} (${tx.reference}) unsigned ` +
        `>${INTERNAL_FAIL_MS / 60000}m — failed so consolidation can retry`,
      );
      return;
    }
    if ((tx.raw as any)?.kmsStallAlerted === true) return;
    tx.raw = { ...(tx.raw ?? {}), kmsStallAlerted: true };
    await this.txs.save(tx);
    if (this.isInternal(tx)) {
      await this.notifyInternal(tx, 'sweep.stalled', `KMS request unsigned >${KMS_STALL_MS / 60000}m`);
    } else {
      await this.notifier.notify('withdrawal.reconcile_required', tx);
    }
    this.logger.error(
      `tx ${tx.id} awaiting KMS signature >${KMS_STALL_MS / 60000}m ` +
      `(request ${kmsRequestId}) — signing daemon down or request expired. ` +
      `Check the tatum-kms container and Tatum's pending queue.`,
    );
  }

  /**
   * Internal sends (sweeps, gas pumps) are custody plumbing, not user
   * withdrawals — flagged `raw.internal` at record time.
   */
  private isInternal(tx: Transaction): boolean {
    return (tx.raw as any)?.internal != null;
  }

  /** Ops-channel alert for internal sends — never routed to the tenant. */
  private async notifyInternal(
    tx: Transaction,
    event: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.notifier.notifyEvent(event, {
        transactionId: tx.id,
        chain: tx.chain,
        asset: tx.asset,
        amount: tx.amount,
        address: tx.address,
        txid: tx.txid,
        reference: tx.reference,
        reason,
      });
    } catch (e) {
      this.logger.warn(`${event} notify failed: ${errMsg(e)}`);
    }
  }

  /**
   * When OUR send lands on a watched deposit address, the poller would
   * read the balance rise as an unexplained deposit delta and credit the
   * user treasury money — gas pumps make this happen routinely, and a
   * user withdrawing to their own deposit address would hit it too.
   * `creditedAmount` is a watermark of "balance already accounted for":
   * bump it by the send amount once the send is definitely on-chain
   * (real txid known), so detection nets to zero. Once-only via the
   * `inflowAccounted` flag; reversed if the broadcast never lands.
   */
  private async accountInternalInflow(tx: Transaction): Promise<void> {
    if ((tx.raw as any)?.inflowAccounted) return;
    const decimals = getAsset(tx.asset)?.decimals ?? 8;
    const bumped = await this.em.transaction(async (m) => {
      // Locked re-check inside the txn makes the flag claim atomic, and the
      // same lock the poller takes on dep rows prevents a lost update.
      const fresh = await m.findOne(Transaction, {
        where: { id: tx.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!fresh || (fresh.raw as any)?.inflowAccounted) return false;
      const deps = await m.find(DepositAddress, {
        where: { address: tx.address, asset: tx.asset },
        lock: { mode: 'pessimistic_write' },
      });
      if (deps.length === 0) return false;
      for (const dep of deps) {
        dep.creditedAmount = (
          parseFloat(dep.creditedAmount) + parseFloat(tx.amount)
        ).toFixed(decimals);
        await m.save(dep);
      }
      await m.update(Transaction, tx.id, {
        raw: { ...((fresh.raw as object) ?? {}), inflowAccounted: true },
      });
      return deps.length;
    });
    if (!bumped) return;
    tx.raw = { ...(tx.raw ?? {}), inflowAccounted: true };
    this.logger.log(
      `Accounted internal inflow ${tx.amount} ${tx.asset} → ${tx.address} ` +
      `(${bumped} watch row(s))`,
    );
  }

  /** Inverse of accountInternalInflow — the send never landed, so the
   *  watermark must give the amount back or deposits hide forever. */
  private async unaccountInternalInflow(tx: Transaction): Promise<void> {
    if (!(tx.raw as any)?.inflowAccounted) return;
    const decimals = getAsset(tx.asset)?.decimals ?? 8;
    await this.em.transaction(async (m) => {
      const deps = await m.find(DepositAddress, {
        where: { address: tx.address, asset: tx.asset },
        lock: { mode: 'pessimistic_write' },
      });
      for (const dep of deps) {
        dep.creditedAmount = Math.max(
          0,
          parseFloat(dep.creditedAmount) - parseFloat(tx.amount),
        ).toFixed(decimals);
        await m.save(dep);
      }
      const fresh = await m.findOne(Transaction, { where: { id: tx.id } });
      const raw = { ...((fresh?.raw as object) ?? {}) } as any;
      delete raw.inflowAccounted;
      await m.update(Transaction, tx.id, { raw });
    });
    delete (tx.raw as any).inflowAccounted;
  }

  private requiredConfirmations(chain: string): number {
    const map = this.config.get<Record<string, number>>('confirmations') ?? {};
    return map[chain] ?? 1;
  }
}
