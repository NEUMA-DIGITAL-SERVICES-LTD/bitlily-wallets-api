import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Runtime API-client registry. Env API_CLIENTS remains the ops-seeded
 * source; this table holds apps registered via POST /api/v1/admin/clients
 * without a redeploy.
 */
export class ApiClients1701000000000 implements MigrationInterface {
  name = 'ApiClients1701000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "api_clients" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" varchar NOT NULL,
        "name" varchar NULL,
        "api_key" varchar NOT NULL,
        "webhook_url" varchar NULL,
        "webhook_secret" varchar NULL,
        "scopes" jsonb NOT NULL DEFAULT '["wallet"]',
        "active" boolean NOT NULL DEFAULT true,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_api_clients" PRIMARY KEY ("id")
      )`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_api_clients_slug" ON "api_clients" ("slug")`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_api_clients_key" ON "api_clients" ("api_key")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "api_clients"`);
  }
}
