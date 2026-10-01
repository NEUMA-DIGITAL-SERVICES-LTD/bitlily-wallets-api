import { MigrationInterface, QueryRunner } from 'typeorm';

/** Polling-based deposit detection: per-address credited delta + expiry. */
export class DepositPolling1700100000000 implements MigrationInterface {
  name = 'DepositPolling1700100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "deposit_addresses"
        ADD COLUMN "credited_amount" numeric(38,18) NOT NULL DEFAULT 0,
        ADD COLUMN "expires_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_da_poll" ON "deposit_addresses" ("status", "expires_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_da_poll"`);
    await queryRunner.query(
      `ALTER TABLE "deposit_addresses"
        DROP COLUMN "credited_amount",
        DROP COLUMN "expires_at"`,
    );
  }
}
