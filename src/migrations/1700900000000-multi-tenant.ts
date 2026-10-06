import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-tenancy: wallets belong to an API client (app). Previously any
 * service key could operate any wallet, and external_user_id was globally
 * unique — a second app requesting an existing externalUserId would be
 * handed ANOTHER app's wallet. wallets.app_id scopes ownership, and the
 * external ID unique constraint becomes (app_id, external_user_id).
 * Existing rows backfill to the 'default' client (SERVICE_API_KEYS keys).
 *
 * outbound_events.app_id routes each notification to the owning app's
 * webhookUrl/webhookSecret; NULL rows are ops events on the global channel.
 */
export class MultiTenant1700900000000 implements MigrationInterface {
  name = 'MultiTenant1700900000000';

  public async up(q: QueryRunner): Promise<void> {
    // The unique index on external_user_id is TypeORM-generated (IDX_ hash);
    // resolve its name rather than guessing.
    const idx: { indexname: string }[] = await q.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'wallets'
          AND indexname NOT LIKE 'PK%'
          AND indexdef ILIKE '%external_user_id%'`,
    );
    for (const { indexname } of idx) {
      await q.query(`DROP INDEX IF EXISTS "${indexname}"`);
    }

    await q.query(
      `ALTER TABLE "wallets" ADD COLUMN "app_id" varchar NOT NULL DEFAULT 'default'`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_wallets_app_external"
         ON "wallets" ("app_id", "external_user_id")`,
    );
    await q.query(
      `ALTER TABLE "outbound_events" ADD COLUMN "app_id" varchar NULL`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "outbound_events" DROP COLUMN "app_id"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_wallets_app_external"`);
    await q.query(`ALTER TABLE "wallets" DROP COLUMN "app_id"`);
    await q.query(
      `CREATE UNIQUE INDEX "IDX_wallets_external_user_id"
         ON "wallets" ("external_user_id")`,
    );
  }
}
