import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Transaction } from '../../database/entities/transaction.entity';
import { WalletAccount } from '../../database/entities/wallet-account.entity';
import { CustodyAccount } from '../../database/entities/custody-account.entity';
import { AssetDef, getAsset } from '../../config/assets';
import {
  BLOCKCHAIN_PROVIDER,
  BlockchainProvider,
} from '../../providers/provider.interface';
import { LedgerService } from '../../ledger/ledger.service';
import { NotifierService } from '../notifications/notifier.service';
import { SendTransactionDto } from './transactions.dto';
import { errMsg } from '../../common/errors';

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    @InjectRepository(Transaction) private readonly txs: Repository<Transaction>,
    @InjectRepository(WalletAccount) private readonly accounts: Repository<WalletAccount>,
    @Inject(BLOCKCHAIN_PROVIDER) private readonly provider: BlockchainProvider,
    private readonly ledger: LedgerService,
    private readonly notifier: NotifierService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Outbound send/withdrawal.
   *
   * Order matters: the ledger debit is posted inside the same DB transaction
   * as the Transaction row BEFORE broadcast, so a crash mid-broadcast can be
   * reconciled (tx row exists with status=pending and no txid). Broadcasting
   * first and recording after is how funds get double-sent.
   */
  async send(dto: SendTransactionDto): Promise<Transaction> {
    const asset = getAsset(dto.asset);
    if (!asset) throw new BadRequestException(`Unsupported asset: ${dto.asset}`);

    // Accounts are per-chain — a token send signs via its chain's account.
    const account = await this.accounts.findOne({
      where: { wallet: { id: dto.walletId }, chain: asset.chain },
      relations: ['wallet'],
    });
    if (!account) throw new NotFoundException(`No ${asset.chain} account on wallet`);

    // Guard: ledger must cover the send.
    const balance = await this.ledger.getBalance(dto.walletId, asset.code);
    if (parseFloat(balance) < parseFloat(dto.amount)) {
      throw new BadRequestException(
        `Insufficient ${asset.code} balance: have ${balance}, need ${dto.amount}`,
      );
    }

    // Withdrawal policy — circuit breakers, applied before any debit.
    const limits = this.config.get('limits') ?? { maxPerTx: {}, approvalAbove: {} };
    const max = limits.maxPerTx?.[asset.code];
    if (max && parseFloat(dto.amount) > parseFloat(max)) {
      throw new BadRequestException(
        `Amount ${dto.amount} ${asset.code} exceeds per-transaction limit ${max}`,
      );
    }
    const needsApproval = (() => {
      const thr = limits.approvalAbove?.[asset.code];
      return thr ? parseFloat(dto.amount) >= parseFloat(thr) : false;
    })();

    // Debit + pending row FIRST, atomically — a crash between here and
    // broadcast leaves a reconcilable pending row (placeholder txid).
    // Broadcasting first and recording after is how funds get double-sent
    // or moved without a ledger record.
    const tx = await this.dataSource.transaction(async (em) => {
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
      // address named explicitly as the UTXO source.
      const custody = await this.dataSource.getRepository(CustodyAccount)
        .findOne({ where: { chain: asset.chain } });
      const result = await this.provider.sendTransaction({
        asset,
        fromAccountId: account.id,
        signatureId: account.secretRef,
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
      await this.notifier.notify('transaction.broadcast', tx);
      return tx;
    } catch (e) {
      // Broadcast failed — reverse the debit so the ledger stays truthful.
      await this.dataSource.transaction(async (em) => {
        await em.update(Transaction, tx.id, { status: 'failed' });
        await this.ledger.postEntry(
          em, account.wallet, tx, 'withdrawal_reversal', tx.amount, 'credit',
        );
      });
      if (e instanceof BadGatewayException) throw e;
      throw new BadGatewayException(`Broadcast failed: ${errMsg(e)}`);
    }
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

  async get(id: string): Promise<Transaction> {
    const tx = await this.txs.findOne({ where: { id } });
    if (!tx) throw new NotFoundException(`Transaction ${id} not found`);
    return tx;
  }

  async estimateFee(assetCode: string, toAddress: string, amount: string) {
    const asset = getAsset(assetCode);
    if (!asset) throw new BadRequestException(`Unsupported asset: ${assetCode}`);
    return this.provider.estimateFee(asset, toAddress, amount);
  }

  requiredConfirmations(chain: string): number {
    const map = this.config.get<Record<string, number>>('confirmations') ?? {};
    return map[chain] ?? 1;
  }
}
