import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SOL shared-address deposit attribution: every wallet's SOL chain account
 * carries a globally-unique deposit memo (the Binance/Kraken destination-tag
 * model — one address per chain, the sender writes the memo into the tx's
 * Memo program instruction, the poller attributes by exact match).
 *
 * Memo lives on wallet_accounts (one row per wallet+chain) so all of a
 * wallet's same-chain watch rows attribute through a single code — the
 * client shows ONE memo and SPL/native deposits resolve identically.
 * Unique globally because the shared base address is one pot across ALL
 * tenants: a memo must resolve to exactly one account or attribution is
 * ambiguous. NULLs (HD chains) are excluded by the partial index.
 */
export class SolDepositMemos1701300000000 implements MigrationInterface {
  name = 'SolDepositMemos1701300000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE wallet_accounts ADD COLUMN IF NOT EXISTS memo varchar(64)`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_accounts_memo ` +
      `ON wallet_accounts (memo) WHERE memo IS NOT NULL`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS uq_wallet_accounts_memo`);
    await q.query(`ALTER TABLE wallet_accounts DROP COLUMN IF EXISTS memo`);
  }
}
