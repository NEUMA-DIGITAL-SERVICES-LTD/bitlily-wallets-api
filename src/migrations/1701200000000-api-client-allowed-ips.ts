import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-client IP allowlist — a stolen ck_ key is worthless outside the
 * tenant's egress CIDRs. NULL = unrestricted (staging, unset tenants).
 */
export class ApiClientAllowedIps1701200000000 implements MigrationInterface {
  name = 'ApiClientAllowedIps1701200000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE api_clients ADD COLUMN IF NOT EXISTS allowed_ips jsonb`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE api_clients DROP COLUMN IF EXISTS allowed_ips`);
  }
}
