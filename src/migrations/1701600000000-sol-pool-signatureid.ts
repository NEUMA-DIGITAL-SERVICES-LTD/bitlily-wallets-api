import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Correct the address_pool model after live verification: Tatum's managed
 * SOL wallet is a PRIVATE-KEY type signatureId — `getaddress {sigId} {i}`
 * returns the same address for every index, so index-based derivation is
 * impossible for SOL. Per-user unique addresses mean per-user signatureIds
 * (one `generatemanagedwallet SOL` per pooled address on the KMS host).
 *
 * The 1701500000000 table is dropped and recreated with signature_id —
 * it only ever held test rows.
 */
export class SolPoolSignatureId1701600000000 implements MigrationInterface {
  name = 'SolPoolSignatureId1701600000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS address_pool`);
    await q.query(
      `CREATE TABLE address_pool (
         id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
         chain varchar NOT NULL,
         signature_id varchar NOT NULL,
         derivation_index int,
         address varchar NOT NULL,
         wallet_account_id uuid REFERENCES wallet_accounts(id) ON DELETE SET NULL,
         assigned_at timestamptz,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_address_pool_address
         ON address_pool (address)`,
    );
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_address_pool_sig
         ON address_pool (signature_id)`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS idx_address_pool_free
         ON address_pool (chain) WHERE wallet_account_id IS NULL`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS address_pool`);
  }
}
