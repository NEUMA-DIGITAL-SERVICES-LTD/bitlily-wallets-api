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

/**
 * Pre-derived custody addresses awaiting assignment. Needed for chains whose
 * addresses CANNOT be derived from an xpub at runtime — Solana is ed25519
 * (hardened-only derivation): each unique address requires KMS key material,
 * and the tatum-kms daemon exposes no derivation API (`getaddress` is
 * CLI-only). So addresses are derived in a batch on the KMS host
 * (scripts/sol-pool-seed.js) and bulk-imported via POST /admin/address-pool.
 *
 * A row is free while `account` is NULL; allocation marks it assigned to the
 * wallet's chain account. The assigned index signs sweeps via the custody
 * signatureId + derivationIndex — the same model as xpub-derived chains,
 * with derivation happening offline instead of via Tatum's xpub endpoint.
 */
@Entity('address_pool')
@Unique(['chain', 'derivationIndex'])
@Unique(['address'])
export class AddressPool {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  chain: string;

  @Column({ name: 'derivation_index', type: 'int' })
  derivationIndex: number;

  @Column()
  address: string;

  /** NULL while free; set to the wallet's chain account on allocation. */
  @ManyToOne(() => WalletAccount, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'wallet_account_id' })
  account: WalletAccount | null;

  @Column({ name: 'assigned_at', type: 'timestamptz', nullable: true })
  assignedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
