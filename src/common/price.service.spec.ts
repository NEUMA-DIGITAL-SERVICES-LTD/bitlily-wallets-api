import axios from 'axios';
import { PriceService } from './price.service';

/**
 * USD enrichment on webhook payloads: stablecoins peg locally (no call,
 * 'peg' source keeps the assumption auditable), volatile assets hit
 * CoinGecko with a 60s cache, and any failure degrades to a null quote —
 * pricing must never drop or delay a money-movement event.
 */
describe('PriceService', () => {
  let service: PriceService;
  let get: jest.SpyInstance;

  beforeEach(() => {
    service = new PriceService({
      get: jest.fn((key: string) => {
        if (key === 'pricing.enabled') return true;
        if (key === 'pricing.apiUrl') return 'https://api.coingecko.com/api/v3';
        return '';
      }),
    } as any);
    get = jest.spyOn(axios, 'get');
  });

  afterEach(() => get.mockRestore());

  it('pegs stablecoins at 1.00 without a network call', async () => {
    const q = await service.quote('USDT_TRON', '1000');
    expect(q).toMatchObject({
      usdPrice: '1',
      usdValue: '1000.000000',
      priceSource: 'peg',
    });
    expect(q?.pricedAt).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
  });

  it('prices volatile assets via CoinGecko and multiplies the amount', async () => {
    get.mockResolvedValue({ data: { tron: { usd: 0.35 } } });
    const q = await service.quote('TRX', '2000');
    expect(q).toMatchObject({
      usdPrice: '0.35',
      usdValue: '700.000000',
      priceSource: 'coingecko',
    });
  });

  it('caches for 60s — bursts of deposits cost one API call', async () => {
    get.mockResolvedValue({ data: { bitcoin: { usd: 100000 } } });
    await service.quote('BTC', '1');
    await service.quote('BTC', '2');
    expect(get).toHaveBeenCalledTimes(1);
    const second = await service.quote('BTC', '2');
    expect(second?.usdValue).toBe('200000.000000');
  });

  it('degrades to null on API failure — pricing never blocks the event', async () => {
    get.mockRejectedValue(new Error('rate limited'));
    await expect(service.quote('ETH', '0.5')).resolves.toBeNull();
  });

  it('returns null for unmapped assets and when disabled', async () => {
    expect(await service.quote('DOGE', '10')).toBeNull();

    const off = new PriceService({
      get: jest.fn((k: string) => (k === 'pricing.enabled' ? false : '')),
    } as any);
    expect(await off.quote('BTC', '1')).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});
