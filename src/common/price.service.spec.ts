import axios from 'axios';
import { PriceService } from './price.service';

/**
 * USD enrichment on webhook payloads: stablecoins peg locally (no call,
 * 'peg' source keeps the assumption auditable), volatile assets hit
 * Tatum's rate endpoint first (same vendor, same key) with CoinGecko as
 * fallback, and any failure degrades to a null quote — pricing must
 * never drop or delay a money-movement event.
 */
describe('PriceService', () => {
  let service: PriceService;
  let get: jest.SpyInstance;

  const conf = (over: Record<string, string | boolean> = {}) => ({
    get: jest.fn((key: string) =>
      over[key] ?? {
        'pricing.enabled': true,
        'pricing.apiUrl': 'https://api.coingecko.com/api/v3',
        'pricing.apiKey': '',
        'tatum.apiKey': 't-test',
        'tatum.baseUrl': 'https://api.tatum.io',
      }[key] ?? ''),
  });

  beforeEach(() => {
    service = new PriceService(conf() as any);
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

  it('prices natives via Tatum rates first', async () => {
    get.mockResolvedValue({ data: { value: '0.33458000' } });
    const q = await service.quote('TRX', '2000');
    expect(q).toMatchObject({
      usdPrice: '0.33458',
      usdValue: '669.160000',
      priceSource: 'tatum',
    });
    expect(get).toHaveBeenCalledWith(
      'https://api.tatum.io/v3/tatum/rate/TRX',
      expect.objectContaining({ params: { basePair: 'USD' } }),
    );
  });

  it('falls back to CoinGecko when Tatum misses (e.g. unlisted token)', async () => {
    get
      .mockRejectedValueOnce(Object.assign(new Error('403'), { response: { status: 403 } }))
      .mockResolvedValueOnce({ data: { tron: { usd: 0.35 } } });
    const q = await service.quote('TRX', '2000');
    expect(q).toMatchObject({ usdPrice: '0.35', usdValue: '700.000000', priceSource: 'coingecko' });
  });

  it('caches for 60s — bursts of deposits cost one upstream call', async () => {
    get.mockResolvedValue({ data: { value: '100000' } });
    await service.quote('BTC', '1');
    const second = await service.quote('BTC', '2');
    expect(get).toHaveBeenCalledTimes(1);
    expect(second?.usdValue).toBe('200000.000000');
  });

  it('degrades to null when every source fails — pricing never blocks the event', async () => {
    get.mockRejectedValue(new Error('down'));
    await expect(service.quote('ETH', '0.5')).resolves.toBeNull();
  });

  it('returns null for unmapped assets and when disabled', async () => {
    // Unknown asset: Tatum is still tried (it may list it), no CoinGecko
    // id exists — one upstream attempt, then null.
    get.mockRejectedValue(new Error('403'));
    expect(await service.quote('NOTACOIN', '10')).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);

    const off = new PriceService(conf({ 'pricing.enabled': false }) as any);
    expect(await off.quote('BTC', '1')).toBeNull();
  });
});
