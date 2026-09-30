import { MigrationInterface, QueryRunner } from 'typeorm';

export class Init1700000000000 implements MigrationInterface {
  name = 'Init1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await queryRunner.query(`
      CREATE TABLE "wallets" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "external_user_id" character varying NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_wallets" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_wallets_external_user" ON "wallets" ("external_user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "wallet_accounts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "wallet_id" uuid,
        "asset" character varying NOT NULL,
        "chain" character varying NOT NULL,
        "xpub" character varying,
        "base_address" character varying,
        "next_derivation_index" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_wallet_accounts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_wallet_account_asset" UNIQUE ("wallet_id", "asset"),
        CONSTRAINT "FK_wa_wallet" FOREIGN KEY ("wallet_id")
          REFERENCES "wallets"("id") ON DELETE CASCADE
      )`);

    await queryRunner.query(`
      CREATE TABLE "deposit_addresses" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "wallet_account_id" uuid,
        "address" character varying NOT NULL,
        "chain" character varying NOT NULL,
        "asset" character varying NOT NULL,
        "derivation_index" integer,
        "reference" character varying,
        "status" character varying NOT NULL DEFAULT 'active',
        "subscription_id" character varying,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_deposit_addresses" PRIMARY KEY ("id"),
        CONSTRAINT "FK_da_account" FOREIGN KEY ("wallet_account_id")
          REFERENCES "wallet_accounts"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_deposit_address" ON "deposit_addresses" ("address")`,
    );

    await queryRunner.query(`
      CREATE TABLE "transactions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "wallet_id" uuid,
        "direction" character varying NOT NULL,
        "chain" character varying NOT NULL,
        "asset" character varying NOT NULL,
        "txid" character varying NOT NULL,
        "address" character varying NOT NULL,
        "amount" numeric(38,18) NOT NULL,
        "fee" numeric(38,18),
        "status" character varying NOT NULL DEFAULT 'pending',
        "confirmations" integer NOT NULL DEFAULT 0,
        "required_confirmations" integer NOT NULL DEFAULT 1,
        "block_number" bigint,
        "reference" character varying,
        "raw" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_transactions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_tx_dedupe" UNIQUE ("txid", "address", "asset"),
        CONSTRAINT "FK_tx_wallet" FOREIGN KEY ("wallet_id")
          REFERENCES "wallets"("id") ON DELETE SET NULL
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_tx_txid" ON "transactions" ("txid")`,
    );

    await queryRunner.query(`
      CREATE TABLE "ledger_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "wallet_id" uuid,
        "transaction_id" uuid,
        "asset" character varying NOT NULL,
        "amount" numeric(38,18) NOT NULL,
        "direction" character varying NOT NULL,
        "kind" character varying NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ledger_entries" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_ledger_tx_kind" UNIQUE ("transaction_id", "kind"),
        CONSTRAINT "FK_le_wallet" FOREIGN KEY ("wallet_id")
          REFERENCES "wallets"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_le_tx" FOREIGN KEY ("transaction_id")
          REFERENCES "transactions"("id") ON DELETE SET NULL
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_le_wallet" ON "ledger_entries" ("wallet_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "webhook_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "provider" character varying NOT NULL,
        "external_event_key" character varying NOT NULL,
        "payload" jsonb NOT NULL,
        "status" character varying NOT NULL DEFAULT 'received',
        "error" text,
        "received_at" TIMESTAMP NOT NULL DEFAULT now(),
        "processed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_webhook_events" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_webhook_event" UNIQUE ("provider", "external_event_key")
      )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "webhook_events"`);
    await queryRunner.query(`DROP TABLE "ledger_entries"`);
    await queryRunner.query(`DROP TABLE "transactions"`);
    await queryRunner.query(`DROP TABLE "deposit_addresses"`);
    await queryRunner.query(`DROP TABLE "wallet_accounts"`);
    await queryRunner.query(`DROP TABLE "wallets"`);
  }
}
