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
 * Pre-provisioned per-user custody addresses awaiting assignment.
 *
 * Solana is ed25519 — hardened-only derivation, no xpub — and Tatum's SOL
 * wallet is a single private key (no mnemonic, no index derivation):
 * `getaddress {sigId} {anyIndex}` returns the same address forever. So a
 * unique SOL deposit address means a unique KMS signatureId — one
 * `generatemanagedwallet SOL` per address, run on the KMS host
 * (scripts/sol-pool-seed.js) and bulk-imported via POST /admin/address-pool.
 *
 * A row is free while `account` is NULL. Allocation binds it to the wallet's
 * chain account; sweeps sign with the row's OWN signatureId (private-key
 * type — no derivation index), so each user address pays its own way out.
 */
@Entity('address_pool')
@Unique(['address'])
export class AddressPool {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  chain: string;

  /**
   * Private-key-type wallet (SOL): the signatureId IS the key reference.
   * Mnemonic chains could use signatureId+derivationIndex instead — SOL
   * never does, so the column stays nullable.
   */
  @Column({ name: 'signature_id' })
  signatureId: string;

  /** Reserved for mnemonic/xpub-type pool entries; NULL for SOL. */
  @Column({ name: 'derivation_index', type: 'int', nullable: true })
  derivationIndex: number | null;

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
