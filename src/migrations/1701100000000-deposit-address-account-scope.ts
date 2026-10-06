import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Scope the (address, asset) dedupe to the owning wallet account.
 * The global UNIQUE(address, asset) assumed one row per on-chain
 * address — true for HD-derived addresses (globally unique per index)
 * but false for shared custody base addresses: every wallet's SOL
 * account points at the same enrolled address, so the SECOND wallet to
 * request a SOL deposit address violated the constraint and 500'd
 * (live-caught). Per-account scope keeps the dedupe guarantee while
 * letting each wallet hold its own row for a shared address.
 *
 * NOTE: shared addresses are watched per-wallet but never auto-credited
 * — DepositPollerService skips any (address, asset) mapped to >1 wallet
 * because a balance delta cannot attribute ownership. Crediting the
 * wrong wallet is a fund loss; unattributed deposits surface via
 * reconciliation until per-user memo attribution exists.
 */
export class DepositAddressAccountScope1701100000000 implements MigrationInterface {
  name = 'DepositAddressAccountScope1701100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "UQ_deposit_address_asset"`);
    await q.query(
      `CREATE UNIQUE INDEX "UQ_deposit_address_asset" ON "deposit_addresses" ("wallet_account_id", "address", "asset")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    // Recreating the global unique is unsafe if shared-address rows now
    // exist across wallets — keep only the oldest row per (address, asset).
    await q.query(
      `DELETE FROM "deposit_addresses" a USING "deposit_addresses" b
       WHERE a.address = b.address AND a.asset = b.asset
         AND a.wallet_account_id <> b.wallet_account_id
         AND a.created_at > b.created_at`,
    );
    await q.query(`DROP INDEX "UQ_deposit_address_asset"`);
    await q.query(
      `CREATE UNIQUE INDEX "UQ_deposit_address_asset" ON "deposit_addresses" ("address", "asset")`,
    );
  }
}
