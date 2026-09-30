import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Wallet } from './wallet.entity';
import { Transaction } from './transaction.entity';

export type LedgerDirection = 'credit' | 'debit';
export type LedgerKind =
  | 'deposit_confirmed'
  | 'withdrawal'
  | 'withdrawal_reversal'
  | 'adjustment';

/**
 * Append-only ledger — our source of truth for user balances.
 * Entries are written inside the same DB transaction as the Transaction row,
 * and (transactionId, kind) uniqueness makes crediting idempotent.
 */
@Entity('ledger_entries')
@Unique(['transaction', 'kind'])
export class LedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Wallet, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'wallet_id' })
  @Index()
  wallet: Wallet;

  @ManyToOne(() => Transaction, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'transaction_id' })
  transaction: Transaction;

  @Column()
  asset: string;

  @Column({ type: 'numeric', precision: 38, scale: 18 })
  amount: string;

  @Column()
  direction: LedgerDirection;

  @Column()
  kind: LedgerKind;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
