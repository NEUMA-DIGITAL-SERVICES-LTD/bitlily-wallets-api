import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Wallet } from './wallet.entity';

export type TxDirection = 'inbound' | 'outbound';
export type TxStatus =
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'reorged'
  | 'requires_approval'
  | 'rejected';

/**
 * An observed or initiated on-chain transaction. Uniqueness on
 * (txid, address, asset) is the idempotency boundary: a deposit can only be
 * recorded once even if the webhook fires multiple times.
 */
@Entity('transactions')
@Unique(['txid', 'address', 'asset', 'direction'])
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Wallet, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'wallet_id' })
  wallet: Wallet;

  @Column()
  direction: TxDirection;

  @Column()
  chain: string;

  @Column()
  asset: string;

  @Index()
  @Column()
  txid: string;

  /** For inbound: the deposit address that received funds. Outbound: destination. */
  @Column()
  address: string;

  @Column({ type: 'numeric', precision: 38, scale: 18 })
  amount: string;

  @Column({ type: 'numeric', precision: 38, scale: 18, nullable: true })
  fee: string;

  @Column({ default: 'pending' })
  status: TxStatus;

  @Column({ type: 'int', default: 0 })
  confirmations: number;

  @Column({ name: 'required_confirmations', type: 'int', default: 1 })
  requiredConfirmations: number;

  @Column({ name: 'block_number', type: 'bigint', nullable: true })
  blockNumber: number;

  /** Client reference (order/invoice/payout id). For outbound sends this
   * is ALSO the idempotency boundary — unique per (wallet, reference),
   * retries return the original row instead of double-debiting, and a
   * reuse with a different payload is rejected at the API layer. */
  @Column({ nullable: true })
  reference: string;

  /**
   * Legacy caller-supplied idempotency key — superseded by `reference`
   * as the dedupe token (UQ_tx_reference). Column kept for existing rows.
   */
  @Column({ name: 'idempotency_key', nullable: true })
  idempotencyKey: string;

  /** Raw provider payload for auditability. */
  @Column({ type: 'jsonb', nullable: true })
  raw: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
