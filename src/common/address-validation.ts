import { Chain } from '../config/assets';

/**
 * Pre-broadcast address sanity checks — charset + length + prefix, not
 * full checksum validation (that's the chain's job). Catches the
 * fat-finger/wrong-chain cases that otherwise burn funds: pasting an ETH
 * address into a BTC send, truncated pastes, empty strings.
 */
const PATTERNS: Record<Chain, RegExp> = {
  // base58 (1…/3…/m…/n…/2…) or bech32 (bc1…/tb1…/ltc1…/tltc1…)
  BTC: /^(bc1[02-9ac-hj-np-z]{11,87}|tb1[02-9ac-hj-np-z]{11,87}|[123mn][1-9A-HJ-NP-Za-km-z]{24,34})$/,
  LTC: /^(ltc1[02-9ac-hj-np-z]{11,87}|tltc1[02-9ac-hj-np-z]{11,87}|[LM3mnQ2][1-9A-HJ-NP-Za-km-z]{24,34})$/,
  ETH: /^0x[0-9a-fA-F]{40}$/,
  POLYGON: /^0x[0-9a-fA-F]{40}$/,
  // base58 32-44 chars; no checksum enforcement here.
  SOL: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  // T + 33 base58 chars
  TRON: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  // BSC is EVM — same 0x-prefixed 20-byte hex as ETH/POLYGON.
  BSC: /^0x[0-9a-fA-F]{40}$/,
  // base58check: mainnet D… (p2pkh) / 9… or A… (p2sh), testnet n…/2…/m….
  DOGE: /^[D9A2nm][1-9A-HJ-NP-Za-km-z]{25,33}$/,
};

export function isPlausibleAddress(chain: Chain, address: string): boolean {
  return PATTERNS[chain]?.test(address) ?? false;
}
