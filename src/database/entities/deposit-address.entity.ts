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
import { WalletAccount } from './wallet-account.entity';

export type DepositAddressStatus = 'active' | 'used' | 'retired';

/**
 * A blockchain deposit address derived for a wallet account. `reference`
 * supports Selly-style per-order/per-invoice addresses — pass the main app's
 * order/invoice ID and it is echoed back in deposit webhooks.
 */
/**
 * The watched tuple is (account, address, asset): on account-model chains
 * (SOL) the same custody base address legitimately appears once per asset
 * PER WALLET (all wallets share one enrolled custody address), and on EVM
 * a token deposit address may coincide with the native one.
 */
@Entity('deposit_addresses')
@Unique(['account', 'address', 'asset'])
export class DepositAddress {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => WalletAccount, (a) => a.depositAddresses, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'wallet_account_id' })
  account: WalletAccount;

  @Index()
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

  /** Cumulative amount already credited from this address (delta detection). */
  @Column({ name: 'credited_amount', type: 'numeric', precision: 38, scale: 18, default: '0' })
  creditedAmount: string;

  /** For per-order addresses: polling stops after this. NULL = no expiry. */
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
