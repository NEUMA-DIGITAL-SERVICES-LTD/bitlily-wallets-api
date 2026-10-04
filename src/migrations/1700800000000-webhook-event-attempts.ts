import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Webhook events were marked 'processed' even when deferred (tx not yet
 * indexed) — permanently dropped. Retry tracking lets the sweeper
 * reprocess received/failed events instead of relying on the poller.
 */
export class WebhookEventAttempts1700800000000 implements MigrationInterface {
  name = 'WebhookEventAttempts1700800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "webhook_events" ADD COLUMN "attempts" int NOT NULL DEFAULT 0`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "webhook_events" DROP COLUMN "attempts"`);
  }
}
