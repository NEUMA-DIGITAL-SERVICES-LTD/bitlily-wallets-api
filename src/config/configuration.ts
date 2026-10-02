import { registerAs } from '@nestjs/config';

export const serviceConfig = registerAs('service', () => ({
  webhookRateLimitPerMinute: parseInt(process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE ?? '120', 10),
  port: parseInt(process.env.PORT ?? '3100', 10),
  env: process.env.NODE_ENV ?? 'development',
  apiKeys: (process.env.SERVICE_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean),
  adminApiKeys: (process.env.ADMIN_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean),
}));

export const tatumConfig = registerAs('tatum', () => ({
  apiKey: process.env.TATUM_API_KEY ?? '',
  baseUrl: process.env.TATUM_BASE_URL ?? 'https://api.tatum.io',
  network: (process.env.TATUM_NETWORK ?? 'testnet') as 'testnet' | 'mainnet',
  useKms: process.env.TATUM_USE_KMS === 'true',
  kmsUrl: process.env.KMS_URL ?? '',
  kmsApiKey: process.env.KMS_API_KEY ?? '',
}));

export const webhookConfig = registerAs('webhook', () => ({
  mainAppUrl: process.env.MAIN_APP_WEBHOOK_URL ?? '',
  signingSecret: process.env.WEBHOOK_SIGNING_SECRET ?? '',
}));

export const detectionConfig = registerAs('detection', () => ({
  strategy: (process.env.DEPOSIT_DETECTION ?? 'polling') as 'polling' | 'webhook',
  pollIntervalMs: parseInt(process.env.DEPOSIT_POLL_INTERVAL_MS ?? '120000', 10),
  addressTtlMinutes: parseInt(process.env.DEPOSIT_ADDRESS_TTL_MINUTES ?? '60', 10),
}));

export const limitsConfig = registerAs('limits', () => {
  // JSON blobs, e.g. WITHDRAWAL_LIMITS='{"BTC":"0.1","ETH":"1","USDT_ETH":"5000"}'
  const parse = (raw?: string) => {
    try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
  };
  return {
    /** Hard cap per transaction, per asset. Over → rejected outright. */
    maxPerTx: parse(process.env.WITHDRAWAL_LIMITS) as Record<string, string>,
    /** Soft cap: at/above this the debit posts but broadcast awaits admin approval. */
    approvalAbove: parse(process.env.WITHDRAWAL_APPROVAL_ABOVE) as Record<string, string>,
  };
});

export const reconcileConfig = registerAs('reconcile', () => ({
  enabled: process.env.RECONCILE_ENABLED !== 'false',
}));

export const sweepConfig = registerAs('sweep', () => ({
  gasTopUp: parseFloat(process.env.SWEEP_GAS_TOP_UP ?? '0.005'),
}));

export const confirmationsConfig = registerAs('confirmations', () => ({
  BTC: parseInt(process.env.CONFIRMATIONS_BTC ?? '2', 10),
  LTC: parseInt(process.env.CONFIRMATIONS_LTC ?? '4', 10),
  ETH: parseInt(process.env.CONFIRMATIONS_ETH ?? '12', 10),
  POLYGON: parseInt(process.env.CONFIRMATIONS_POLYGON ?? '64', 10),
  SOL: parseInt(process.env.CONFIRMATIONS_SOL ?? '32', 10),
  TRON: parseInt(process.env.CONFIRMATIONS_TRON ?? '20', 10),
}));
