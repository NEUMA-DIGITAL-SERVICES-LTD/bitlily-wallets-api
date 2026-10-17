import { WalletsService } from './wallets.service';
import { WalletAccount } from '../../database/entities/wallet-account.entity';
import { DepositAddress } from '../../database/entities/deposit-address.entity';
import { AddressPool } from '../../database/entities/address-pool.entity';

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

  it('a pooled per-user SOL address carries no memo flags — it is uniquely owned', async () => {
    addresses.find.mockResolvedValue([
      { address: 'SoLpooled1', chain: 'SOL', asset: 'SOL', account: solAccount, expiresAt: null, status: 'active', createdAt: new Date() },
    ]);

    const res = await service.permanentAddresses('w1');

    expect(res[0]).toMatchObject({ address: 'SoLpooled1', chain: 'SOL' });
    expect(res[0].memo).toBeUndefined();
    expect(res[0].memoRequired).toBeUndefined();
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

/**
 * SOL_UNIQUE_DEPOSITS=true — pooled unique addresses. The pool row's
 * derivationIndex is what sweep signing uses (signatureId + index); the
 * address itself is what the poller attributes by. Exhaustion must
 * degrade to the shared-address+memo row, not fail wallet provisioning.
 */
describe('WalletsService.generateDepositAddress — SOL unique-deposit pool', () => {
  const solAccount = {
    id: 'acct-sol',
    chain: 'SOL',
    baseAddress: 'SoLbase111',
    memo: 'bl-abc12345',
    wallet: { id: 'w1', appId: 'default' },
  };
  const poolRow = {
    id: 'pool-1', chain: 'SOL', derivationIndex: 7, address: 'SoLpooled7',
    account: null, assignedAt: null,
  };

  let service: WalletsService;
  let em: any;
  let saved: any[];
  let config: any;
  const log = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };

  const makeService = (uniqueOn: boolean, poolRows: any[]) => {
    saved = [];
    const qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    em = {
      find: jest.fn().mockResolvedValue([]),        // persistent reuse: none
      findOne: jest.fn(async (entity: any, opts: any) => {
        if (entity === WalletAccount) return solAccount;
        if (entity === AddressPool) {
          // assigned-check vs free-check: assigned queries carry account.id
          if (opts?.where?.account?.id) {
            return poolRows.find((r) => r.account?.id === solAccount.id) ?? null;
          }
          return poolRows.find((r) => !r.account) ?? null;
        }
        return null; // DepositAddress lookups + watch rows
      }),
      create: jest.fn((_e: any, v: any) => v),
      save: jest.fn(async (o: any) => { saved.push(o); return o; }),
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };
    config = {
      get: jest.fn((k: string) => (k === 'detection.solUniqueDeposits' ? uniqueOn : undefined)),
    };
    const dataSource: any = { transaction: jest.fn(async (cb: any) => cb(em)), manager: em };
    const svc = new WalletsService(
      {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, config, dataSource, {} as any,
    );
    (svc as any).logger = log;
    return svc;
  };

  it('assigns a pooled address with its derivation index — permanent, no memo', async () => {
    service = makeService(true, [poolRow]);
    const res = await service.generateDepositAddress('w1', 'default', 'SOL');

    expect(res.address).toBe('SoLpooled7');
    expect(res.derivationIndex).toBe(7);
    expect(res.expiresAt).toBeNull();
    // Pool row claimed to this account
    expect(em.createQueryBuilder).toHaveBeenCalled();
    // Same-chain watch row for USDC_SOL was created on the pooled address
    const watch = saved.find((s) => s.asset === 'USDC_SOL');
    expect(watch?.address).toBe('SoLpooled7');
  });

  it('reuses the wallet\'s already-assigned pool row', async () => {
    const assigned = { ...poolRow, account: solAccount, assignedAt: new Date() };
    service = makeService(true, [assigned]);
    const res = await service.generateDepositAddress('w1', 'default', 'SOL');

    expect(res.address).toBe('SoLpooled7');
    // No claim update — the wallet already owns it
    expect(em.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('empty pool degrades to the shared baseAddress row instead of failing', async () => {
    // The shared (account, baseAddress, asset) row exists in the reuse path
    const sharedRow = {
      id: 'dep-shared', account: solAccount, address: 'SoLbase111',
      chain: 'SOL', asset: 'SOL', status: 'active', expiresAt: null,
    };
    service = makeService(true, []);
    em.findOne.mockImplementation(async (entity: any, opts: any) => {
      if (entity === WalletAccount) return solAccount;
      // Shared-path reuse queries by (account, asset); watch lookups carry
      // address+asset — matching on asset alone keeps the fallback row.
      if (entity === DepositAddress && opts?.where?.asset === 'SOL') return sharedRow;
      return null;
    });
    const res = await service.generateDepositAddress('w1', 'default', 'SOL');

    expect(res.address).toBe('SoLbase111');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('pool exhausted'));
  });
});
