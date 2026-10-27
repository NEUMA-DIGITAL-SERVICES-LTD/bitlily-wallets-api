import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Renames the BNB Smart Chain identifiers to match the client's
 * vocabulary: chain 'BSC' -> 'BNB' (BNB Chain is the official name;
 * 'BSC' is legacy) and asset 'USDT_BSC' -> 'USDT_BEP20'. Tatum-side
 * codes (REST path 'bsc', currency enum 'BSC', v4 'bsc-testnet') are
 * provider internals and unaffected.
 *
 * Pure value rewrite — no schema change. outbound_events payload
 * snapshots are historical audit records and deliberately left as-is.
 */
export class BnbChainRename1701800000000 implements MigrationInterface {
  name = 'BnbChainRename1701800000000';

  async up(q: QueryRunner): Promise<void> {
    for (const t of ['custody_accounts', 'wallet_accounts', 'deposit_addresses', 'chain_counters', 'transactions', 'address_pool']) {
      await q.query(`UPDATE ${t} SET chain='BNB' WHERE chain='BSC'`);
    }
    for (const t of ['deposit_addresses', 'transactions', 'ledger_entries']) {
      await q.query(`UPDATE ${t} SET asset='USDT_BEP20' WHERE asset='USDT_BSC'`);
    }
  }

  async down(q: QueryRunner): Promise<void> {
    for (const t of ['custody_accounts', 'wallet_accounts', 'deposit_addresses', 'chain_counters', 'transactions', 'address_pool']) {
      await q.query(`UPDATE ${t} SET chain='BSC' WHERE chain='BNB'`);
    }
    for (const t of ['deposit_addresses', 'transactions', 'ledger_entries']) {
      await q.query(`UPDATE ${t} SET asset='USDT_BSC' WHERE asset='USDT_BEP20'`);
    }
  }
}
