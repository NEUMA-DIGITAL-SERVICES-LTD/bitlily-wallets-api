import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export type WebhookEventStatus = 'received' | 'processed' | 'failed';

/**
 * Raw inbound provider webhook events. (provider, externalEventKey) uniqueness
 * is the first idempotency gate — duplicate deliveries are acknowledged with
 * 200 and never reprocessed.
 */
@Entity('webhook_events')
@Unique(['provider', 'externalEventKey'])
export class WebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  provider: string;

  @Column()
  externalEventKey: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ default: 'received' })
  status: WebhookEventStatus;

  @Column({ type: 'text', nullable: true })
  error: string;

  /** Reprocessing counter — deferred/failed events retry via the sweeper. */
  @Column({ default: 0 })
  attempts: number;

  @CreateDateColumn({ name: 'received_at' })
  receivedAt: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date;
}
