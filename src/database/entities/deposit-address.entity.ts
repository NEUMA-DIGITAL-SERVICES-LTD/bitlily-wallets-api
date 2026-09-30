import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { WalletAccount } from './wallet-account.entity';

export type DepositAddressStatus = 'active' | 'used' | 'retired';

/**
 * A blockchain deposit address derived for a wallet account. `reference`
 * supports Selly-style per-order/per-invoice addresses — pass the main app's
 * order/invoice ID and it is echoed back in deposit webhooks.
 */
@Entity('deposit_addresses')
export class DepositAddress {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => WalletAccount, (a) => a.depositAddresses, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'wallet_account_id' })
  account: WalletAccount;

  @Index({ unique: true })
  @Column()
  address: string;

  @Column()
  chain: string;

  @Column()
  asset: string;

  @Column({ name: 'derivation_index', type: 'int', nullable: true })
  derivationIndex: number;

  /** Client-supplied reference (order/invoice ID) for per-payment addresses. */
  @Column({ nullable: true })
  reference: string;

  @Column({ default: 'active' })
  status: DepositAddressStatus;

  /** Provider-side subscription ID for address monitoring, if created. */
  @Column({ name: 'subscription_id', nullable: true })
  subscriptionId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
