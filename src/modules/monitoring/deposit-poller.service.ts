import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectEntityManager, InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { EntityManager, Like, Repository, IsNull, MoreThan, Or } from 'typeorm';
import { DepositAddress } from '../../database/entities/deposit-address.entity';
import { CustodyAccount } from '../../database/entities/custody-account.entity';
import { Transaction } from '../../database/entities/transaction.entity';
import { AssetDef, enabledAssets, getAsset } from '../../config/assets';
import {
  BLOCKCHAIN_PROVIDER,
  BlockchainProvider,
  ProviderTx,
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
  /** (address, asset) pairs already warn-logged as shared/unattributable. */
  private readonly sharedWarned = new Set<string>();
  /** Watch rows pointing at custody treasury/base addresses — warn once. */
  private readonly custodyWarned = new Set<string>();

  constructor(
    @InjectRepository(DepositAddress)
    private readonly addresses: Repository<DepositAddress>,
    @InjectRepository(Transaction)
    private readonly txs: Repository<Transaction>,
    @InjectRepository(CustodyAccount)
    private readonly custody: Repository<CustodyAccount>,
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
      const custodyRows = await this.custody.find();
      const custodyAddrs = new Set(
        custodyRows.flatMap((c) =>
          [c.treasuryAddress, c.baseAddress].filter(Boolean) as string[],
        ),
      );
      for (const dep of active) await this.checkAddress(dep, custodyAddrs);
      await this.scanSharedDeposits(custodyRows);
    } finally {
      this.running = false;
    }
  }

  /**
   * Shared-custody scan (SOL): the enrolled baseAddress serves EVERY wallet,
   * so balance deltas can't attribute deposits — inbound txs are enumerated
   * and the sender's Memo program instruction resolves the wallet (the
   * exchange destination-tag model). Deposits with a missing/unknown memo
   * are recorded unattributed (wallet: NULL) for the ops credit queue —
   * funds are never guessed and never silently dropped.
   *
   * Dedupe is (txid, address, asset, direction) — the same signature is
   * processed once even across poll cycles or a webhook/poller overlap.
   */
  private async scanSharedDeposits(custodyRows: CustodyAccount[]): Promise<void> {
    for (const c of custodyRows) {
      if (!c.baseAddress) continue;
      for (const a of enabledAssets().filter((a) => a.chain === c.chain)) {
        // getAsset() — not the raw registry entry — applies the testnet
        // contract swap. Without it the SPL mint filter matched the
        // MAINNET mint on a testnet deploy and silently found nothing.
        const asset = getAsset(a.code);
        if (!asset) continue;
        try {
          await this.scanSharedForAsset(c.baseAddress, c.chain, asset);
        } catch (e) {
          this.logger.error(
            `Shared-address scan failed for ${c.chain}/${asset.code}: ${errMsg(e)}`,
          );
        }
      }
    }
  }

  private async scanSharedForAsset(
    base: string,
    chain: string,
    asset: AssetDef,
  ): Promise<void> {
    const recent =
      (await this.provider.getAddressTransactions?.(base, asset, 25)) ?? [];
    if (!recent.length) return;
    const req = this.requiredConfirmations(chain);

    for (const cand of recent) {
      if (!cand.txid) continue;
      const seen = await this.txs.findOne({
        where: { txid: cand.txid, address: base, asset: asset.code, direction: 'inbound' },
        relations: ['wallet'],
      });
      if (seen) {
        // Advance an attributed row that was recorded below the
        // confirmation threshold — SOL reports finalized (32) on success
        // so this is rare, but the advance keeps semantics uniform.
        if (seen.status === 'pending' && seen.wallet) {
          await this.advanceShared(seen, asset, req);
        }
        continue;
      }

      const full = await this.provider.getTransaction(
        cand.txid, chain as any, asset,
      );
      if (!full || full.status === 'failed') continue;
      const inbound = full.outputs
        .filter((o) => o.address === base)
        .reduce((s, o) => s + parseFloat(o.amount), 0);
      if (inbound <= 0) continue;
      const confirmed = (full.confirmations ?? 0) >= req;
      const memo = full.memo?.trim() || null;

      // Exact-match only — never infer ownership from amount, timing, or
      // polling order. A memo that matches no active account (typo'd,
      // foreign system) takes the unattributed path like a missing one.
      const dep = memo
        ? await this.addresses.findOne({
            where: {
              address: base,
              asset: asset.code,
              status: 'active',
              account: { memo },
            },
            relations: ['account', 'account.wallet'],
          })
        : null;

      const tx = await this.em.transaction(async (m) => {
        const dup = await m.findOne(Transaction, {
          where: { txid: cand.txid, address: base, asset: asset.code, direction: 'inbound' },
        });
        if (dup) return null;
        const t = await m.save(
          m.create(Transaction, {
            wallet: dep?.account.wallet ?? null,
            direction: 'inbound',
            chain,
            asset: asset.code,
            txid: cand.txid,
            address: base,
            amount: inbound.toFixed(asset.decimals),
            status: !dep || confirmed ? 'confirmed' : 'pending',
            confirmations: full.confirmations ?? 0,
            requiredConfirmations: req,
            blockNumber: full.blockNumber ?? cand.blockNumber ?? null,
            raw: {
              detectedVia: 'memo-polling',
              memo,
              unattributed: !dep,
            },
          }),
        );
        if (dep && confirmed) {
          await this.ledger.postEntry(
            m, dep.account.wallet, t, 'deposit_confirmed', t.amount, 'credit',
          );
          // Keep the row's credited marker truthful — shared rows never
          // run delta detection, but the number should still mean
          // "how much this watch row has credited" wherever it is read.
          const fresh = await m.findOne(DepositAddress, {
            where: { id: dep.id },
            lock: { mode: 'pessimistic_write' },
          });
          fresh.creditedAmount =
            (parseFloat(fresh.creditedAmount) + inbound).toFixed(asset.decimals);
          await m.save(fresh);
        }
        return t;
      });
      if (!tx) continue; // webhook path or a racing poll recorded it first

      if (dep) {
        await this.notifier.notify(
          confirmed ? 'deposit.confirmed' : 'deposit.pending', tx,
        );
      } else {
        await this.notifier.notifyEvent('deposit.unattributed', {
          transactionId: tx.id,
          txid: tx.txid,
          address: base,
          chain,
          asset: asset.code,
          amount: tx.amount,
          memo,
        });
      }
    }
  }

  /** Confirmation-threshold advance for attributed shared-address rows —
   * same semantics as checkAddress's existing-row branch, minus the delta
   * machinery (shared rows have no per-wallet balance delta to compare). */
  private async advanceShared(
    seen: Transaction,
    asset: AssetDef,
    req: number,
  ): Promise<void> {
    const full = await this.provider.getTransaction(
      seen.txid, seen.chain as any, asset,
    );
    if (!full || full.status === 'failed') return;
    if ((full.confirmations ?? 0) < req) {
      await this.txs.update(seen.id, { confirmations: full.confirmations ?? 0 });
      return;
    }
    const credited = await this.em.transaction(async (m) => {
      // No join under FOR UPDATE (Postgres rejects locking nullable outer
      // sides) — loadRelationIds exposes the raw wallet_id instead.
      const fresh = await m.findOne(Transaction, {
        where: { id: seen.id },
        loadRelationIds: true,
        lock: { mode: 'pessimistic_write' },
      });
      if (!fresh || fresh.status !== 'pending' || !fresh.wallet) return null;
      fresh.status = 'confirmed';
      fresh.confirmations = full.confirmations!;
      fresh.blockNumber = full.blockNumber ?? fresh.blockNumber;
      await m.save(fresh);
      await this.ledger.postEntry(
        m, seen.wallet, fresh, 'deposit_confirmed', fresh.amount, 'credit',
      );
      return fresh;
    });
    if (credited) await this.notifier.notify('deposit.confirmed', credited);
  }

  private async checkAddress(
    dep: DepositAddress,
    custodyAddrs: Set<string> = new Set(),
  ): Promise<void> {
    const asset = getAsset(dep.asset);
    if (!asset) return;

    // A watch row that points AT the custody treasury/base address is not a
    // user deposit — inflows there are refills, sweeps, or stray sends.
    // Crediting them to whichever wallet's account resolved to that address
    // turns every ops refill into a phantom user balance. Skip loudly.
    if (custodyAddrs.has(dep.address)) {
      const key = `${dep.address}:${dep.asset}`;
      if (!this.custodyWarned.has(key)) {
        this.custodyWarned.add(key);
        this.logger.warn(
          `${dep.address} ${dep.asset} resolves to a custody treasury/base ` +
          `address — skipping auto-credit; treasury inflows are not user deposits`,
        );
      }
      return;
    }

    // Shared custody addresses (SOL's single enrolled baseAddress, any
    // future account-model chain without per-wallet derivation) hold one
    // row PER WALLET for the same (address, asset). A balance delta cannot
    // tell whose deposit it is — crediting whichever row polls first would
    // put funds in the wrong wallet. Skip and flag for ops: per-user
    // attribution needs deposit memos (tracked gap) or manual crediting.
    // Check BEFORE the provider call so ambiguous addresses cost no credits.
    const shared = await this.addresses
      .createQueryBuilder('da')
      .innerJoin('da.account', 'wa')
      .where('da.address = :address', { address: dep.address })
      .andWhere('da.asset = :asset', { asset: dep.asset })
      .andWhere('wa.wallet_id != :walletId', { walletId: dep.account.wallet.id })
      .getCount();
    if (shared > 0) {
      const key = `${dep.address}:${dep.asset}`;
      if (!this.sharedWarned.has(key)) {
        this.sharedWarned.add(key);
        this.logger.warn(
          `${dep.address} ${dep.asset} is watched by multiple wallets (shared custody ` +
          `address) — skipping auto-credit; deposits need memo attribution or manual ops credit`,
        );
      }
      return;
    }

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

      // Normalize at the asset's decimal precision BEFORE comparing —
      // provider balance strings can carry float noise (~1e-20 tails)
      // that reads as a phantom positive delta and would mint a
      // zero-amount 'poll:*' row that can never resolve.
      const delta = parseFloat(
        (parseFloat(observed) - parseFloat(dep.creditedAmount)).toFixed(asset.decimals),
      );
      if (delta < 0) {
        // Balance dropped below our credited baseline — funds left the
        // address (sweep, withdrawal). Rebaseline so the next deposit
        // credits its full amount instead of the shrunken delta.
        const baseline = parseFloat(observed).toFixed(asset.decimals);
        await this.addresses.update(dep.id, { creditedAmount: baseline });
        this.logger.log(
          `Rebaselined ${dep.address} ${asset.code}: credited ${dep.creditedAmount} → ${baseline}`,
        );
        return;
      }
      if (delta <= 0) return;

      // Best-effort txid attribution (UTXO chains expose address history).
      const candidates =
        (await this.provider.getAddressTransactions?.(dep.address, asset, 5)) ?? [];
      const ours = (t: { outputs: { address: string; amount: string }[] }) =>
        t.outputs.filter(
          (o) => o.address.toLowerCase() === dep.address.toLowerCase(),
        );
      // Prefer an exact delta match; otherwise take any UNRECORDED tx paying
      // this address — a dedicated deposit address treats every inbound tx
      // as a deposit. Recorded txids are excluded so an old deposit can never
      // masquerade as the current delta (misattributed double-credit).
      const knownTxids = new Set(
        (await this.txs.find({
          where: { address: dep.address, asset: asset.code, direction: 'inbound' },
          select: ['txid'],
        })).map((r) => r.txid),
      );
      const hit =
        candidates.find((t) =>
          ours(t).some(
            (o) => Math.abs(parseFloat(o.amount) - delta) < 1e-8,
          ),
        ) ??
        candidates.find(
          (t) => ours(t).length > 0 && !knownTxids.has(t.txid),
        );

      // Tatum's address-history entries carry blockNumber but NOT a
      // confirmations field — derive from chain tip (same as webhook path).
      if (hit?.blockNumber != null && !hit.confirmations) {
        try {
          const head = await this.provider.getLatestBlock(dep.chain as any);
          if (head > 0) hit.confirmations = Math.max(0, head - hit.blockNumber + 1);
        } catch { /* stays pending until derivable */ }
      }

      const utxo = dep.chain === 'BTC' || dep.chain === 'LTC';
      const txid = hit?.txid ?? `poll:${dep.address}:${asset.code}:${observed}`;
      const req = this.requiredConfirmations(dep.chain);
      // UTXO balance reads include the mempool: an unattributed delta
      // (hit=null) may be a 0-CONF deposit. Crediting it instantly lets a
      // payer double-spend after we've released funds — record 'pending'
      // and re-attribute on subsequent polls until a real txid confirms.
      // Account-model chains' balances are post-confirmation, so hit=null
      // there is safe (and unavoidable — no address-history endpoint).
      const confirmed = hit ? hit.confirmations >= req : !utxo;
      const reportConfs = hit?.confirmations ?? (confirmed ? req : 0);
      // When attributed, credit the tx's outputs to us — NOT the whole
      // delta. A two-deposit poll window (delta = a+b) must credit each tx
      // separately; the unattributed remainder re-detects next cycle.
      const hitAmount = hit
        ? ours(hit).reduce((s, o) => s + parseFloat(o.amount), 0).toFixed(asset.decimals)
        : null;

      const tx = await this.em.transaction(async (m) => {
        // Lock just this row (no join — FOR UPDATE can't hit nullable
        // outer-join sides on Postgres). Wallet/account refs are immutable
        // and already loaded on `dep`.
        const fresh = await m.findOne(DepositAddress, {
          where: { id: dep.id },
          lock: { mode: 'pessimistic_write' },
        });
        const freshDelta = parseFloat(
          (parseFloat(observed) - parseFloat(fresh.creditedAmount)).toFixed(asset.decimals),
        );
        if (freshDelta <= 0) return null;

        // A pending record from an earlier poll shares this txid — advance
        // its confirmation count instead of inserting a duplicate.
        // direction:'inbound' matters: an outbound send TO our own watched
        // address (self-transfer, consolidation) has the same on-chain txid —
        // without the filter it would swallow this deposit's credit.
        const existing =
          (await m.findOne(Transaction, {
            where: { txid, address: dep.address, asset: asset.code, direction: 'inbound' },
          })) ??
          // Adopt a pending SYNTHETIC row from an earlier unattributed
          // poll — the Like('poll:%') guard keeps a webhook-created
          // pending row (real txid, awaiting confirmations) out of the
          // delta path's reach. Skipped when the hit's amount exceeds
          // the uncredited delta: that tx's funds are already inside
          // creditedAmount and adopting it would double-credit. (Confirmed
          // synthetic rows are deliberately NOT adoptable here — a
          // same-amount covered tx sharing the window would rekey the
          // credit and marker-sync past the new delta, silently
          // swallowing a real deposit.)
          (hit?.txid == null ||
           parseFloat(hitAmount ?? '0') <= freshDelta + 1e-8
            ? await m.findOne(Transaction, {
                where: { address: dep.address, asset: asset.code, direction: 'inbound', status: 'pending', txid: Like('poll:%') },
              })
            : null);
        if (existing) {
          existing.confirmations = reportConfs;
          existing.blockNumber = hit?.blockNumber ?? existing.blockNumber;
          if (hit?.txid && existing.txid !== hit.txid) {
            existing.txid = hit.txid; // attribution resolved — replace synthetic
          }
          if (existing.status === 'pending') {
            // While unattributed the pending amount tracks the uncredited
            // delta; once attributed it is the tx's outputs to us.
            existing.amount = hitAmount ?? freshDelta.toFixed(asset.decimals);
          }
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
              (parseFloat(fresh.creditedAmount) + parseFloat(existing.amount)).toFixed(asset.decimals);
            await m.save(fresh);
          }
          return m.save(existing);
        }

        // A hit whose amount EXCEEDS the uncredited delta was already
        // counted inside creditedAmount by an earlier synthetic credit —
        // the row records the real txid but must not post a second entry.
        const covered =
          hit != null && parseFloat(hitAmount!) > freshDelta + 1e-8;
        const t = await m.save(
          m.create(Transaction, {
            wallet: dep.account.wallet,
            direction: 'inbound',
            chain: dep.chain,
            asset: dep.asset,
            txid,
            address: dep.address,
            amount: hitAmount ?? freshDelta.toFixed(asset.decimals),
            status: confirmed || covered ? 'confirmed' : 'pending',
            confirmations: reportConfs,
            requiredConfirmations: req,
            blockNumber: hit?.blockNumber ?? null,
            reference: dep.reference,
            raw: {
              detectedVia: 'polling',
              observedBalance: observed,
              ...(covered ? { coveredByBaseline: true } : {}),
            },
          }),
        );
        if (covered) {
          this.logger.warn(
            `${dep.address} ${asset.code} tx ${txid} is inside the credited baseline — recorded without a second credit`,
          );
        }
        if (confirmed && !covered) {
          const amt = hitAmount ?? freshDelta.toFixed(asset.decimals);
          await this.ledger.postEntry(
            m, dep.account.wallet, t, 'deposit_confirmed',
            amt, 'credit',
          );
          // Marker tracks what was credited, not what was observed — an
          // attributed partial amount leaves the remainder for next poll.
          fresh.creditedAmount =
            (parseFloat(fresh.creditedAmount) + parseFloat(amt)).toFixed(asset.decimals);
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

      // Distinguish "vanished" (provider returned null = 404) from
      // "unreachable" (threw). A provider outage must NOT reverse real
      // deposits — catch(()=>null) conflated the two and reversed
      // confirmed credits during network flaps.
      let chainTx: ProviderTx | null;
      try {
        chainTx = await this.provider.getTransaction(
          t.txid, dep.chain as any, asset as any,
        );
      } catch {
        continue; // unreachable — retry next cycle, keep the credit
      }
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
          ).toFixed(asset.decimals);
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
