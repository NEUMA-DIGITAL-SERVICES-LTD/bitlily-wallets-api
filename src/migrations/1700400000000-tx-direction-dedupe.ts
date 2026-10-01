import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Dedupe key gains `direction`: the same on-chain txid legitimately exists
 * once per direction when a send lands on our own watched address
 * (self-transfers, treasury consolidation). Without it, an inbound credit
 * collides with the outbound row's unique key and is silently orphaned.
 */
export class TxDirectionDedupe1700400000000 implements MigrationInterface {
  name = 'TxDirectionDedupe1700400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "transactions" DROP CONSTRAINT "UQ_tx_dedupe"`);
    await q.query(
      `ALTER TABLE "transactions" ADD CONSTRAINT "UQ_tx_dedupe" UNIQUE ("txid", "address", "asset", "direction")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "transactions" DROP CONSTRAINT "UQ_tx_dedupe"`);
    await q.query(
      `ALTER TABLE "transactions" ADD CONSTRAINT "UQ_tx_dedupe" UNIQUE ("txid", "address", "asset")`,
    );
  }
}
