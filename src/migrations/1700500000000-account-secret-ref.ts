import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * wallet_accounts.secret_ref — the opaque custody handle (KMS signatureId)
 * for the chain's enrolled signing material. Nullable: dev env-key signing
 * stores nothing. Contains a reference only, never secret material.
 */
export class AccountSecretRef1700500000000 implements MigrationInterface {
  name = 'AccountSecretRef1700500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "wallet_accounts" ADD COLUMN "secret_ref" varchar`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "wallet_accounts" DROP COLUMN "secret_ref"`);
  }
}
