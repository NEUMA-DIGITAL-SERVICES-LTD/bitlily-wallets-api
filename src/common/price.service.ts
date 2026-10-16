import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { errMsg } from './errors';

/** USD quote for an amount of an asset, stamped at a point in time. */
export interface UsdQuote {
  /** USD per whole unit of the asset, e.g. "67823.15". */
  usdPrice: string;
  /** amount × usdPrice, 6 decimals — informational, never ledger math. */
  usdValue: string;
  /** 'tatum' | 'coingecko' | 'peg' — 'peg' = stablecoin assumed 1.00 USD. */
  priceSource: string;
  /** ISO timestamp the price was observed at. */
  pricedAt: string;
}

/**
 * CoinGecko asset ids — the fallback source when Tatum's rate endpoint
 * misses or fails. Tokens that are not pegged stablecoins have no entry
 * in either source → null quote (fields still emit, just null).
 */
const COINGECKO_IDS: Record<string, string> = {
  BTC: 'bitcoin',
  LTC: 'litecoin',
  ETH: 'ethereum',
  SOL: 'solana',
  TRX: 'tron',
  POL: 'polygon-ecosystem-token',
};

const CACHE_MS = 60_000;

/**
 * USD pricing for outbound webhook payloads — best-effort enrichment,
 * never a hard dependency. Sources in order: Tatum rate endpoint (same
 * vendor, same key — verified live: BTC/ETH/LTC/SOL/TRX/POL all answer),
 * then CoinGecko free tier. A total failure degrades to null fields,
 * never a dropped or delayed event. Stablecoins peg at 1.00 without a
 * call — 'peg' in priceSource makes that assumption auditable rather
 * than silently looking like a market quote.
 *
 * Note: prices are always mainnet-market prices — on testnet the figure
 * is illustrative (useful for client UI plumbing, meaningless as value).
 */
@Injectable()
export class PriceService {
  private readonly logger = new Logger(PriceService.name);
  private cache = new Map<string, { usd: number; source: string; at: number }>();

  constructor(private readonly config: ConfigService) {}

  /** Quote one unit's USD price — null when unavailable. Never throws. */
  async quote(assetCode: string, amount: string): Promise<UsdQuote | null> {
    if (this.config.get<boolean>('pricing.enabled') === false) return null;
    const pricedAt = new Date().toISOString();

    if (assetCode.startsWith('USDT') || assetCode.startsWith('USDC')) {
      return this.build(amount, 1, 'peg', pricedAt);
    }
    const hit = this.cache.get(assetCode);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      return this.build(amount, hit.usd, hit.source, pricedAt);
    }
    const q = await this.fetch(assetCode);
    if (q == null) return null;
    this.cache.set(assetCode, { usd: q.usd, source: q.source, at: Date.now() });
    return this.build(amount, q.usd, q.source, pricedAt);
  }

  private async fetch(assetCode: string): Promise<{ usd: number; source: string } | null> {
    const tatum = await this.fetchTatum(assetCode);
    if (tatum != null) return { usd: tatum, source: 'tatum' };
    const cgId = COINGECKO_IDS[assetCode];
    if (!cgId) return null;
    const cg = await this.fetchCoinGecko(cgId, assetCode);
    return cg == null ? null : { usd: cg, source: 'coingecko' };
  }

  private async fetchTatum(assetCode: string): Promise<number | null> {
    const apiKey = this.config.get<string>('tatum.apiKey');
    if (!apiKey) return null;
    try {
      const { data } = await axios.get(
        `${this.config.get<string>('tatum.baseUrl')}/v3/tatum/rate/${assetCode}`,
        {
          params: { basePair: 'USD' },
          headers: { 'x-api-key': apiKey },
          timeout: 8000,
        },
      );
      const usd = parseFloat(String(data?.value ?? ''));
      return Number.isFinite(usd) && usd > 0 ? usd : null;
    } catch {
      // Tokens 404/403 here — CoinGecko fallback covers them if mapped.
      return null;
    }
  }

  private async fetchCoinGecko(cgId: string, assetCode: string): Promise<number | null> {
    try {
      const key = this.config.get<string>('pricing.apiKey');
      const { data } = await axios.get(
        `${this.config.get<string>('pricing.apiUrl')}/simple/price`,
        {
          params: { ids: cgId, vs_currencies: 'usd' },
          headers: key ? { 'x-cg-demo-api-key': key } : {},
          timeout: 8000,
        },
      );
      const usd = data?.[cgId]?.usd;
      return typeof usd === 'number' && usd > 0 ? usd : null;
    } catch (e) {
      this.logger.warn(`Price fetch failed for ${assetCode}: ${errMsg(e)}`);
      return null;
    }
  }

  private build(amount: string, usd: number, source: string, at: string): UsdQuote {
    const value = parseFloat(amount) * usd;
    return {
      usdPrice: String(usd),
      usdValue: Number.isFinite(value) ? value.toFixed(6) : '0',
      priceSource: source,
      pricedAt: at,
    };
  }
}
