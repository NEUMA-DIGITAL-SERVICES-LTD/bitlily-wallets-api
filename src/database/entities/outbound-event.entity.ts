import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Transaction } from './transaction.entity';

export type OutboundStatus = 'pending' | 'sent' | 'dead';

/**
 * Outbound webhook outbox — durable record of every notification owed to the
 * main Bitlily app. Fire-and-forget HTTP loses events whenever the consumer
 * is down; financial events must survive consumer outages. Rows are written
 * in the same DB transaction as the state change (eventually — the poller
 * writes after commit for now) and retried with exponential backoff until
 * delivered or dead-lettered.
 */
@Entity('outbound_events')
export class OutboundEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Event type, e.g. deposit.pending, deposit.confirmed. */
  @Column()
  event: string;

  @ManyToOne(() => Transaction, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'transaction_id' })
  transaction: Transaction;

  @Index()
  @Column({ name: 'transaction_id', nullable: true })
  transactionId: string;

  /** Fully-rendered JSON body sent to the consumer (signed payload). */
  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Index()
  @Column({ default: 'pending' })
  status: OutboundStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string;

  /** Next eligible delivery time — exponential backoff gate. */
  @Index()
  @Column({ name: 'next_attempt_at', type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt: Date;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
