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
 * One row per (wallet, chain) — NOT per asset. Assets on the same chain
 * (ETH, USDT_ETH, USDC_ETH) share one xpub and one derivation counter;
 * per-asset accounts would independently derive index 0 → same address →
 * collisions on the deposit_addresses unique index.
 * Secrets (mnemonics/keys) are NEVER stored here — only xpubs and public
 * addresses. Signing material lives in KMS/env.
 */
@Entity('wallet_accounts')
@Unique(['wallet', 'chain'])
export class WalletAccount {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Wallet, (w) => w.accounts, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'wallet_id' })
  wallet: Wallet;

  /** Settlement chain, e.g. BTC, LTC, ETH, POLYGON, SOL, TRON. */
  @Column()
  chain: string;

  /** Extended public key (HD chains) used to derive deposit addresses. */
  @Column({ nullable: true })
  xpub: string;

  /** Base address for account-model chains without xpub (e.g. SOL). */
  @Column({ name: 'base_address', nullable: true })
  baseAddress: string;

  /**
   * Deposit memo for shared-custody chains (SOL): the sender writes this
   * into the tx's Memo program instruction and the poller attributes the
   * deposit by exact match. Globally unique — the shared base address is
   * one pot across all tenants, so a memo must resolve to exactly one
   * account. One memo covers every same-chain asset (SOL + SPL tokens).
   */
  @Index('uq_wallet_accounts_memo', { unique: true })
  @Column({ type: 'varchar', length: 64, nullable: true })
  memo: string | null;

  /**
   * Opaque custody reference — under KMS this is the Tatum KMS
   * signatureId for the enrolled mnemonic/key. Null under dev env-key
   * signing. NEVER contains secret material itself.
   */
  @Column({ name: 'secret_ref', nullable: true })
  secretRef: string | null;

  /** Next unused HD derivation index for this account. */
  @Column({ name: 'next_derivation_index', type: 'int', default: 0 })
  nextDerivationIndex: number;

  @OneToMany(() => DepositAddress, (d) => d.account)
  depositAddresses: DepositAddress[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
