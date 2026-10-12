import { WalletsService } from './wallets.service';

/**
 * The client-facing address contract: shared-custody chains (SOL) must
 * surface their deposit memo with a memoRequired flag — a client that
 * can't see the memo can't attribute its users' deposits. Memo-less
 * shared accounts get backfilled lazily so a stale row never silently
 * funnels deposits into the ops queue.
 */
describe('WalletsService.permanentAddresses', () => {
  const solAccount = {
    id: 'acct-sol',
    chain: 'SOL',
    baseAddress: 'SoLbase111',
    memo: 'bl-abc12345',
  };
  const ethAccount = { id: 'acct-eth', chain: 'ETH', xpub: 'xpub...', memo: null };

  const solRows = [
    { address: 'SoLbase111', chain: 'SOL', asset: 'SOL', account: solAccount, expiresAt: null, status: 'active', createdAt: new Date() },
    { address: 'SoLbase111', chain: 'SOL', asset: 'USDC_SOL', account: solAccount, expiresAt: null, status: 'active', createdAt: new Date() },
  ];
  const ethRow = {
    address: '0xeth111', chain: 'ETH', asset: 'ETH', account: ethAccount,
    expiresAt: null, status: 'active', createdAt: new Date(),
  };

  let service: WalletsService;
  let addresses: any;
  let dataSource: any;
  let m: any;

  beforeEach(() => {
    m = {
      findOne: jest.fn().mockResolvedValue(null), // no memo collisions
      save: jest.fn(async (o: any) => o),
    };
    addresses = { find: jest.fn().mockResolvedValue([...solRows, ethRow]) };
    dataSource = { manager: m };
    service = new WalletsService(
      {} as any, {} as any, {} as any, addresses, {} as any,
      {} as any, {} as any, {} as any, dataSource, {} as any,
    );
  });

  it('exposes memo + memoRequired on the shared-custody entry only', async () => {
    const res = await service.permanentAddresses('w1');

    const sol = res.find((a: any) => a.chain === 'SOL');
    expect(sol).toMatchObject({
      address: 'SoLbase111',
      memo: 'bl-abc12345',
      memoRequired: true,
      expiresAt: null,
    });
    expect(sol?.assets).toEqual(['SOL', 'USDC_SOL']);

    const eth = res.find((a: any) => a.chain === 'ETH');
    expect(eth?.memo).toBeUndefined();
    expect(eth?.memoRequired).toBeUndefined();
  });

  it('backfills a memo on a shared-custody account missing one', async () => {
    const stale = { ...solAccount, memo: null };
    addresses.find.mockResolvedValue([
      { ...solRows[0], account: stale },
    ]);

    const res = await service.permanentAddresses('w1');

    expect(m.save).toHaveBeenCalled();
    expect(stale.memo).toMatch(/^bl-[a-z2-9]{8}$/);
    expect(res[0].memo).toBe(stale.memo);
    expect(res[0].memoRequired).toBe(true);
  });
});
