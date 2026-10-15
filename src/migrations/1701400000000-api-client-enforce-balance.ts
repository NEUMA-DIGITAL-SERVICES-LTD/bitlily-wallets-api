import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-client balance-enforcement flag — fiat-funded crypto withdrawals
 * never have a preceding on-chain deposit, so a client whose backend is
 * the balance authority opts out (enforce_balance=false). The debit
 * still posts; negative wallet balances then mean "the app's ledger
 * owes custody", and the reconciler floors per-wallet liabilities at 0
 * so overdrafts can't mask a real divergence.
 */
export class ApiClientEnforceBalance1701400000000 implements MigrationInterface {
  name = 'ApiClientEnforceBalance1701400000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE api_clients ADD COLUMN IF NOT EXISTS enforce_balance boolean NOT NULL DEFAULT true`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE api_clients DROP COLUMN IF EXISTS enforce_balance`);
  }
}
