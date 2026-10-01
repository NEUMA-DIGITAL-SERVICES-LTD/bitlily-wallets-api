import { MigrationInterface, QueryRunner } from 'typeorm';

export class OutboundEvents1700300000000 implements MigrationInterface {
  name = 'OutboundEvents1700300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "outbound_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "event" character varying NOT NULL,
        "transaction_id" uuid,
        "payload" jsonb NOT NULL,
        "status" character varying NOT NULL DEFAULT 'pending',
        "attempts" integer NOT NULL DEFAULT 0,
        "last_error" text,
        "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "sent_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_outbound_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_oe_tx" FOREIGN KEY ("transaction_id")
          REFERENCES "transactions"("id") ON DELETE SET NULL
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_oe_status" ON "outbound_events" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_oe_next_attempt" ON "outbound_events" ("next_attempt_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_oe_tx" ON "outbound_events" ("transaction_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "outbound_events"`);
  }
}
