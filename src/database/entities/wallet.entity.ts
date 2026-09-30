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
export class Wallet {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The user ID in the main Bitlily application. */
  @Index({ unique: true })
  @Column({ name: 'external_user_id' })
  externalUserId: string;

  @OneToMany(() => WalletAccount, (a) => a.wallet, { cascade: true })
  accounts: WalletAccount[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
