/**
 * Minimal ERC-20 Transfer-event extraction from EVM tx logs.
 *
 * Token transfers never appear in `tx.to`/`tx.value` — they live in the
 * receipt logs as `Transfer(address,address,uint256)` events emitted by the
 * token contract. Without this, the deposit verifier sees no output paying
 * our deposit address and rejects legitimate USDT/USDC deposits.
 */

const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface RawEvmLog {
  address?: string;
  topics?: string[];
  data?: string;
}

export interface TokenTransfer {
  /** Recipient address (checksummed-agnostic, lowercase hex). */
  to: string;
  /** Amount in human units (divided by token decimals). */
  amount: string;
  /** Emitting token contract. */
  contract: string;
}

export function parseErc20Transfers(
  logs: RawEvmLog[] | undefined,
  decimals: number,
): TokenTransfer[] {
  if (!Array.isArray(logs)) return [];
  const out: TokenTransfer[] = [];
  for (const log of logs) {
    if (!log?.topics || log.topics.length < 3) continue;
    if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;
    const to = '0x' + log.topics[2].slice(-40).toLowerCase();
    const raw = BigInt(log.data && log.data !== '0x' ? log.data : '0x0');
    const denom = 10n ** BigInt(decimals);
    const whole = raw / denom;
    const frac = (raw % denom).toString().padStart(decimals, '0').replace(/0+$/, '');
    out.push({
      to,
      amount: frac ? `${whole}.${frac}` : whole.toString(),
      contract: (log.address ?? '').toLowerCase(),
    });
  }
  return out;
}
