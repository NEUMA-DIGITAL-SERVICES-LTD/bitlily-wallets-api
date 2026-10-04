import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Withdrawal idempotency: callers retrying a timed-out send must get the
 * original transaction back, not a second debit + broadcast. The key is
 * optional — a partial unique index means rows without a key can never
 * collide (Postgres treats NULLs as distinct anyway, the partial index is
 * explicit about intent).
 */
export class WithdrawalIdempotency1700700000000 implements MigrationInterface {
  name = 'WithdrawalIdempotency1700700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "transactions" ADD COLUMN "idempotency_key" character varying`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_tx_idempotency" ON "transactions" ("wallet_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "UQ_tx_idempotency"`);
    await q.query(`ALTER TABLE "transactions" DROP COLUMN "idempotency_key"`);
  }
}
