import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { WalletAccount } from './wallet-account.entity';

/**
 * A Wallet is our internal custodial grouping for one Bitlily end-user.
 * It owns per-asset accounts (WalletAccount) that map to provider-side
 * chain material (xpub / base address).
 */
@Entity('wallets')
@Index('UQ_wallets_app_external', ['appId', 'externalUserId'], { unique: true })
export class Wallet {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Owning API client (tenant). Service keys resolve to an appId; every
   * wallet lookup is scoped by it so one app can never touch another's
   * users. 'default' = legacy SERVICE_API_KEYS callers. */
  @Index()
  @Column({ name: 'app_id', default: 'default' })
  appId: string;

  /** The user ID in the calling application — unique PER APP, not globally. */
  @Column({ name: 'external_user_id' })
  externalUserId: string;

  @OneToMany(() => WalletAccount, (a) => a.wallet, { cascade: true })
  accounts: WalletAccount[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
