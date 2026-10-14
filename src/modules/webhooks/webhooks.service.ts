import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectEntityManager, InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { EntityManager, Like, Not, Repository } from 'typeorm';
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
import { errCode, errMsg } from '../../common/errors';
import { AssetDef, getAsset } from '../../config/assets';

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
export class WebhooksService implements OnApplicationBootstrap {
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

  /**
   * Tatum only sends x-payload-hash after the API key opts in — self-enroll
   * at boot when a secret is configured. Failure is logged loudly: the
   * controller fails closed and unsigned events get 401s either way.
   */
  async onApplicationBootstrap(): Promise<void> {
    const secret = this.config.get<string>('tatum.webhookHmacSecret');
    if (!secret) return;
    try {
      await this.provider.enableWebhookHmac?.(secret);
      this.logger.log('Webhook HMAC enrolled — x-payload-hash required');
    } catch (e) {
      this.logger.error(
        `Webhook HMAC enrollment failed: ${errMsg(e)} — unsigned events will be rejected`,
      );
    }
  }

  async handleTatumEvent(payload: TatumAddressEvent): Promise<{ status: string }> {
    const key = `${payload.txId}:${payload.address}:${payload.asset}`;
    const inserted = await this.events
      .createQueryBuilder()
      .insert()
      .into(WebhookEvent)
      .values({ provider: 'tatum', externalEventKey: key, payload: payload as any })
      .orIgnore()
      .execute();

    // Under orIgnore a conflicted insert returns identifiers:[null] — NOT
    // an empty array — so identifiers.length can't detect the replay.
    // `raw` is the RETURNING result: empty iff the row already existed.
    if (inserted.raw.length === 0) {
      return { status: 'duplicate' }; // replay — acknowledged, not reprocessed
    }

    try {
      const result = await this.process(payload);
      if (result.status === 'deferred') {
        // Tx not yet indexed — stay 'received' so the sweeper reprocesses;
        // marking 'processed' permanently drops the event.
        return result;
      }
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
    // An address may be watched for several assets (wrong-asset recovery
    // watches every same-chain asset). findOne picks an arbitrary row —
    // resolve against EACH candidate; the asset whose outputs verify wins.
    const deps = await this.addresses.find({
      where: { address: payload.address },
      relations: ['account', 'account.wallet'],
    });
    if (!deps.length) {
      this.logger.warn(`Event for unknown address ${payload.address}`);
      return { status: 'unknown_address' };
    }

    for (const dep of deps) {
      const result = await this.processForAsset(dep, payload);
      if (result !== 'skip') return { status: result };
    }
    // Shared-custody rows (SOL) skip on memo mismatch — a tx that DOES pay
    // the address but carried no usable memo is a real deposit; record it
    // unattributed for ops review rather than calling it spoofed.
    if (deps.some((d) => d.account?.memo)) {
      const status = await this.recordUnattributed(deps, payload);
      if (status) return { status };
    }
    // Every watched asset failed output verification — not one of ours
    // (or token normalization can't see it). Log loudly; don't credit.
    this.logger.error(
      `tx ${payload.txId} does not pay ${payload.address} — possible spoofed webhook`,
    );
    return { status: 'rejected' };
  }

  /**
   * A verified inbound tx to a shared-custody address whose memo matched
   * no watched wallet. Recorded with wallet:NULL for the ops credit queue
   * — funds are never guessed, never silently dropped. Returns a status
   * string when it recorded (or deduped) the deposit, null when the tx
   * doesn't actually pay the address under any watched asset's lens.
   */
  private async recordUnattributed(
    deps: DepositAddress[],
    payload: TatumAddressEvent,
  ): Promise<string | null> {
    for (const dep of deps) {
      const asset = getAsset(dep.asset);
      if (!asset) continue;
      const chainTx = await this.provider.getTransaction(
        payload.txId, dep.chain as any, asset,
      );
      if (!chainTx || chainTx.status === 'failed') continue;
      const inbound = chainTx.outputs
        .filter((o) => o.address === payload.address)
        .reduce((s, o) => s + parseFloat(o.amount), 0);
      if (inbound <= 0) continue;
      try {
        const tx = await this.em.transaction(async (m) => {
          const dup = await m.findOne(Transaction, {
            where: {
              txid: payload.txId, address: payload.address,
              asset: asset.code, direction: 'inbound',
            },
          });
          if (dup) return null;
          return m.save(
            m.create(Transaction, {
              wallet: null,
              direction: 'inbound',
              chain: dep.chain,
              asset: asset.code,
              txid: payload.txId,
              address: payload.address,
              amount: inbound.toFixed(asset.decimals),
              status: 'confirmed',
              confirmations: chainTx.confirmations ?? 0,
              requiredConfirmations: this.requiredConfirmations(dep.chain),
              blockNumber: chainTx.blockNumber ?? null,
              raw: {
                detectedVia: 'webhook',
                memo: chainTx.memo ?? null,
                unattributed: true,
              },
            }),
          );
        });
        if (!tx) return 'duplicate';
        await this.notifier.notifyEvent('deposit.unattributed', {
          transactionId: tx.id,
          txid: tx.txid,
          address: tx.address,
          chain: tx.chain,
          asset: tx.asset,
          amount: tx.amount,
          memo: chainTx.memo ?? null,
        });
        return 'unattributed';
      } catch (e) {
        if (errCode(e) === '23505') return 'duplicate';
        throw e;
      }
    }
    return null;
  }

  private async processForAsset(
    dep: DepositAddress,
    payload: TatumAddressEvent,
  ): Promise<string> {
    // VERIFY, don't trust: pull the real tx from the provider.
    const asset = getAsset(dep.asset);
    if (!asset) return 'skip';
    const chainTx = await this.provider.getTransaction(payload.txId, dep.chain as any, asset);
    if (!chainTx) {
      this.logger.warn(`tx ${payload.txId} not yet visible on ${dep.chain} — will retry via sweep`);
      return 'deferred';
    }
    // Refine confirmations from chain tip (provider may only report "mined").
    if (chainTx.blockNumber != null) {
      try {
        const head = await this.provider.getLatestBlock(dep.chain as any);
        if (head > 0) {
          chainTx.confirmations = Math.max(0, head - chainTx.blockNumber + 1);
        }
      } catch { /* keep provider-reported count */ }
    }
    // Shared-custody attribution (SOL): this row's account memo must match
    // the tx's Memo instruction — the shared address alone proves nothing.
    // A mismatch isn't rejection, just "not this wallet": the row whose
    // memo matches still gets its turn; none matching → unattributed path.
    if (dep.account?.memo && chainTx.memo !== dep.account.memo) return 'skip';
    const output = chainTx.outputs.find(
      (o) => o.address.toLowerCase() === payload.address.toLowerCase(),
    );
    if (!output) return 'skip'; // not this asset — try the next watched row

    const required = this.requiredConfirmations(dep.chain);
    const confirmed = chainTx.confirmations >= required;

    const tx = await this.em.transaction(async (m) => {
      const res = await this.upsertTransaction(
        m, dep, payload, output.amount, chainTx, required, confirmed, asset,
      );
      if (res.credit) {
        await this.ledger.postEntry(
          m, dep.account.wallet, res.tx, 'deposit_confirmed', output.amount, 'credit',
        );
        await this.bumpCredited(m, dep, output.amount);
      }
      return res;
    });

    if (!tx.suppressNotify) {
      await this.notifier.notify(
        tx.tx.status === 'confirmed' ? 'deposit.confirmed' : 'deposit.pending',
        tx.tx,
      );
    }
    return tx.tx.status === 'confirmed' ? 'credited' : 'pending_confirmations';
  }

  /**
   * Advance the deposit-address credited baseline for funds credited by a
   * NON-poller path. The delta scan computes `observed - creditedAmount` —
   * a webhook or manual credit that skips this gets re-detected next poll
   * and mints a second credit under a synthetic poll:* txid (seen live:
   * a TRX deposit credited once by webhook and again by the poller).
   * Shared-custody rows are skipped: the delta path never reads them.
   */
  private async bumpCredited(
    m: EntityManager,
    dep: DepositAddress,
    amount: string,
  ): Promise<void> {
    if (dep.account?.baseAddress) return;
    await m.increment(
      DepositAddress, { id: dep.id }, 'creditedAmount', parseFloat(amount),
    );
  }

  /**
   * Dedupe order for an inbound deposit on a dedicated address:
   *  1. exact real-txid row — advance confirmations (idempotent redelivery)
   *  2. synthetic poll:* sibling with the SAME amount — the delta path
   *     already credited (or is tracking) these funds; rekey it to the
   *     real txid so one physical deposit keeps ONE row. The ledger entry
   *     stays attached to the row — adopting a confirmed row posts nothing.
   *  3. baseline headroom — a confirmed-but-mismatched synthetic row means
   *     this tx may sit inside a multi-tx delta credit. Credit only if the
   *     chain balance exceeds creditedAmount by at least this tx's amount;
   *     otherwise record it confirmed-without-credit (coveredByBaseline).
   */
  private async upsertTransaction(
    m: EntityManager,
    dep: DepositAddress,
    payload: TatumAddressEvent,
    amount: string,
    chainTx: { confirmations: number; blockNumber: number | null; raw: any },
    required: number,
    confirmed: boolean,
    asset: AssetDef,
  ): Promise<{ tx: Transaction; credit: boolean; suppressNotify?: boolean }> {
    const existing = await m.findOne(Transaction, {
      // direction:'inbound' — same txid can exist as outbound when a send
      // lands on our own watched address; don't swallow the deposit row.
      where: { txid: payload.txId, address: dep.address, asset: dep.asset, direction: 'inbound' },
    });
    if (existing) {
      // Credit exactly on the pending→confirmed transition: first delivery
      // records pending, the confirming redelivery posts the entry once.
      // Confirmed→confirmed redeliveries must NOT re-post (the old code
      // double-credited there — event-key dedup was the only thing saving
      // it). Confirmed→pending (reorg) also skips — reverifyRecent owns
      // reversals.
      if (existing.status === 'superseded') {
        // Tombstone: the row already yielded its txid to a credited
        // sibling — a redelivery must not resurrect or re-credit it.
        return { tx: existing, credit: false, suppressNotify: true };
      }
      const wasPending = existing.status === 'pending';
      existing.confirmations = chainTx.confirmations;
      existing.blockNumber = chainTx.blockNumber;
      if (confirmed && wasPending) {
        // While this row waited for confirmations the delta path may have
        // credited the same funds under a synthetic poll:* txid — verify
        // coverage before posting.
        const coverage = await this.resolveCoverage(
          m, dep, !!dep.account?.baseAddress,
          {
            txid: payload.txId, address: dep.address, asset: dep.asset,
            amount, confirmations: chainTx.confirmations,
            blockNumber: chainTx.blockNumber,
          },
          existing, asset, confirmed,
        );
        if (coverage.action === 'retry') {
          await m.save(existing); // stays pending — sweep re-evaluates
          return { tx: existing, credit: false, suppressNotify: true };
        }
        if (coverage.action !== 'credit') {
          // 'adopted' → synthetic sibling rekeyed, this row superseded;
          // 'covered' → funds already inside the baseline.
          if (coverage.action === 'covered') {
            existing.status = 'confirmed';
            existing.raw = { ...(existing.raw as any), coveredByBaseline: true };
          }
          return { tx: await m.save(existing), credit: false, suppressNotify: true };
        }
        existing.status = 'confirmed';
        return { tx: await m.save(existing), credit: true };
      }
      // Any other redelivery is a no-transition refresh — only confs/block
      // advanced. Re-notifying deposit.confirmed on every Tatum retry reads
      // as a second deposit downstream (observed: replaying a real txid
      // emitted a phantom deposit.confirmed for an internal self-transfer).
      existing.status = confirmed ? 'confirmed' : 'pending';
      return { tx: await m.save(existing), credit: false, suppressNotify: true };
    }

    const coverage = await this.resolveCoverage(
      m, dep, !!dep.account?.baseAddress,
      {
        txid: payload.txId, address: dep.address, asset: dep.asset,
        amount, confirmations: chainTx.confirmations, blockNumber: chainTx.blockNumber,
      },
      null, asset, confirmed,
    );
    if (coverage.action === 'adopted' || coverage.action === 'adopted-credit') {
      return {
        tx: coverage.row!,
        credit: coverage.action === 'adopted-credit',
      };
    }
    if (coverage.action === 'retry' || coverage.action === 'covered') {
      const t = await m.save(
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
          status: coverage.action === 'covered' ? 'confirmed' : 'pending',
          reference: dep.reference,
          raw: coverage.action === 'covered'
            ? { ...chainTx.raw, coveredByBaseline: true, detectedVia: 'webhook' }
            : chainTx.raw,
        }),
      );
      if (coverage.action === 'covered') {
        // No client notification: deposit.confirmed already fired when the
        // delta credit posted — a second one implies money that didn't move.
        this.logger.warn(
          `tx ${payload.txId}→${dep.address} is inside the credited baseline — recorded without a second credit`,
        );
        return { tx: t, credit: false, suppressNotify: true };
      }
      return { tx: t, credit: false };
    }

    const t = await m.save(
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
    return { tx: t, credit: confirmed };
  }

  /**
   * Before crediting a real-txid deposit, decide whether its funds are
   * already inside the address's credited baseline. The delta path credits
   * balance growth under synthetic `poll:{addr}:{asset}:{balance}` txids —
   * a webhook arriving on the same funds must merge, not double-book.
   *
   *   adopted        — a CONFIRMED synthetic sibling of equal amount gets
   *                    rekeyed to the real txid (its credit stands); a
   *                    pendingRow holding the txid yields it via rename.
   *   adopted-credit — a PENDING synthetic sibling is rekeyed and the
   *                    caller posts the credit it never made.
   *   covered        — no matching sibling, but the baseline already
   *                    includes this amount (multi-tx delta windows);
   *                    record confirmed-without-credit.
   *   retry          — baseline unreadable; keep pending, sweep retries.
   *   credit         — genuinely new money; caller posts + bumps baseline.
   */
  private async resolveCoverage(
    m: EntityManager,
    dep: DepositAddress | null,
    sharedCustody: boolean | undefined,
    cand: {
      txid: string; address: string; asset: string; amount: string;
      confirmations: number; blockNumber: number | null;
    },
    pendingRow: Transaction | null,
    asset: AssetDef,
    confirmed: boolean,
  ): Promise<{
    action: 'adopted' | 'adopted-credit' | 'covered' | 'retry' | 'credit';
    row?: Transaction;
  }> {
    const sib = await m.findOne(Transaction, {
      where: {
        address: cand.address,
        asset: cand.asset,
        direction: 'inbound',
        txid: Like('poll:%'),
      },
      order: { createdAt: 'ASC' },
    });
    if (
      sib &&
      Math.abs(parseFloat(sib.amount) - parseFloat(cand.amount)) < 1e-8
    ) {
      if (sib.status === 'pending') {
        // Pending placeholders never posted a credit — supersede rather
        // than rekey when the real row already carries the txid.
        if (pendingRow) {
          sib.status = 'superseded';
          sib.txid = `superseded:${sib.txid}`;
          await m.save(sib);
          return { action: 'credit' };
        }
        sib.txid = cand.txid;
        sib.confirmations = cand.confirmations;
        sib.blockNumber = cand.blockNumber;
        sib.status = confirmed ? 'confirmed' : 'pending';
        return {
          action: confirmed ? 'adopted-credit' : 'adopted',
          row: await m.save(sib),
        };
      }
      // Confirmed synthetic sibling holds the credit — the real txid gets
      // the label, not a second credit. If a pending real row already owns
      // the txid it must release it for the rekey to fit the unique key.
      if (pendingRow) {
        pendingRow.txid = `superseded:${pendingRow.txid}`;
        pendingRow.status = 'superseded';
        await m.save(pendingRow);
      }
      sib.txid = cand.txid;
      sib.confirmations = cand.confirmations;
      sib.blockNumber = cand.blockNumber;
      return { action: 'adopted', row: await m.save(sib) };
    }

    if (dep && !sharedCustody) {
      try {
        const observed = await this.provider.getAddressBalance(dep.address, asset);
        const fresh = await m.findOne(DepositAddress, {
          where: { id: dep.id },
          select: ['creditedAmount'],
          lock: { mode: 'pessimistic_write' },
        });
        const headroom =
          parseFloat(observed) - parseFloat(fresh?.creditedAmount ?? '0');
        if (headroom < parseFloat(cand.amount) - 1e-8) {
          return { action: 'covered' };
        }
      } catch (e) {
        this.logger.warn(
          `Baseline check failed for ${cand.address} tx ${cand.txid}: ${errMsg(e)} — deferring`,
        );
        return { action: 'retry' };
      }
    }
    return { action: 'credit' };
  }

  /**
   * Fallback sweeper — the safety net for webhook failures. Periodically
   * re-fetches pending inbound transactions and confirms/credits them.
   * This is what makes missed webhooks non-fatal.
   */
  @Cron('*/2 * * * *')
  async sweepPending(): Promise<void> {
    // Reprocess deferred/failed webhook events — the provider can lag behind
    // its own webhook delivery. 'received' stays eligible until processed;
    // 'failed' retries until attempts hit the cap (then it stays failed and
    // is visible for manual review rather than silently looping forever).
    const retryable = await this.events.find({
      where: [
        { provider: 'tatum', status: 'received' },
        { provider: 'tatum', status: 'failed' },
      ],
      take: 50,
    });
    for (const ev of retryable) {
      if (ev.attempts >= 10) continue;
      await this.events.update(ev.id, { attempts: ev.attempts + 1 });
      try {
        const result = await this.process(ev.payload as any);
        if (result.status === 'deferred') continue;
        await this.events.update(ev.id, {
          status: 'processed', processedAt: new Date(), error: null as any,
        });
      } catch (e) {
        await this.events.update(ev.id, { status: 'failed', error: errMsg(e) });
      }
    }

    const pending = await this.txs.find({
      where: {
        direction: 'inbound',
        status: 'pending',
        // 'poll:*' txids are poller-owned placeholders for unattributed
        // balance deltas — getTransaction() can never resolve them (the
        // provider 400s on the non-hash), and the poller swaps in the
        // real txid once attribution resolves.
        txid: Not(Like('poll:%')),
      },
      relations: ['wallet'],
      take: 200,
    });
    for (const tx of pending) {
      try {
        const asset = getAsset(tx.asset);
        const chainTx = await this.provider.getTransaction(tx.txid, tx.chain as any, asset);
        if (!chainTx) continue;
        if (chainTx.blockNumber != null) {
          try {
            const head = await this.provider.getLatestBlock(tx.chain as any);
            if (head > 0) {
              chainTx.confirmations = Math.max(0, head - chainTx.blockNumber + 1);
            }
          } catch { /* keep provider-reported count */ }
        }
        const required = tx.requiredConfirmations || this.requiredConfirmations(tx.chain);
        if (chainTx.confirmations < required) {
          tx.confirmations = chainTx.confirmations;
          await this.txs.save(tx);
          continue;
        }
        const outcome = await this.em.transaction(async (m) => {
          const out = chainTx.outputs.find(
            (o) => o.address.toLowerCase() === tx.address.toLowerCase(),
          );
          const amt = out?.amount ?? tx.amount;

          // Lock the baseline row (no join — FOR UPDATE can't hit nullable
          // outer-join sides); account is immutable, load it separately.
          const dep = await m.findOne(DepositAddress, {
            where: { address: tx.address, asset: tx.asset },
            loadRelationIds: true,
            lock: { mode: 'pessimistic_write' },
          });
          const depAccountId = (dep?.account as unknown as { id: string })?.id;
          const depAccount = depAccountId
            ? await m.findOne(WalletAccount, { where: { id: depAccountId } })
            : null;

          // While this row sat pending the delta path may have credited
          // the same funds under a synthetic poll:* txid — resolveCoverage
          // merges, defers, or clears the credit decision.
          const coverage = await this.resolveCoverage(
            m, dep, !!depAccount?.baseAddress,
            {
              txid: tx.txid, address: tx.address, asset: tx.asset,
              amount: amt, confirmations: chainTx.confirmations,
              blockNumber: chainTx.blockNumber,
            },
            tx, asset, true,
          );
          if (coverage.action === 'retry') return 'retry';
          if (coverage.action === 'adopted') return 'superseded';
          if (coverage.action === 'covered') {
            tx.confirmations = chainTx.confirmations;
            tx.status = 'confirmed';
            tx.blockNumber = chainTx.blockNumber;
            tx.raw = { ...(tx.raw as any), coveredByBaseline: true };
            await m.save(tx);
            return 'covered';
          }

          tx.confirmations = chainTx.confirmations;
          tx.status = 'confirmed';
          tx.blockNumber = chainTx.blockNumber;
          await m.save(tx);
          await this.ledger.postEntry(
            m, tx.wallet, tx, 'deposit_confirmed', amt, 'credit',
          );
          if (dep) await this.bumpCredited(m, dep, amt);
          return 'credited';
        });
        if (outcome === 'credited') {
          await this.notifier.notify('deposit.confirmed', tx);
        }
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
