import { Injectable, Logger } from '@nestjs/common';
import { InjectEntityManager, InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { LedgerEntry, LedgerKind } from '../database/entities/ledger-entry.entity';
import { Wallet } from '../database/entities/wallet.entity';
import { Transaction } from '../database/entities/transaction.entity';

/**
 * Own ledger — the service's source of truth for user balances.
 *
 * Why not Tatum Virtual Accounts? VA is gated to pre-2025-11-24 accounts and
 * adds a black-box dependency for a ledger we must own anyway. Entries here
 * are append-only, written inside the same DB transaction as the on-chain
 * Transaction record, and idempotent on (transactionId, kind).
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(
    @InjectRepository(LedgerEntry)
    private readonly entries: Repository<LedgerEntry>,
    @InjectEntityManager()
    private readonly em: EntityManager,
  ) {}

  /**
   * Post an entry inside an existing transaction (call within em.transaction).
   * Returns the entry, or the existing one if this (tx, kind) was already
   * posted — safe to call on webhook replays.
   */
  async postEntry(
    manager: EntityManager,
    wallet: Wallet,
    tx: Transaction,
    kind: LedgerKind,
    amount: string,
    direction: 'credit' | 'debit',
  ): Promise<LedgerEntry> {
    // Defense-in-depth: the ledger only ever moves positive amounts. A
    // negative 'debit' is a credit — reject it at the boundary rather than
    // trusting every upstream validator (a past IsNumberString DTO admitted
    // '-5' and posted a negative debit live).
    if (!(parseFloat(amount) > 0)) {
      throw new Error(`Refusing non-positive ledger amount: ${amount} (${kind})`);
    }
    const existing = await manager.findOne(LedgerEntry, {
      where: { transaction: { id: tx.id }, kind },
    });
    if (existing) return existing;
    const entry = manager.create(LedgerEntry, {
      wallet, transaction: tx, kind, amount, direction, asset: tx.asset,
    });
    return manager.save(entry);
  }

  /** Confirmed balance = credits - debits for an asset. */
  async getBalance(walletId: string, asset: string): Promise<string> {
    const row = await this.entries
      .createQueryBuilder('e')
      .select(
        `COALESCE(SUM(CASE WHEN e.direction='credit' THEN e.amount ELSE -e.amount END), 0)`,
        'balance',
      )
      .where('e.wallet_id = :walletId', { walletId })
      .andWhere('e.asset = :asset', { asset })
      .getRawOne<{ balance: string }>();
    return row?.balance ?? '0';
  }

  /** All asset balances for a wallet. */
  async getBalances(walletId: string): Promise<{ asset: string; balance: string }[]> {
    return this.entries
      .createQueryBuilder('e')
      .select('e.asset', 'asset')
      .addSelect(
        `SUM(CASE WHEN e.direction='credit' THEN e.amount ELSE -e.amount END)`,
        'balance',
      )
      .where('e.wallet_id = :walletId', { walletId })
      .groupBy('e.asset')
      .getRawMany<{ asset: string; balance: string }>();
  }
}
