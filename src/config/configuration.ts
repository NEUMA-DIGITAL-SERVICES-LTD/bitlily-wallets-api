import { registerAs } from '@nestjs/config';
import { normalizeAllowlistEntry } from '../common/ip-match';

export interface ApiClientConfig {
  /** Tenant slug stamped on wallets.app_id — 'default' is the legacy
   *  SERVICE_API_KEYS bucket. */
  slug: string;
  name?: string;
  apiKey: string;
  /** This app's outbound webhook endpoint + HMAC secret. */
  webhookUrl?: string;
  webhookSecret?: string;
  /** CIDRs this key may be used from (host → /32 or /128). Absent = unrestricted. */
  allowedIps?: string[];
  /**
   * false = the client's backend owns balance checks (e.g. fiat-funded
   * crypto withdrawals where no on-chain deposit precedes the send).
   * The ledger still posts the debit — wallet balances may go negative
   * and represent what the app's ledger owes custody. Default true.
   */
  enforceBalance?: boolean;
}

export const serviceConfig = registerAs('service', () => {
  let clients: ApiClientConfig[] = [];
  try {
    clients = process.env.API_CLIENTS ? JSON.parse(process.env.API_CLIENTS) : [];
  } catch { clients = []; }
  return {
    webhookRateLimitPerMinute: parseInt(process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE ?? '120', 10),
    port: parseInt(process.env.PORT ?? '3100', 10),
    env: process.env.NODE_ENV ?? 'development',
    /** /docs (Swagger UI + OpenAPI JSON). Unset → off in production, on in
     *  dev; explicit SWAGGER_ENABLED=true|false overrides either way — the
     *  schema leaks every route shape to unauthenticated scanners. */
    swaggerEnabled:
      process.env.SWAGGER_ENABLED !== undefined
        ? process.env.SWAGGER_ENABLED === 'true'
        : (process.env.NODE_ENV ?? 'development') !== 'production',
    apiKeys: (process.env.SERVICE_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean),
    adminApiKeys: (process.env.ADMIN_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean),
    /** Hex SHA-256 digests of admin keys — preferred over storing raw
     *  keys. Callers still send the raw key; it is hashed before
     *  comparison. A leaked .env then yields unusable digests. */
    adminApiKeyHashes: (process.env.ADMIN_API_KEY_HASHES ?? '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean),
    /** Optional CIDR list for X-Admin-Key callers — the key that mints
     *  spend-capable credentials should only work from ops egress.
     *  Bare IPs are accepted and normalized to host routes (/32 or /128);
     *  unparseable entries abort boot rather than silently never matching. */
    adminAllowedIps: (() => {
      const list = (process.env.ADMIN_ALLOWED_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const bad = list.filter((e) => normalizeAllowlistEntry(e) === null);
      if (bad.length) {
        throw new Error(
          `ADMIN_ALLOWED_IPS entries must be IPs or CIDRs. Bad: ${bad.join(', ')}`,
        );
      }
      return list.map((e) => normalizeAllowlistEntry(e)!);
    })(),
    /** Multi-tenant API clients. Each gets a key AND its own webhook
     *  endpoint — app A's deposit events must never reach app B's server.
     *  allowedIps follow the same CIDR-only rule as ADMIN_ALLOWED_IPS —
     *  a malformed entry aborts boot rather than silently never matching. */
    clients: clients.filter((c) => c?.slug && c?.apiKey).map((c) => {
      const bad = (c.allowedIps ?? []).filter(
        (e) => normalizeAllowlistEntry(e) === null,
      );
      if (bad.length) {
        throw new Error(
          `API_CLIENTS[${c.slug}].allowedIps entries must be IPs or CIDRs. Bad: ${bad.join(', ')}`,
        );
      }
      return {
        ...c,
        allowedIps: c.allowedIps?.map((e) => normalizeAllowlistEntry(e)!),
      };
    }),
  };
});

export const tatumConfig = registerAs('tatum', () => ({
  apiKey: process.env.TATUM_API_KEY ?? '',
  baseUrl: process.env.TATUM_BASE_URL ?? 'https://api.tatum.io',
  network: (process.env.TATUM_NETWORK ?? 'testnet') as 'testnet' | 'mainnet',
  useKms: process.env.TATUM_USE_KMS === 'true',
  kmsUrl: process.env.KMS_URL ?? '',
  kmsApiKey: process.env.KMS_API_KEY ?? '',
  /**
   * Solana JSON-RPC used for per-address signature history — Tatum has NO
   * SOL address-history endpoint (v4 unified history is EVM-only; verified
   * live). Point at a dedicated RPC (Helius/QuickNode/self-hosted) in
   * production; the public cluster endpoints are devnet-grade rate limits.
   */
  solanaRpcUrl:
    process.env.SOLANA_RPC_URL ??
    ((process.env.TATUM_NETWORK ?? 'testnet') === 'mainnet'
      ? 'https://api.mainnet-beta.solana.com'
      : 'https://api.devnet.solana.com'),
  // When set, /api/v1/webhooks/tatum REQUIRES a valid x-payload-hash
  // (HMAC-SHA512, Base64). Tatum only sends it after the API key is
  // enrolled via PUT /v3/subscription/enableWebHookHmac — the service
  // self-enrolls at boot when this is configured.
  webhookHmacSecret: process.env.TATUM_WEBHOOK_HMAC_SECRET ?? '',
}));

export const webhookConfig = registerAs('webhook', () => ({
  mainAppUrl: process.env.MAIN_APP_WEBHOOK_URL ?? '',
  signingSecret: process.env.WEBHOOK_SIGNING_SECRET ?? '',
}));

export const historyConfig = registerAs('history', () => {
  const testnet = (process.env.TATUM_NETWORK ?? 'testnet') !== 'mainnet';
  return {
    /**
     * TronGrid — native + TRC20 address history for TRON deposits (Tatum
     * has no per-address tx enumeration for TRON). Shasta on testnet.
     */
    tronGridUrl:
      process.env.TRONGRID_URL ??
      (testnet ? 'https://api.shasta.trongrid.io' : 'https://api.trongrid.io'),
    /**
     * Etherscan-compat explorers (/api?module=account&action=txlist|tokentx)
     * for account-model address history. Blockscout serves the same shape.
     * An empty url or a rejected key → history unavailable → the poller
     * leaves deltas pending+unattributed rather than crediting a
     * synthetic txid. Amoy has NO usable keyless indexer — plug a
     * polygonscan (or Alchemy-proxy) key for staging; production needs
     * paid explorer APIs or full webhook subscriptions anyway.
     */
    evm: {
      ETH: {
        url: process.env.HISTORY_ETH_URL ??
          (testnet
            ? 'https://eth-sepolia.blockscout.com/api'
            : 'https://eth.blockscout.com/api'),
        apiKey: process.env.HISTORY_ETH_API_KEY ?? '',
      },
      POLYGON: {
        url: process.env.HISTORY_POLYGON_URL ??
          (testnet
            ? 'https://api-amoy.polygonscan.com/api'
            : 'https://api.polygonscan.com/api'),
        apiKey: process.env.HISTORY_POLYGON_API_KEY ?? '',
      },
      // BscScan requires an API key for every request — no keyless
      // tier. Without HISTORY_BNB_API_KEY, BNB address history is
      // unavailable and deltas stay pending+unattributed (fail-safe).
      BNB: {
        url: process.env.HISTORY_BNB_URL ??
          (testnet
            ? 'https://api-testnet.bscscan.com/api'
            : 'https://api.bscscan.com/api'),
        apiKey: process.env.HISTORY_BNB_API_KEY ?? '',
      },
    } as Record<string, { url: string; apiKey: string }>,
  };
});

export const detectionConfig = registerAs('detection', () => ({
  strategy: (process.env.DEPOSIT_DETECTION ?? 'polling') as 'polling' | 'webhook',
  pollIntervalMs: parseInt(process.env.DEPOSIT_POLL_INTERVAL_MS ?? '120000', 10),
  /**
   * Chains that get Tatum ADDRESS_EVENT subscriptions even under the
   * polling strategy — for chains with no usable address-history
   * indexer (BNB: BscScan is paywalled). The webhook supplies the txid
   * the poller can't discover; verification still goes through the
   * same re-fetch + output-check path, so spoofed events can't credit.
   * One subscription per address, shared by all its same-chain watches.
   * Env: DEPOSIT_SUBSCRIBE_CHAINS=BNB
   */
  subscribeChains: (process.env.DEPOSIT_SUBSCRIBE_CHAINS ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  /**
   * SOL deposit model. Solana is ed25519 — hardened-only derivation, no
   * xpub — so per-user unique addresses must come from a pool pre-derived
   * on the KMS host (scripts/sol-pool-seed.js → POST /admin/address-pool).
   * true  = each wallet gets its own permanent SOL address (no memo needed)
   * false = shared custody address + per-wallet memo attribution
   * Pool exhaustion fails provisioning 503 and alerts ops — never falls
   * back to shared+memo (that would break the per-user-address contract);
   * deposits keep working under the other attribution model.
   */
  // SOL deposits are ALWAYS pooled unique addresses — the shared-custody
  // (baseAddress+memo) model is retired; there is no flag-off fallback.
  /** Ops warning threshold for free pooled SOL addresses. */
  solPoolLowWatermark: parseInt(process.env.SOL_POOL_LOW_WATERMARK ?? '20', 10),
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

export const pricingConfig = registerAs('pricing', () => ({
  /** USD quotes on outbound webhook payloads. Off → fields emit as null. */
  enabled: process.env.PRICING_ENABLED !== 'false',
  apiUrl: process.env.COINGECKO_API_URL ?? 'https://api.coingecko.com/api/v3',
  /** Optional demo/pro key — sent as x-cg-demo-api-key; empty = free tier. */
  apiKey: process.env.COINGECKO_API_KEY ?? '',
}));

export const reconcileConfig = registerAs('reconcile', () => ({
  enabled: process.env.RECONCILE_ENABLED !== 'false',
}));

export const treasuryConfig = registerAs('treasury', () => {
  let gasFloor: Record<string, number> = {};
  try { gasFloor = process.env.TREASURY_GAS_FLOOR ? JSON.parse(process.env.TREASURY_GAS_FLOOR) : {}; }
  catch { gasFloor = {}; }
  return {
    /** On-chain native balance below this at a treasury → treasury.gas_low
     *  alert. Gas spend isn't a ledger event, so the on-chain number is the
     *  only truth. JSON env: TREASURY_GAS_FLOOR='{"ETH":0.05}' overrides. */
    gasFloor: {
      BTC: 0.0002, LTC: 0.005, ETH: 0.01,
      POLYGON: 0.5, SOL: 0.05, TRON: 100,
      BNB: 0.005, DOGE: 50,
      ...gasFloor,
    } as Record<string, number>,
  };
});

export const sweepConfig = registerAs('sweep', () => {
  let minBalance: Record<string, string> = {};
  try { minBalance = process.env.SWEEP_MIN_BALANCE ? JSON.parse(process.env.SWEEP_MIN_BALANCE) : {}; }
  catch { minBalance = {}; }
  return {
    gasTopUp: parseFloat(process.env.SWEEP_GAS_TOP_UP ?? '0.005'),
    /** Automatic consolidation cron. Gated on KMS at runtime too — without
     *  it the scheduler would just burn provider calls failing. */
    autoEnabled: process.env.SWEEP_AUTO_ENABLED !== 'false',
    /** Per-asset floor below which a sweep isn't worth its fee. JSON env:
     *  SWEEP_MIN_BALANCE='{"BTC":"0.0005","TRX":"10"}' — absent = sweep any
     *  confirmed balance. */
    minBalance,
    /** Max sweeps per 15-min cycle — bounds KMS/provider load and keeps a
     *  hot loop from stampeding the treasury nonce on EVM. */
    maxPerCycle: parseInt(process.env.SWEEP_MAX_PER_CYCLE ?? '20', 10),
  };
});

export const confirmationsConfig = registerAs('confirmations', () => ({
  BTC: parseInt(process.env.CONFIRMATIONS_BTC ?? '2', 10),
  LTC: parseInt(process.env.CONFIRMATIONS_LTC ?? '4', 10),
  ETH: parseInt(process.env.CONFIRMATIONS_ETH ?? '12', 10),
  POLYGON: parseInt(process.env.CONFIRMATIONS_POLYGON ?? '64', 10),
  SOL: parseInt(process.env.CONFIRMATIONS_SOL ?? '32', 10),
  TRON: parseInt(process.env.CONFIRMATIONS_TRON ?? '20', 10),
  // BNB Chain ~3s blocks; 15 confs ≈ 45s and matches common exchange practice.
  BNB: parseInt(process.env.CONFIRMATIONS_BNB ?? '15', 10),
  // DOGE ~1min blocks; 6 confs ≈ 6min. Raise for production if the
  // client's risk appetite is lower (DOGE has had shallow reorgs).
  DOGE: parseInt(process.env.CONFIRMATIONS_DOGE ?? '6', 10),
}));
