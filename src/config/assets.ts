/**
 * Asset registry — the explicit asset×chain matrix for this deployment.
 *
 * THIS IS THE SCOPE BOUNDARY agreed with the client. Every entry is a
 * distinct integration path (currency code, testnet, fee/sweep model).
 * Only assets listed here are exposed by the service. To support a new
 * asset, add it here and verify provider support for that exact pair.
 */
export type Chain = 'BTC' | 'LTC' | 'ETH' | 'POLYGON' | 'SOL' | 'TRON' | 'BNB' | 'DOGE';
export type AssetType = 'native' | 'token';

export interface AssetDef {
  /** Canonical code used across our API (e.g. 'USDT_TRON'). */
  code: string;
  chain: Chain;
  type: AssetType;
  decimals: number;
  /** Token contract address on mainnet (token assets only). */
  contract?: string;
  /** Testnet deployment of the same token, if one exists. Resolved into
   *  `contract` by getAsset() when TATUM_NETWORK != mainnet. Never silently
   *  fall back to the mainnet address — a token that has no testnet
   *  deployment should fail loudly rather than query a nonexistent
   *  contract and return phantom zero balances. */
  testnetContract?: string;
  /** Registered but excluded from enabledAssets() unless explicitly named
   *  in ENABLED_ASSETS — for assets the current provider cannot serve
   *  honestly. The registry keeps them as the scope record. */
  disabledByDefault?: boolean;
}

export const ASSET_REGISTRY: AssetDef[] = [
  { code: 'BTC', chain: 'BTC', type: 'native', decimals: 8 },
  { code: 'LTC', chain: 'LTC', type: 'native', decimals: 8 },
  { code: 'ETH', chain: 'ETH', type: 'native', decimals: 18 },
  { code: 'SOL', chain: 'SOL', type: 'native', decimals: 9 },
  { code: 'TRX', chain: 'TRON', type: 'native', decimals: 6 },
  { code: 'POL', chain: 'POLYGON', type: 'native', decimals: 18 },
  { code: 'BNB', chain: 'BNB', type: 'native', decimals: 18 },
  { code: 'DOGE', chain: 'DOGE', type: 'native', decimals: 8 },

  // Stablecoins — confirm per-chain contract addresses against the signed-off
  // asset matrix before mainnet; testnet deployments use provider test assets.
  { code: 'USDT_TRON', chain: 'TRON', type: 'token', decimals: 6, contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    // Canonical test USDT on Shasta (Tatum's TRON testnet is Shasta,
    // not Nile — verified by block-hash comparison).
    testnetContract: 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs' },
  { code: 'USDT_ETH', chain: 'ETH', type: 'token', decimals: 6, contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    // Test-deployed mock on Sepolia (no official Tether testnet deployment
    // exists). Supply held by the TESTNET_PK_ETH test wallet.
    testnetContract: '0x57484c2f11202d766f9653e491a4c7930699f727' },
  { code: 'USDT_MATIC', chain: 'POLYGON', type: 'token', decimals: 6, contract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' },
  { code: 'USDC_ETH', chain: 'ETH', type: 'token', decimals: 6, contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    // Official Circle testnet USDC on Sepolia (faucet.circle.com).
    testnetContract: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
  { code: 'USDC_MATIC', chain: 'POLYGON', type: 'token', decimals: 6, contract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    // Circle's official testnet USDC on Amoy (faucet.circle.com).
    testnetContract: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582' },
  // SPL tokens are servable via Tatum's unified token routes
  // (/v3/blockchain/token/{balance,transaction} accept chain=SOL) —
  // verified live on devnet. Mainnet contract is Circle's USDC mint.
  { code: 'USDC_SOL', chain: 'SOL', type: 'token', decimals: 6, contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    // Circle's official devnet USDC mint (faucet.circle.com).
    testnetContract: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' },
  // BEP-20 USDT is 18 decimals — NOT 6 like TRC-20/ERC-20. Getting this
  // wrong credits deposits 10^12x off.
  { code: 'USDT_BEP20', chain: 'BNB', type: 'token', decimals: 18, contract: '0x55d398326f99059fF775485246999027B3197955',
    // Our own capped mintable test USDT on Chapel — deployed via Tatum's
    // token/deploy (tx 0x447cd534…b4), minter = BNB treasury index 0.
    // Faucet USDT pools run dry monthly; this removes the dependency.
    testnetContract: '0xd039c358e1dd0a50c3fbf061f92f43e2b51257c1' },
];

export function getAsset(code: string): AssetDef | undefined {
  const a = ASSET_REGISTRY.find((a) => a.code === code.toUpperCase());
  if (!a) return undefined;
  // Provider-unservable assets answer as unsupported unless the operator
  // explicitly enabled them — a withdrawal must not pass validation only
  // to fail after the ledger debit.
  if (a.disabledByDefault) {
    const only = (process.env.ENABLED_ASSETS ?? '')
      .split(',').map((s) => s.trim().toUpperCase());
    if (!only.includes(a.code)) return undefined;
  }
  if (a.type === 'token' && (process.env.TATUM_NETWORK ?? 'testnet') !== 'mainnet') {
    // A token without a testnet deployment is unservable — returning the
    // def with contract:undefined produced a literal "undefined" contract
    // in provider URLs (error-storm loop) or worse, silent-zero balances
    // (TRC20 key lookup misses). Unsupported is the honest answer.
    if (!a.testnetContract) return undefined;
    return { ...a, contract: a.testnetContract };
  }
  return a;
}

export function enabledAssets(): AssetDef[] {
  const only = (process.env.ENABLED_ASSETS ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (only.length) return ASSET_REGISTRY.filter((a) => only.includes(a.code));
  // Default set excludes assets the provider cannot serve; explicit
  // ENABLED_ASSETS membership overrides.
  return ASSET_REGISTRY.filter((a) => !a.disabledByDefault);
}
