/**
 * Asset registry — the explicit asset×chain matrix for this deployment.
 *
 * THIS IS THE SCOPE BOUNDARY agreed with the client. Every entry is a
 * distinct integration path (currency code, testnet, fee/sweep model).
 * Only assets listed here are exposed by the service. To support a new
 * asset, add it here and verify provider support for that exact pair.
 */
export type Chain = 'BTC' | 'LTC' | 'ETH' | 'POLYGON' | 'SOL' | 'TRON';
export type AssetType = 'native' | 'token';

export interface AssetDef {
  /** Canonical code used across our API (e.g. 'USDT_TRON'). */
  code: string;
  chain: Chain;
  type: AssetType;
  decimals: number;
  /** Token contract address (token assets only). */
  contract?: string;
}

export const ASSET_REGISTRY: AssetDef[] = [
  { code: 'BTC', chain: 'BTC', type: 'native', decimals: 8 },
  { code: 'LTC', chain: 'LTC', type: 'native', decimals: 8 },
  { code: 'ETH', chain: 'ETH', type: 'native', decimals: 18 },
  { code: 'SOL', chain: 'SOL', type: 'native', decimals: 9 },
  { code: 'TRX', chain: 'TRON', type: 'native', decimals: 6 },
  { code: 'POL', chain: 'POLYGON', type: 'native', decimals: 18 },

  // Stablecoins — confirm per-chain contract addresses against the signed-off
  // asset matrix before mainnet; testnet deployments use provider test assets.
  { code: 'USDT_TRON', chain: 'TRON', type: 'token', decimals: 6, contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' },
  { code: 'USDT_ETH', chain: 'ETH', type: 'token', decimals: 6, contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
  { code: 'USDT_MATIC', chain: 'POLYGON', type: 'token', decimals: 6, contract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' },
  { code: 'USDC_ETH', chain: 'ETH', type: 'token', decimals: 6, contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  { code: 'USDC_MATIC', chain: 'POLYGON', type: 'token', decimals: 6, contract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
  { code: 'USDC_SOL', chain: 'SOL', type: 'token', decimals: 6, contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
];

export function getAsset(code: string): AssetDef | undefined {
  return ASSET_REGISTRY.find((a) => a.code === code.toUpperCase());
}

export function enabledAssets(): AssetDef[] {
  const only = (process.env.ENABLED_ASSETS ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return only.length ? ASSET_REGISTRY.filter((a) => only.includes(a.code)) : ASSET_REGISTRY;
}
