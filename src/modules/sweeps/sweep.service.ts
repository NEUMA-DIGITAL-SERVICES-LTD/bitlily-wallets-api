import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DepositAddress } from '../../database/entities/deposit-address.entity';
import { CustodyAccount } from '../../database/entities/custody-account.entity';
import { Transaction } from '../../database/entities/transaction.entity';
import { AssetDef, getAsset } from '../../config/assets';
import {
  BLOCKCHAIN_PROVIDER,
  BlockchainProvider,
} from '../../providers/provider.interface';
import { errMsg } from '../../common/errors';

/**
 * Fund consolidation — the piece every custodial system needs and clients
 * never spec. Deposits sit on per-order addresses; sweeps move them to the
 * chain's treasury address.
 *
 * Signing model (KMS): the deposit address signs via the custody wallet's
 * signatureId + the address's derivation index. Gas-pump for EVM tokens: an
 * address holding only USDC can't pay gas — we top it up from the treasury
 * (custody index 0) first, then move the token.
 *
 * Dev mode can never sweep: deposit-address keys live in KMS only.
 */
@Injectable()
export class SweepService {
  private readonly logger = new Logger(SweepService.name);

  constructor(
    @InjectRepository(DepositAddress)
    private readonly addresses: Repository<DepositAddress>,
    @InjectRepository(CustodyAccount)
    private readonly custody: Repository<CustodyAccount>,
    @InjectRepository(Transaction)
    private readonly txs: Repository<Transaction>,
    @Inject(BLOCKCHAIN_PROVIDER) private readonly provider: BlockchainProvider,
    private readonly config: ConfigService,
  ) {}

  /**
   * Sweeps `asset` funds from a deposit address to the chain treasury.
   * Returns the broadcast txid(s) — the gas top-up send (if any) plus the
   * asset send. KMS mode only.
   *
   * `opts.maxAmount` caps the swept amount — the auto-scheduler passes the
   * address's confirmed-credited total so a deposit still confirming can't
   * be pulled into a spend (UTXO chains especially). Ops calls omit it.
   */
  async sweepAddress(
    depositAddressId: string,
    opts?: { maxAmount?: string },
  ): Promise<{ txids: string[]; pendingKms?: string[]; amount?: string }> {
    if (this.config.get('tatum.useKms') !== true) {
      throw new BadRequestException(
        'Sweeps require KMS signing — deposit addresses have no local keys. ' +
        'Set TATUM_USE_KMS=true with an enrolled custody wallet.',
      );
    }
    const dep = await this.addresses.findOne({
      where: { id: depositAddressId },
      relations: ['account', 'account.wallet'],
    });
    if (!dep) throw new NotFoundException(`Deposit address ${depositAddressId} not found`);
    const asset = getAsset(dep.asset);
    if (!asset) throw new BadRequestException(`Unsupported asset: ${dep.asset}`);

    const custody = await this.custody.findOne({ where: { chain: dep.chain } });
    if (!custody?.secretRef) {
      throw new BadRequestException(`No custody wallet enrolled for ${dep.chain}`);
    }
    const treasury =
      custody.treasuryAddress ??
      (await this.provider.generateDepositAddress(
        { chain: dep.chain as any, xpub: custody.xpub, baseAddress: custody.baseAddress },
        0,
      ));

    const rawBalance = await this.provider.getAddressBalance(dep.address, asset);
    if (parseFloat(rawBalance) <= 0) {
      throw new BadRequestException(`No ${asset.code} at ${dep.address}`);
    }
    const balance =
      opts?.maxAmount && parseFloat(opts.maxAmount) < parseFloat(rawBalance)
        ? opts.maxAmount
        : rawBalance;

    // In-flight guard — two concurrent sweeps would read the same balance
    // and double-send. A pending outbound row for this deposit is enough
    // evidence a sweep is already underway.
    const inFlight = await this.txs.findOne({
      where: { reference: `sweep:${dep.id}`, status: 'pending' },
    });
    if (inFlight) {
      throw new BadRequestException(
        `Sweep already in flight for ${dep.address} (tx ${inFlight.id})`,
      );
    }

    const txids: string[] = [];
    const pendingKms: string[] = [];
    const record = (r: { txid?: string; kmsRequestId?: string }) => {
      if (r.txid) txids.push(r.txid);
      if (r.kmsRequestId) pendingKms.push(r.kmsRequestId);
    };

    // SPL tokens join the gas-pump path: a pooled SOL deposit address
    // holding only USDC can't pay the sweep fee — treasury tops it with
    // SOL (custody index 0) first, same as ERC-20 on EVM chains.
    if (asset.type === 'token' && (asset.chain === 'ETH' || asset.chain === 'POLYGON' || asset.chain === 'SOL')) {
      const pumped = await this.gasPump(dep, asset, custody, record);
      if (pumped) {
        // Gas top-up was just sent — it must confirm on-chain before the
        // token can move. Return now; call sweep again once it lands.
        return { txids, pendingKms };
      }
    }

    // Native sweeps send balance minus fee; tokens move the full balance —
    // gas is paid by the pump, not the token amount.
    let amount = balance;
    if (asset.type !== 'token') {
      const est = await this.provider.estimateFee(asset, treasury, balance, dep.address);
      const fee = parseFloat(est.fee);
      amount = fee > 0 ? (parseFloat(balance) - fee).toFixed(asset.decimals) : balance;
      if (parseFloat(amount) <= 0) {
        throw new BadRequestException(
          `Balance ${balance} ${asset.code} does not cover estimated fee ${est.fee}`,
        );
      }
    }

    const r = await this.provider.sendTransaction({
      asset,
      fromAccountId: dep.account.id,
      signatureId: custody.secretRef,
      derivationIndex: dep.derivationIndex,
      // UTXO chains need the source address for input selection AND as
      // changeAddress — omitting it would burn the whole input as fee
      // (the bug we already fixed once). SOL/TRON need it as `from`.
      sourceAddress: dep.address,
      toAddress: treasury,
      amount,
      reference: `sweep:${dep.id}`,
    });
    record(r);
    await this.recordOutbound(dep, asset, amount, treasury, `sweep:${dep.id}`, r);
    this.logger.log(`Sweep ${dep.address} → ${treasury}: ${amount} ${asset.code}`);
    return { txids, pendingKms, amount };
  }

  /**
   * Gas-pump: an ERC-20/Polygon token can't move without native gas at its
   * address. If the deposit address lacks enough native balance, send a
   * top-up from custody index 0 first.
   */
  private async gasPump(
    dep: DepositAddress,
    token: AssetDef,
    custody: CustodyAccount,
    record: (r: { txid?: string; kmsRequestId?: string }) => void,
  ): Promise<boolean> {
    // getAsset keys on asset CODE not chain name — 'POLYGON' isn't an
    // asset code (native code is 'POL'), so this lookup must map.
    const NATIVE_CODE: Record<string, string> = {
      ETH: 'ETH', POLYGON: 'POL', TRON: 'TRX', SOL: 'SOL',
      BTC: 'BTC', LTC: 'LTC',
    };
    const nativeAsset = getAsset(NATIVE_CODE[token.chain] ?? token.chain);
    if (!nativeAsset) throw new BadRequestException(`No native asset for ${token.chain}`);
    const nativeBal = parseFloat(
      await this.provider.getAddressBalance(dep.address, nativeAsset),
    );
    // Conservative default: a 100k-gas token transfer at ~50 gwei ≈ 0.005
    // native — enough headroom for testnet/mainnet variance; tune per chain.
    const needed = this.config.get<number>('sweep.gasTopUp') ?? 0.005;
    if (nativeBal >= needed) return false;
    const topUp = (needed - nativeBal).toFixed(nativeAsset.decimals);
    const r = await this.provider.sendTransaction({
      asset: nativeAsset,
      fromAccountId: dep.account.id,
      signatureId: custody.secretRef,
      derivationIndex: 0, // custody wallet's own address pays the gas
      // Account-model chains (SOL) name the sender explicitly — the
      // treasury/base address, which is custody index 0.
      sourceAddress: custody.treasuryAddress ?? custody.baseAddress ?? undefined,
      toAddress: dep.address,
      amount: topUp,
      reference: `gas-pump:${dep.id}`,
    });
    record(r);
    await this.recordOutbound(dep, nativeAsset, topUp, dep.address, `gas-pump:${dep.id}`, r);
    this.logger.log(`Gas-pumped ${topUp} ${nativeAsset.code} → ${dep.address}`);
    return true;
  }

  /**
   * Persist the sweep send as a pending outbound Transaction — the KMS
   * four-eye verify endpoint only authorizes requests matching a row WE
   * created (raw.kmsRequestId). Without this the daemon refuses to sign
   * sweeps (verified live). No ledger entry: funds stay in custody.
   * Also lets the outbound sweeper resolve+track confirmations for free.
   */
  private async recordOutbound(
    dep: DepositAddress,
    asset: AssetDef,
    amount: string,
    toAddress: string,
    reference: string,
    r: { txid?: string; kmsRequestId?: string },
  ): Promise<void> {
    await this.txs.save(
      this.txs.create({
        wallet: dep.account.wallet,
        direction: 'outbound',
        chain: dep.chain,
        asset: asset.code,
        txid: r.txid ?? `pending:${crypto.randomUUID()}`,
        address: toAddress,
        amount,
        status: 'pending',
        confirmations: 0,
        reference,
        raw: { kmsRequestId: r.kmsRequestId, internal: 'sweep' },
      }),
    );
  }
}
