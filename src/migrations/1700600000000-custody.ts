import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Custody substrate:
 * - custody_accounts: one enrolled KMS master wallet per chain (xpub +
 *   signatureId), populated via the admin enrollment endpoint after the
 *   operator runs `tatum-kms generatemanagedwallet {chain}`.
 * - chain_counters: global HD derivation index per chain. With a shared
 *   xpub, per-wallet counters would collide — index allocation is global.
 */
export class Custody1700600000000 implements MigrationInterface {
  name = 'Custody1700600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "custody_accounts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "chain" varchar NOT NULL,
        "xpub" varchar,
        "base_address" varchar,
        "secret_ref" varchar NOT NULL,
        "treasury_address" varchar,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_custody_accounts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_custody_chain" UNIQUE ("chain")
      )
    `);
    await q.query(`
      CREATE TABLE "chain_counters" (
        "chain" varchar NOT NULL,
        "next_index" int NOT NULL DEFAULT 0,
        CONSTRAINT "PK_chain_counters" PRIMARY KEY ("chain")
      )
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "chain_counters"`);
    await q.query(`DROP TABLE "custody_accounts"`);
  }
}
