import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Transaction } from '../../database/entities/transaction.entity';
import { DepositAddress } from '../../database/entities/deposit-address.entity';
import { Wallet } from '../../database/entities/wallet.entity';
import { WalletAccount } from '../../database/entities/wallet-account.entity';
import { CustodyAccount } from '../../database/entities/custody-account.entity';
import { ASSET_REGISTRY, AssetDef, Chain, getAsset } from '../../config/assets';
import {
  BLOCKCHAIN_PROVIDER,
  BlockchainProvider,
} from '../../providers/provider.interface';
import { LedgerService } from '../../ledger/ledger.service';
import { NotifierService } from '../notifications/notifier.service';
import { ListTransactionsDto, SendTransactionDto } from './transactions.dto';
import { errCode, errMsg } from '../../common/errors';
import { isPlausibleAddress } from '../../common/address-validation';

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    @InjectRepository(Transaction) private readonly txs: Repository<Transaction>,
    @InjectRepository(Wallet) private readonly wallets: Repository<Wallet>,
    @InjectRepository(WalletAccount) private readonly accounts: Repository<WalletAccount>,
    @Inject(BLOCKCHAIN_PROVIDER) private readonly provider: BlockchainProvider,
    private readonly ledger: LedgerService,
    private readonly notifier: NotifierService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * OPS: shared-custody deposits (SOL) whose memo resolved no wallet are
   * recorded with wallet:NULL + raw.unattributed — the manual-review queue.
   * Sanitized for ops display; provider blobs stay off this wire too.
   */
  async listUnattributedDeposits(chain?: string) {
    const qb = this.txs
      .createQueryBuilder('t')
      .where('t.wallet_id IS NULL')
      .andWhere(`t.direction = 'inbound'`)
      .andWhere(`t.raw ->> 'unattributed' = 'true'`)
      .orderBy('t.created_at', 'DESC')
      .take(200);
    if (chain) qb.andWhere('t.chain = :chain', { chain: chain.toUpperCase() });
    return (await qb.getMany()).map((t) => ({
      id: t.id,
      chain: t.chain,
      asset: t.asset,
      txid: t.txid,
      address: t.address,
      amount: t.amount,
      status: t.status,
      confirmations: t.confirmations,
      blockNumber: t.blockNumber,
      memo: (t.raw as any)?.memo ?? null,
      detectedVia: (t.raw as any)?.detectedVia ?? null,
      createdAt: t.createdAt,
    }));
  }

  /**
   * OPS manual credit for an unattributed shared-custody deposit — the
   * missing/wrong-memo recovery path. Attribution is explicit (admin picks
   * appId + externalUserId), idempotent (already-attributed rows conflict),
   * and auditable (raw.attribution records who credited whom, when).
   * The ledger entry posts in the same DB transaction as the wallet
   * assignment — a crash can't half-apply the credit.
   */
  async creditUnattributedDeposit(
    txId: string,
    appId: string,
    externalUserId: string,
  ): Promise<Transaction> {
    const wallet = await this.wallets.findOne({
      where: { externalUserId, appId },
    });
    if (!wallet) {
      throw new NotFoundException(
        `No wallet for externalUserId ${externalUserId} in app ${appId}`,
      );
    }
    const tx = await this.dataSource.transaction(async (m) => {
      // No join under FOR UPDATE — Postgres can't lock nullable outer-join
      // sides. loadRelationIds gives the raw wallet_id for the attributed
      // check; the entity itself gets assigned below.
      const t = await m.findOne(Transaction, {
        where: { id: txId },
        loadRelationIds: true,
        lock: { mode: 'pessimistic_write' },
      });
      if (!t) throw new NotFoundException(`Transaction ${txId} not found`);
      if (t.direction !== 'inbound') {
        throw new BadRequestException('Only inbound deposits can be manually credited');
      }
      if (t.wallet) {
        throw new ConflictException(
          'Deposit already attributed to a wallet — refusing to double-credit',
        );
      }
      if (!(t.raw as any)?.unattributed) {
        throw new BadRequestException('Deposit is not flagged unattributed');
      }
      if (t.status !== 'confirmed') {
        throw new BadRequestException(
          `Deposit status is ${t.status} — only confirmed deposits can be credited`,
        );
      }
      t.wallet = wallet;
      t.raw = {
        ...t.raw,
        unattributed: false,
        attribution: {
          by: 'admin',
          appId,
          externalUserId,
          at: new Date().toISOString(),
        },
      };
      await m.save(t);
      await this.ledger.postEntry(
        m, wallet, t, 'deposit_confirmed', t.amount, 'credit',
      );
      // Unattributed deposits never entered creditedAmount — bump the
      // deposit-address baseline or the next poll re-detects the same
      // delta and mints a second credit under a synthetic poll:* txid.
      // Shared-custody rows can be bumped harmlessly: the delta path
      // never reads them.
      await m.increment(
        DepositAddress,
        { address: t.address, asset: t.asset },
        'creditedAmount',
        parseFloat(t.amount),
      );
      return t;
    });
    await this.notifier.notify('deposit.confirmed', tx);
    return tx;
  }

  /**
   * Outbound send/withdrawal.
   *
   * Order matters: the ledger debit is posted inside the same DB transaction
   * as the Transaction row BEFORE broadcast, so a crash mid-broadcast can be
   * reconciled (tx row exists with status=pending and no txid). Broadcasting
   * first and recording after is how funds get double-sent.
   */
  async send(
    dto: SendTransactionDto,
    appId: string,
    enforceBalance = true,
  ): Promise<Transaction> {
    const asset = getAsset(dto.asset);
    if (!asset) throw new BadRequestException(`Unsupported asset: ${dto.asset}`);

    // The DTO regex admits '0' — reject non-positive here too; ledger math
    // assumes strictly positive amounts in both directions.
    const amount = parseFloat(dto.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('amount must be greater than zero');
    }

    // Reject implausible destination formats BEFORE the debit — a typo'd
    // address either burns funds outright or fails at broadcast AFTER the
    // ledger moved. Charset/length only; checksums stay the chain's job.
    if (!isPlausibleAddress(asset.chain, dto.toAddress)) {
      throw new BadRequestException(
        `${dto.toAddress} is not a valid ${asset.chain} address format`,
      );
    }

    // The wallet is addressed by the client's own user id — the API never
    // exposes our internal wallet uuid in request contracts.
    const wallet = await this.wallets.findOne({
      where: { externalUserId: dto.externalUserId, appId },
    });
    if (!wallet) {
      throw new NotFoundException(`No wallet for externalUserId ${dto.externalUserId}`);
    }

    // Accounts are per-chain — a token send signs via its chain's account.
    const account = await this.accounts.findOne({
      where: { wallet: { id: wallet.id, appId }, chain: asset.chain },
      relations: ['wallet'],
    });
    if (!account) throw new NotFoundException(`No ${asset.chain} account on wallet`);

    // reference uniqueness is a HARD constraint: any outbound tx in this
    // app already carrying it → 409, whatever the payload. The client
    // check-before-retry flow reads the tx via the transactions endpoint —
    // this API never silently returns an old send as if it were new.
    if (dto.reference) {
      const dupe = await this.txs.findOne({
        where: { wallet: { appId }, direction: 'outbound', reference: dto.reference },
        relations: ['wallet'],
      });
      if (dupe) {
        throw new ConflictException(
          `reference "${dto.reference}" already used by transaction ${dupe.id} ` +
          `(status ${dupe.status})`,
        );
      }
    }

    // Withdrawal policy — circuit breakers, applied before any debit.
    const limits = this.config.get('limits') ?? { maxPerTx: {}, approvalAbove: {} };
    const max = limits.maxPerTx?.[asset.code];
    if (max && amount > parseFloat(max)) {
      throw new BadRequestException(
        `Amount ${dto.amount} ${asset.code} exceeds per-transaction limit ${max}`,
      );
    }
    const needsApproval = (() => {
      const thr = limits.approvalAbove?.[asset.code];
      return thr ? amount >= parseFloat(thr) : false;
    })();

    // Debit + pending row FIRST, atomically — a crash between here and
    // broadcast leaves a reconcilable pending row (placeholder txid).
    // Broadcasting first and recording after is how funds get double-sent
    // or moved without a ledger record.
    let tx: Transaction;
    try {
      tx = await this.dataSource.transaction(async (em) => {
        // Serialize debits per wallet: lock the wallet row and re-check the
        // balance INSIDE the transaction. Checking outside is a TOCTOU —
        // two concurrent sends both see the pre-debit balance and both pass.
        await em.findOneOrFail(Wallet, {
          where: { id: account.wallet.id },
          lock: { mode: 'pessimistic_write' },
        });
        // enforceBalance=false: the client's backend owns solvency checks
        // (fiat on-ramps, credits granted off-chain). The debit still
        // posts — a negative wallet balance then means the app's ledger
        // owes custody, and the reconciler floors it at 0.
        if (enforceBalance) {
          const balance = await this.ledger.getBalance(wallet.id, asset.code);
          if (parseFloat(balance) < amount) {
            throw new BadRequestException(
              `Insufficient ${asset.code} balance: have ${balance}, need ${dto.amount}`,
            );
          }
        }
        const t = await em.save(
          em.create(Transaction, {
            wallet: account.wallet,
            direction: 'outbound',
            chain: asset.chain,
            asset: asset.code,
            txid: `pending:${crypto.randomUUID()}`,
            address: dto.toAddress,
            amount: dto.amount,
            status: needsApproval ? 'requires_approval' : 'pending',
            requiredConfirmations: this.requiredConfirmations(asset.chain),
            reference: dto.reference,
          }),
        );
        await this.ledger.postEntry(em, account.wallet, t, 'withdrawal', dto.amount, 'debit');
        return t;
      });
    } catch (e) {
      // Two concurrent first-sends with the same reference on one wallet:
      // both pass the dupe check, the loser's INSERT hits UQ_tx_reference
      // and its whole transaction (debit included) rolls back. Return the
      // winner's row — that IS the idempotent response, not an error.
      if (errCode(e) === '23505' && dto.reference) {
        // Lost a concurrent race under the same reference — the winner's
        // tx already exists; the loser must see the same loud 409 any
        // other duplicate gets.
        const winner = await this.txs.findOne({
          where: { direction: 'outbound', reference: dto.reference, wallet: { appId } },
          relations: ['wallet'],
        });
        throw new ConflictException(
          `reference "${dto.reference}" already used` +
          (winner ? ` by transaction ${winner.id} (status ${winner.status})` : ''),
        );
      }
      throw e;
    }

    if (needsApproval) {
      // Funds stay debited (reserved) until an admin approves or rejects —
      // the blast-radius control for large payouts.
      await this.notifier.notify('withdrawal.requires_approval', tx);
      return tx;
    }
    return this.broadcastPending(tx, account, asset);
  }

  /** Broadcast an already-debited pending outbound row (initial + approval paths). */
  private async broadcastPending(
    tx: Transaction,
    account: WalletAccount,
    asset: AssetDef,
  ): Promise<Transaction> {
    try {
      // Custody model: withdrawals spend from the chain treasury (index 0) —
      // sweeps converge deposit funds there. UTXO chains need the treasury
      // address named explicitly as the UTXO source. The signatureId lives
      // on the chain-level custody account — the wallet account's copy is
      // only a creation-time snapshot and is NULL for wallets enrolled
      // before custody existed; those must still withdraw.
      const custody = await this.dataSource.getRepository(CustodyAccount)
        .findOne({ where: { chain: asset.chain } });
      await this.assertTreasuryCoverage(custody, asset, tx);
      const result = await this.provider.sendTransaction({
        asset,
        fromAccountId: account.id,
        signatureId: custody?.secretRef ?? account.secretRef,
        derivationIndex: custody?.xpub ? 0 : undefined,
        sourceAddress: custody?.treasuryAddress ?? undefined,
        toAddress: tx.address,
        amount: tx.amount,
        reference: tx.reference,
      });
      if (result.kmsRequestId) {
        // KMS signing is async — the daemon picks up the pending request,
        // signs, broadcasts. txid stays a placeholder until the outbound
        // sweeper resolves it via getPendingSignature.
        tx.raw = { ...(tx.raw ?? {}), kmsRequestId: result.kmsRequestId };
        await this.txs.update(tx.id, { raw: tx.raw });
        if (result.txid) {
          tx.txid = result.txid;
          await this.txs.update(tx.id, { txid: result.txid });
        }
        await this.notifier.notify('withdrawal.pending_signature', tx);
        return tx;
      }
      const txid = result.txid;
      if (!txid) throw new Error('provider returned no txid');
      await this.txs.update(tx.id, { txid });
      tx.txid = txid;
      await this.notifier.notify('withdrawal.broadcast', tx);
      return tx;
    } catch (e) {
      // Broadcast failed — reverse the debit so the ledger stays truthful.
      await this.dataSource.transaction(async (em) => {
        await em.update(Transaction, tx.id, { status: 'failed' });
        await this.ledger.postEntry(
          em, account.wallet, tx, 'withdrawal_reversal', tx.amount, 'credit',
        );
      });
      if (e instanceof HttpException) throw e;
      throw new BadGatewayException(`Broadcast failed: ${errMsg(e)}`);
    }
  }

  /**
   * Pre-flight solvency gate: a withdrawal the ledger covers but the chain
   * treasury cannot only ever ends one way — debit, broadcast fail,
   * reverse — surfacing as a confusing 502 after the fact. Reading the
   * on-chain balance first fails fast with an honest 503 and alerts ops
   * now rather than at the next hourly reconciliation. Native sends also
   * need headroom for the network fee; tokens gate on the token balance
   * alone (gas shortfall is the gas-floor alert's job).
   *
   * Fails OPEN on an unreadable balance: broadcast failure already
   * reverses the debit cleanly, and a provider outage must not freeze
   * withdrawals any harder than it already does.
   */
  private async assertTreasuryCoverage(
    custody: CustodyAccount | null,
    asset: AssetDef,
    tx: Transaction,
  ): Promise<void> {
    const treasury = custody?.treasuryAddress ?? custody?.baseAddress;
    if (!treasury) return;
    let onchain: number;
    let needed: number;
    try {
      onchain = parseFloat(await this.provider.getAddressBalance(treasury, asset));
      needed = parseFloat(tx.amount);
      if (asset.type === 'native') {
        try {
          const est = await this.provider.estimateFee(asset, tx.address, tx.amount, treasury);
          needed += parseFloat(est.fee);
        } catch { /* estimator unavailable — gate on amount alone */ }
      }
    } catch (e) {
      this.logger.warn(
        `Treasury pre-check unreadable for ${asset.code} (${errMsg(e)}) — ` +
        `proceeding; a failed broadcast still reverses cleanly`,
      );
      return;
    }
    if (onchain >= needed) return;
    await this.notifier.notifyEvent('treasury.insufficient', {
      chain: asset.chain,
      asset: asset.code,
      treasury,
      balance: String(onchain),
      needed: String(needed),
      transactionId: tx.id,
    });
    throw new ServiceUnavailableException(
      `Treasury underfunded on ${asset.chain}: holds ${onchain} ${asset.code}, ` +
      `withdrawal needs ${needed} — refill custody, then retry`,
    );
  }

  /**
   * Admin approval — broadcast a parked requires_approval withdrawal. The
   * status transition is a conditional UPDATE so concurrent approve/reject
   * calls can't both win (double-broadcast = double spend from the ledger's
   * perspective).
   */
  async approveWithdrawal(id: string): Promise<Transaction> {
    const tx = await this.txs.findOne({ where: { id }, relations: ['wallet'] });
    if (!tx) throw new NotFoundException(`Transaction ${id} not found`);
    const claimed = await this.txs.update(
      { id: tx.id, status: 'requires_approval' },
      { status: 'pending' },
    );
    if (!claimed.affected) {
      throw new BadRequestException(`tx ${id} is ${tx.status}, not requires_approval`);
    }
    const asset = getAsset(tx.asset);
    if (!asset) throw new BadRequestException(`Unsupported asset: ${tx.asset}`);
    const account = await this.accounts.findOne({
      where: { wallet: { id: tx.wallet.id }, chain: asset.chain },
      relations: ['wallet'],
    });
    if (!account) throw new NotFoundException(`No ${asset.chain} account on wallet`);
    tx.status = 'pending';
    return this.broadcastPending(tx, account, asset);
  }

  /** Admin rejection — park released, debit reversed. Conditional claim, same race guard. */
  async rejectWithdrawal(id: string): Promise<Transaction> {
    const tx = await this.txs.findOne({ where: { id }, relations: ['wallet'] });
    if (!tx) throw new NotFoundException(`Transaction ${id} not found`);
    await this.dataSource.transaction(async (em) => {
      const claimed = await em.update(
        Transaction,
        { id: tx.id, status: 'requires_approval' },
        { status: 'rejected' },
      );
      if (!claimed.affected) {
        throw new BadRequestException(`tx ${id} is ${tx.status}, not requires_approval`);
      }
      await this.ledger.postEntry(
        em, tx.wallet, tx, 'withdrawal_reversal', tx.amount, 'credit',
      );
    });
    tx.status = 'rejected';
    await this.notifier.notify('withdrawal.rejected', tx);
    return tx;
  }

  async get(id: string, appId: string): Promise<Transaction> {
    const tx = await this.txs.findOne({ where: { id }, relations: ['wallet'] });
    if (!tx || tx.wallet?.appId !== appId) {
      throw new NotFoundException(`Transaction ${id} not found`);
    }
    return tx;
  }

  /**
   * App-wide transaction feed — everything the tenant's key can see,
   * flattened. Internal consolidation rows (sweeps, gas pumps) are excluded:
   * they're custody plumbing, not user activity, and would read as phantom
   * outbound sends in a client feed. Each row carries externalUserId so the
   * caller can attribute txs to their own users without joining wallets.
   * `raw` (provider payloads, KMS request ids) stays off the wire.
   */
  async listForApp(appId: string, q: ListTransactionsDto) {
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
    const page = Math.max(q.page ?? 1, 1);

    const qb = this.txs
      .createQueryBuilder('t')
      .innerJoin('t.wallet', 'w')
      .addSelect('w.externalUserId')
      .where('w.appId = :appId', { appId })
      .andWhere(`t.raw ->> 'internal' IS NULL`)
      .orderBy('t.createdAt', 'DESC')
      .addOrderBy('t.id', 'DESC')
      .take(limit)
      .skip((page - 1) * limit);

    if (q.direction) qb.andWhere('t.direction = :direction', { direction: q.direction });
    if (q.status) qb.andWhere('t.status = :status', { status: q.status });
    if (q.asset) {
      const asset = getAsset(q.asset);
      if (!asset) throw new BadRequestException(`Unsupported asset: ${q.asset}`);
      qb.andWhere('t.asset = :asset', { asset: asset.code });
    }
    if (q.chain) {
      const chain = q.chain.toUpperCase();
      const valid = new Set<string>(ASSET_REGISTRY.map((a) => a.chain));
      if (!valid.has(chain)) {
        throw new BadRequestException(
          `Unsupported chain: ${q.chain} (supported: ${[...valid].join(', ')})`,
        );
      }
      qb.andWhere('t.chain = :chain', { chain });
    }
    if (q.externalUserId) {
      qb.andWhere('w.externalUserId = :externalUserId', { externalUserId: q.externalUserId });
    }
    if (q.reference) qb.andWhere('t.reference = :reference', { reference: q.reference });
    if (q.txid) qb.andWhere('t.txid = :txid', { txid: q.txid });

    const [rows, total] = await qb.getManyAndCount();
    const data = rows.map(({ raw: _r, wallet, ...t }) => ({
      ...t,
      externalUserId: wallet?.externalUserId,
    }));
    return { data, total, page, limit };
  }

  /**
   * Format check for client UIs — the same pre-broadcast gate POST
   * /withdrawals applies (charset/length/prefix, not checksum). 200 with
   * {valid:false} is the answer, not an error; only an unknown chain or
   * asset 400s. `asset` resolves its chain (USDT_TRC20 → TRON).
   */
  validateAddress(
    address: string,
    chainOrAsset: { asset?: string; chain?: string },
  ): { address: string; chain: string; valid: boolean } {
    let chain: string | undefined;
    if (chainOrAsset.asset) {
      const asset = getAsset(chainOrAsset.asset);
      if (!asset) throw new BadRequestException(`Unsupported asset: ${chainOrAsset.asset}`);
      chain = asset.chain;
    } else if (chainOrAsset.chain) {
      chain = chainOrAsset.chain.toUpperCase();
      const valid = new Set<string>(ASSET_REGISTRY.map((a) => a.chain));
      if (!valid.has(chain)) {
        throw new BadRequestException(
          `Unsupported chain: ${chainOrAsset.chain} (supported: ${[...valid].join(', ')})`,
        );
      }
    } else {
      throw new BadRequestException('Pass either asset or chain');
    }
    return {
      address,
      chain,
      valid: !!address && isPlausibleAddress(chain as Chain, address),
    };
  }

  async estimateFee(assetCode: string, toAddress: string | undefined, amount: string) {
    const asset = getAsset(assetCode);
    if (!asset) throw new BadRequestException(`Unsupported asset: ${assetCode}`);
    if (toAddress && !isPlausibleAddress(asset.chain, toAddress)) {
      throw new BadRequestException(
        `${toAddress} is not a valid ${asset.chain} address format`,
      );
    }
    // Withdrawals spend from the chain treasury — UTXO fee estimates need
    // the real source address to count inputs.
    const custody = await this.dataSource.getRepository(CustodyAccount)
      .findOne({ where: { chain: asset.chain } });
    return this.provider.estimateFee(asset, toAddress, amount, custody?.treasuryAddress);
  }

  requiredConfirmations(chain: string): number {
    const map = this.config.get<Record<string, number>>('confirmations') ?? {};
    return map[chain] ?? 1;
  }
}
