import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Runtime-registered API client (tenant). Env API_CLIENTS still resolve
 * (ops-seeded entries); this table is for apps added without a redeploy.
 * apiKey is a credential — treated like a password in responses (returned
 * once at creation, masked everywhere else).
 */
@Entity('api_clients')
export class ApiClient {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Tenant slug stamped on wallets.app_id. */
  @Index({ unique: true })
  @Column()
  slug: string;

  @Column({ nullable: true })
  name: string;

  @Index({ unique: true })
  @Column({ name: 'api_key' })
  apiKey: string;

  /** Where this app's deposit/withdrawal events are POSTed. */
  @Column({ name: 'webhook_url', nullable: true })
  webhookUrl: string;

  /** HMAC secret for X-Webhook-Signature on this app's events. */
  @Column({ name: 'webhook_secret', nullable: true })
  webhookSecret: string;

  /**
   * 'wallet' = full tenant access (wallets, addresses, sends).
   * 'read'  = shared/general endpoints only (fees, health) — the key
   * can never create wallets or move funds.
   */
  @Column({ type: 'jsonb', default: '["wallet"]' })
  scopes: string[];

  @Column({ default: true })
  active: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
