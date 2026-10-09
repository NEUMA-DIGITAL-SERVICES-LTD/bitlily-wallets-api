import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `reference` replaces `idempotency_key` as the caller-owned dedupe token
 * for outbound sends. The partial unique index preserves the atomic
 * guarantee for the hot path — two concurrent first-sends on ONE wallet
 * race into the index, the loser's debit rolls back, and it re-reads the
 * winner's row. Cross-wallet same-app duplicates are caught by the
 * appId-scoped lookup in send() (a join can't be expressed in an index).
 * The old UQ_tx_idempotency index + column stay: existing rows keep their
 * history and the column is harmless legacy.
 */
export class ReferenceIdempotency1701100000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE UNIQUE INDEX "UQ_tx_reference" ON "transactions" ("wallet_id", "reference") WHERE "reference" IS NOT NULL AND "direction" = 'outbound'`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "UQ_tx_reference"`);
  }
}
