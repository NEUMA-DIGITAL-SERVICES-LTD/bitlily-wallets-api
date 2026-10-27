import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectEntityManager, InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { EntityManager, Repository } from 'typeorm';
import { DepositAddress } from '../../database/entities/deposit-address.entity';
import { CustodyAccount } from '../../database/entities/custody-account.entity';
import { enabledAssets, getAsset } from '../../config/assets';
import {
  BLOCKCHAIN_PROVIDER,
  BlockchainProvider,
} from '../../providers/provider.interface';
import { NotifierService } from '../notifications/notifier.service';
import { errMsg } from '../../common/errors';

/**
 * Hourly reconciliation — the control that catches what everything else
 * misses. Per asset it compares:
 *
 *   liabilities  = Σ ledger balances (what users are owed)
 *   custodied    = Σ on-chain balances across every watched deposit address
 *                  + the chain's treasury/custody balance
 *   inflight     = Σ pending outbound debits (funds sent, not yet mined)
 *
 * divergence = custodied - inflight - liabilities. It should be ~0 (minus
 * treasury float); anything else means funds moved without a ledger record
 * or the ledger credited without funds — either way, someone pages.
 *
 * Report-only: it never mutates accounting rows. Known noise sources are
 * documented rather than papered over — mempool timing can produce a brief
 * transient divergence that self-resolves next run.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private running = false;

  constructor(
    @InjectRepository(DepositAddress)
    private readonly addresses: Repository<DepositAddress>,
    @InjectRepository(CustodyAccount)
    private readonly custody: Repository<CustodyAccount>,
    @InjectEntityManager() private readonly em: EntityManager,
    @Inject(BLOCKCHAIN_PROVIDER) private readonly provider: BlockchainProvider,
    private readonly notifier: NotifierService,
    private readonly config: ConfigService,
  ) {}

  @Cron('17 * * * *') // hourly at :17 — off the round-minute thundering herd
  async reconcile(): Promise<void> {
    if (this.config.get('reconcile.enabled') === false) return;
    if (this.running) return;
    this.running = true;
    try {
      for (const a of enabledAssets()) {
        // Resolve through getAsset — the testnet contract swap lives there.
        // Raw registry entries carry MAINNET contracts; querying them on
        // testnet RPCs 403s every cycle (verified live: erc20.get.error
        // storms on USDC_MATIC/USDT_MATIC/USDC_SOL).
        const asset = getAsset(a.code);
        if (!asset) continue;
        try {
          await this.reconcileAsset(asset);
        } catch (e) {
          this.logger.warn(`Reconciliation skipped for ${asset.code}: ${errMsg(e)}`);
        }
      }
      await this.checkGasFloors();
    } finally {
      this.running = false;
    }
  }

  /**
   * Treasury gas-floor check — a treasury can sign sends it can't afford to
   * broadcast (seen live: POL treasury 0.0073 vs 0.05 ledger; gas spend is
   * never a ledger event). Once per chain, reads the on-chain NATIVE
   * balance and alerts when it drops below the floor.
   */
  private async checkGasFloors(): Promise<void> {
    const floors = this.config.get<Record<string, number>>('treasury.gasFloor') ?? {};
    const accounts = await this.custody.find();
    for (const acct of accounts) {
      const treasury = acct.treasuryAddress ?? acct.baseAddress;
      const nativeCode = acct.chain === 'POLYGON' ? 'POL' : acct.chain;
      const floor = floors[acct.chain];
      if (!treasury || floor == null) continue;
      const asset = getAsset(nativeCode);
      if (asset?.type !== 'native') continue;
      if (!asset) continue;
      let bal: number;
      try {
        bal = parseFloat(await this.provider.getAddressBalance(treasury, asset as any));
      } catch (e) {
        this.logger.warn(`Gas-floor balance read failed for ${acct.chain} treasury: ${errMsg(e)}`);
        continue;
      }
      if (bal < floor) {
        this.logger.error(
          `Treasury gas low on ${acct.chain}: ${bal} < floor ${floor} ` +
          `(${treasury}) — sends will fail broadcast until refilled`,
        );
        await this.notifier.notifyEvent('treasury.gas_low', {
          chain: acct.chain,
          treasury,
          balance: String(bal),
          floor: String(floor),
        });
      }
    }
  }

  private async reconcileAsset(asset: { code: string; chain: string; type: string; decimals: number }): Promise<void> {
    // Per-wallet, floored at 0: enforceBalance=false clients can overdraw
    // (fiat-funded sends) — a negative wallet is the APP's liability toward
    // custody, not a user liability. Summing raw would shrink liabilities
    // and let overdrafts mask a real divergence.
    const [{ liabilities }] = await this.em.query(
      `SELECT COALESCE(SUM(GREATEST(bal, 0)), 0) AS liabilities
       FROM (
         SELECT wallet_id,
                SUM(CASE WHEN direction='credit' THEN amount::numeric ELSE -amount::numeric END) AS bal
         FROM ledger_entries WHERE asset = $1 GROUP BY wallet_id
       ) w`,
      [asset.code],
    );
    const [{ inflight }] = await this.em.query(
      `SELECT COALESCE(SUM(amount::numeric), 0) AS inflight
       FROM transactions WHERE asset = $1 AND direction = 'outbound' AND status IN ('pending','requires_approval')
       AND COALESCE(raw->>'internal','') <> 'sweep'`,
      [asset.code],
    );

    let custodied = 0;
    const watched = await this.addresses.find({ where: { asset: asset.code }, take: 2000 });
    for (const dep of watched) {
      try {
        custodied += parseFloat(await this.provider.getAddressBalance(dep.address, asset as any));
      } catch (e) {
        this.logger.debug?.(`balance read failed for ${dep.address}: ${errMsg(e)}`);
      }
    }
    // Treasury/custody float for the chain — sweeps converge here.
    const custody = await this.custody.findOne({ where: { chain: asset.chain } });
    if (custody) {
      const treasury = custody.treasuryAddress ?? custody.baseAddress;
      if (treasury) {
        try {
          custodied += parseFloat(await this.provider.getAddressBalance(treasury, asset as any));
        } catch { /* unreadable treasury — note in diff */ }
      }
    }

    const diff = custodied - parseFloat(inflight) - parseFloat(liabilities);
    const epsilon = Math.pow(10, -Math.min(asset.decimals, 8)) * 100;
    if (Math.abs(diff) > epsilon) {
      this.logger.error(
        `Reconciliation divergence ${asset.code}: custodied=${custodied} ` +
        `inflight=${inflight} liabilities=${liabilities} diff=${diff}`,
      );
      await this.notifier.notifyEvent('reconciliation.divergence', {
        asset: asset.code,
        chain: asset.chain,
        custodied: String(custodied),
        inflight: String(inflight),
        liabilities: String(liabilities),
        diff: String(diff),
      });
    } else {
      this.logger.log(
        `Reconciled ${asset.code}: custodied=${custodied.toFixed(8)} ` +
        `liabilities=${Number(liabilities).toFixed(8)} diff=${diff.toExponential(2)}`,
      );
    }
  }
}
