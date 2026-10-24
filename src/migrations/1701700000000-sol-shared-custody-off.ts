import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retires the SOL shared-custody (baseAddress + memo) deposit model —
 * pooled unique addresses (address_pool) are now the only SOL deposit
 * path.
 *
 * Two moves, one migration so no intermediate state is observable:
 *
 *  1. Every deposit_addresses row pointing AT the enrolled shared base
 *     address is retired — preserved for audit (creditedAmount history)
 *     but removed from the active poll set and every client-facing
 *     address view. The address itself stays in custodyAddrs via
 *     treasury_address, so even a revived row can't phantom-credit.
 *
 *  2. custody_accounts.base_address is cleared for SOL — this is the
 *     kill switch the whole shared model keys off: scanSharedDeposits
 *     skips base-less custody rows (no more memo scans or unattributed
 *     SOL queue entries), and chainMaterial stops handing new wallet
 *     accounts a shared address + memo.
 *
 * wallet_accounts.base_address is deliberately KEPT: it marks legacy
 * shared-custody accounts so permanentAddresses can lazily migrate them
 * to pooled rows and suppress the shared row from responses.
 *
 * Sends to the old shared address after this point are NOT detected —
 * the shared scanner is dead by design. Funds aren't lost (they sit in
 * the treasury the custody row still points at); ops recovers them on
 * explorer + manual credit if a straggler ever arrives.
 */
export class SolSharedCustodyOff1701700000000 implements MigrationInterface {
  name = 'SolSharedCustodyOff1701700000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE deposit_addresses SET status = 'retired'
       WHERE address IN (
         SELECT base_address FROM custody_accounts
         WHERE chain = 'SOL' AND base_address IS NOT NULL
       )`,
    );
    await q.query(
      `UPDATE custody_accounts SET base_address = NULL
       WHERE chain = 'SOL' AND base_address IS NOT NULL`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    // The shared address is recoverable from wallet_accounts — every
    // legacy shared-custody account keeps it as its migration marker.
    // Watch rows stay retired; ops re-watches explicitly if ever needed.
    await q.query(
      `UPDATE custody_accounts SET base_address = (
         SELECT base_address FROM wallet_accounts
         WHERE chain = 'SOL' AND base_address IS NOT NULL LIMIT 1
       )
       WHERE chain = 'SOL' AND base_address IS NULL`,
    );
  }
}
