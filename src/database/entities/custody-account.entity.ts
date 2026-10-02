import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * The chain-level custodial wallet — one row per chain, populated by the
 * admin enrollment endpoint after the operator runs
 * `tatum-kms generatemanagedwallet` on the KMS host.
 *
 * All deposit addresses across all wallets derive from this shared xpub;
 * the derivation index comes from a global per-chain counter
 * (chain_counters) — KMS signs any index via secretRef (signatureId) +
 * index, so key material never enters this service.
 */
@Entity('custody_accounts')
export class CustodyAccount {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  chain: string;

  @Column({ nullable: true })
  xpub: string;

  /** Base address for account-model chains without xpub (e.g. SOL). */
  @Column({ name: 'base_address', nullable: true })
  baseAddress: string;

  /** KMS signatureId for the enrolled master wallet. */
  @Column({ name: 'secret_ref' })
  secretRef: string;

  /**
   * Sweep destination for this chain — set explicitly, or the custody
   * wallet's index-0 address is used.
   */
  @Column({ name: 'treasury_address', nullable: true })
  treasuryAddress: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
