import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Wallet } from './wallet.entity';
import { DepositAddress } from './deposit-address.entity';

/**
 * One row per (wallet, asset). Holds the provider-side references needed to
 * derive deposit addresses. Secrets (mnemonics/keys) are NEVER stored here —
 * only xpubs and public addresses. Signing material lives in KMS/env.
 */
@Entity('wallet_accounts')
@Unique(['wallet', 'asset'])
export class WalletAccount {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Wallet, (w) => w.accounts, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'wallet_id' })
  wallet: Wallet;

  /** Canonical asset code from the registry, e.g. BTC, USDT_TRON, USDC_MATIC. */
  @Column()
  asset: string;

  /** Chain this asset settles on, e.g. BTC, LTC, ETH, POLYGON, SOL, TRON. */
  @Column()
  chain: string;

  /** Extended public key (HD chains) used to derive deposit addresses. */
  @Column({ nullable: true })
  xpub: string;

  /** Base address for account-model chains without xpub (e.g. SOL). */
  @Column({ name: 'base_address', nullable: true })
  baseAddress: string;

  /** Next unused HD derivation index for this account. */
  @Column({ name: 'next_derivation_index', type: 'int', default: 0 })
  nextDerivationIndex: number;

  @OneToMany(() => DepositAddress, (d) => d.account)
  depositAddresses: DepositAddress[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
