import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pre-derived SOL deposit address pool. Solana is ed25519 — hardened-only
 * derivation, no xpub — so per-user unique addresses can't be minted
 * server-side. `tatum-kms getaddress {signatureId} {index}` runs on the KMS
 * host and the results are bulk-imported here; wallet provisioning assigns
 * free rows. Signing uses the custody signatureId + the row's index, the
 * same model as xpub-derived chains.
 */
export class SolAddressPool1701500000000 implements MigrationInterface {
  name = 'SolAddressPool1701500000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE IF NOT EXISTS address_pool (
         id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
         chain varchar NOT NULL,
         derivation_index int NOT NULL,
         address varchar NOT NULL,
         wallet_account_id uuid REFERENCES wallet_accounts(id) ON DELETE SET NULL,
         assigned_at timestamptz,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_address_pool_chain_idx
         ON address_pool (chain, derivation_index)`,
    );
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_address_pool_address
         ON address_pool (address)`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS idx_address_pool_chain ON address_pool (chain)`,
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
