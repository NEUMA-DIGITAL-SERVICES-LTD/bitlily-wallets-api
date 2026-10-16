import { NotifierService } from './notifier.service';

/**
 * The outbound payload contract: USD fields ride every tx event — a real
 * quote when pricing succeeds, explicit nulls when it doesn't. nulls are
 * deliberate: "no price" must be distinguishable from "old client on an
 * old payload" for consumers.
 */
describe('NotifierService.notify payload', () => {
  let service: NotifierService;
  let outbox: any;
  let prices: any;

  const tx = {
    id: 'tx-1',
    direction: 'inbound',
    asset: 'TRX',
    chain: 'TRON',
    txid: 'abc',
    address: 'Tdep',
    amount: '2000',
    status: 'confirmed',
    confirmations: 25,
    reference: null,
    wallet: { id: 'w1', appId: 'acme' },
  } as any;

  beforeEach(() => {
    outbox = {
      save: jest.fn(async (r: any) => ({ ...r, id: 'ev-1' })),
      create: jest.fn((o: any) => o),
      update: jest.fn(),
    };
    prices = { quote: jest.fn() };
    service = new NotifierService(
      { get: jest.fn() } as any,
      outbox,
      {} as any,
      { routeFor: jest.fn().mockResolvedValue({ url: '', secret: '' }) } as any,
      prices,
    );
  });

  it('stamps usdPrice/usdValue/priceSource/pricedAt when a quote exists', async () => {
    prices.quote.mockResolvedValue({
      usdPrice: '0.35', usdValue: '700.000000',
      priceSource: 'coingecko', pricedAt: '2026-10-15T00:00:00Z',
    });
    await service.notify('deposit.confirmed', tx);
    const payload = outbox.create.mock.calls[0][0].payload;
    expect(payload.data).toMatchObject({
      amount: '2000',
      usdPrice: '0.35',
      usdValue: '700.000000',
      priceSource: 'coingecko',
      pricedAt: '2026-10-15T00:00:00Z',
    });
  });

  it('emits explicit nulls when pricing is unavailable — delivery continues', async () => {
    prices.quote.mockResolvedValue(null);
    await service.notify('deposit.confirmed', tx);
    const payload = outbox.create.mock.calls[0][0].payload;
    expect(payload.data.usdValue).toBeNull();
    expect(payload.data.usdPrice).toBeNull();
    expect(payload.data.priceSource).toBeNull();
    expect(payload.data.pricedAt).toBeNull();
  });
});
