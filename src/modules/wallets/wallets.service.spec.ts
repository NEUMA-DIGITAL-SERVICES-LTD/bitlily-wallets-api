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
      exists: jest.fn().mockResolvedValue(false), // no pooled row yet
      save: jest.fn(async (o: any) => o),
    };
    addresses = { find: jest.fn().mockResolvedValue([...solRows, ethRow]) };
    // Migration now ALWAYS runs — shared+memo stays visible only when it
    // cannot complete (empty pool → allocatePoolAddress returns null).
    const em = {
      findOne: jest.fn().mockResolvedValue(null), // no free pool row
      findOneOrFail: jest.fn().mockResolvedValue(solAccount),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((_e: any, v: any) => ({ status: 'active', ...v })),
      save: jest.fn(async (o: any) => o),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      }),
    };
    dataSource = { manager: m, transaction: jest.fn(async (cb: any) => cb(em)) };
    const accounts = { find: jest.fn().mockResolvedValue([solAccount]) };
    service = new WalletsService(
      {} as any, accounts as any, {} as any, addresses, {} as any,
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
 * SOL deposits are ALWAYS pooled unique addresses — each pool row IS a
 * keypair (its own signatureId — SOL has no index derivation); the dep row
 * carries derivationIndex=null and sweeps resolve the signatureId by
 * address. Exhaustion fails loudly (503) — a shared+memo row would break
 * the per-user-address contract every other chain offers.
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
    id: 'pool-1', chain: 'SOL', signatureId: 'sig-pool-1',
    derivationIndex: null, address: 'SoLpooled7',
    account: null, assignedAt: null,
  };

  let service: WalletsService;
  let em: any;
  let saved: any[];
  let config: any;
  const log = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };

  const makeService = (poolRows: any[]) => {
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
    config = { get: jest.fn().mockReturnValue(undefined) };
    const dataSource: any = { transaction: jest.fn(async (cb: any) => cb(em)), manager: em };
    const svc = new WalletsService(
      {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, config, dataSource, {} as any,
    );
    (svc as any).logger = log;
    return svc;
  };

  it('assigns a pooled address with its derivation index — permanent, no memo', async () => {
    service = makeService([poolRow]);
    const res = await service.generateDepositAddress('w1', 'default', 'SOL');

    expect(res.address).toBe('SoLpooled7');
    // Private-key pool rows sign by signatureId — dep rows carry no index
    expect(res.derivationIndex).toBeNull();
    expect(res.expiresAt).toBeNull();
    // Pool row claimed to this account
    expect(em.createQueryBuilder).toHaveBeenCalled();
    // Same-chain watch row for USDC_SOL was created on the pooled address
    const watch = saved.find((s) => s.asset === 'USDC_SOL');
    expect(watch?.address).toBe('SoLpooled7');
  });

  it('reuses the wallet\'s already-assigned pool row', async () => {
    const assigned = { ...poolRow, account: solAccount, assignedAt: new Date() };
    service = makeService([assigned]);
    const res = await service.generateDepositAddress('w1', 'default', 'SOL');

    expect(res.address).toBe('SoLpooled7');
    // No claim update — the wallet already owns it
    expect(em.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('empty pool fails loudly — never silently hands out a shared memo address', async () => {
    service = makeService([]);
    em.findOne.mockImplementation(async (entity: any) => {
      if (entity === WalletAccount) return solAccount;
      return null;
    });

    await expect(
      service.generateDepositAddress('w1', 'default', 'SOL'),
    ).rejects.toThrow(/SOL deposit addresses temporarily exhausted/);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('pool exhausted'));
  });
});

/**
 * Shared→pooled migration on the read path: a legacy shared-custody SOL
 * account gets a pooled address and per-asset watch rows lazily on first
 * permanentAddresses read. Shared rows stay ACTIVE (catch-all for sends
 * to the old address) but are hidden from the client-facing response —
 * the pooled per-user address is what clients must see.
 */
describe('WalletsService.permanentAddresses — shared→pooled migration', () => {
  const solAccount = {
    id: 'acct-sol', chain: 'SOL', baseAddress: 'SoLbase111', memo: 'bl-abc12345',
  };
  const sharedRows = [
    { address: 'SoLbase111', chain: 'SOL', asset: 'SOL', account: solAccount, expiresAt: null, status: 'active', createdAt: new Date(1) },
    { address: 'SoLbase111', chain: 'SOL', asset: 'USDC_SOL', account: solAccount, expiresAt: null, status: 'active', createdAt: new Date(2) },
  ];
  const pooledRows = [
    { address: 'SoLpooled9', chain: 'SOL', asset: 'SOL', account: solAccount, expiresAt: null, status: 'active', createdAt: new Date(3) },
    { address: 'SoLpooled9', chain: 'SOL', asset: 'USDC_SOL', account: solAccount, expiresAt: null, status: 'active', createdAt: new Date(4) },
  ];
  const poolRow = { id: 'pool-9', chain: 'SOL', address: 'SoLpooled9', account: null, assignedAt: null };

  const makeService = (pool: any[], pooledExist = false) => {
    const saved: any[] = [];
    const qb = {
      update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const em: any = {
      find: jest.fn(async (e: any, o: any) =>
        e === DepositAddress && o?.where?.address === 'SoLbase111' ? [...sharedRows] : []),
      findOneOrFail: jest.fn(async (e: any, o: any) => {
        if (e === WalletAccount) return solAccount;
        throw new Error('not found');
      }),
      // Steady-state fast path: an active pooled row skips the lock+tx.
      exists: jest.fn(async () => pooledExist),
      findOne: jest.fn(async (e: any, o: any) => {
        if (e === AddressPool) {
          if (o?.where?.account?.id) return pool.find((r) => r.account?.id === solAccount.id) ?? null;
          return pool.find((r) => !r.account) ?? null;
        }
        if (e === DepositAddress && o?.where?.address === 'SoLpooled9') {
          // Rows mirrored earlier in THIS transaction are visible to
          // subsequent findOne calls in it — same as the real tx.
          return (
            saved.find(
              (r) => r.address === 'SoLpooled9' && r.asset === o.where.asset,
            ) ??
            (pooledExist
              ? pooledRows.find((r) => r.asset === o.where.asset) ?? null
              : null)
          );
        }
        return null;
      }),
      // TypeORM's create() applies entity column defaults — emulate the
      // status:'active' default so ensureSameChainWatches sees mirrored
      // rows as already-active instead of "reviving" them.
      create: jest.fn((_e: any, v: any) => ({ status: 'active', ...v })),
      save: jest.fn(async (o: any) => { saved.push(o); return o; }),
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };
    const dataSource: any = { transaction: jest.fn(async (cb: any) => cb(em)), manager: em };
    const config = { get: jest.fn().mockReturnValue(undefined) };
    const addresses = { find: jest.fn() };
    // Migration keys off the ACCOUNT's baseAddress marker — the mock
    // surfaces this wallet's shared-custody SOL account.
    const accounts = { find: jest.fn().mockResolvedValue([solAccount]) };
    const svc = new WalletsService(
      {} as any, accounts as any, {} as any, addresses as any, {} as any,
      {} as any, {} as any, config as any, dataSource, {} as any,
    );
    return { svc, addresses, saved };
  };

  it('migrates a shared account to a pooled address and hides the shared row', async () => {
    const { svc, addresses, saved } = makeService([poolRow]);
    addresses.find
      .mockResolvedValueOnce([...sharedRows])
      .mockResolvedValueOnce([...sharedRows, ...pooledRows]);

    const res = await svc.permanentAddresses('w1');

    // Pooled rows created for every shared-address asset
    const created = saved.filter((s) => s.address === 'SoLpooled9');
    expect(created.map((c) => c.asset).sort()).toEqual(['SOL', 'USDC_SOL']);
    // Response shows ONLY the pooled address — no shared, no memo
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ address: 'SoLpooled9', chain: 'SOL' });
    expect(res[0].memo).toBeUndefined();
    expect(res[0].assets).toEqual(['SOL', 'USDC_SOL']);
    expect(addresses.find).toHaveBeenCalledTimes(2); // refetch after migration
  });

  it('pool exhaustion keeps the shared row visible with its memo', async () => {
    const { svc, addresses } = makeService([]);
    addresses.find.mockResolvedValue([...sharedRows]);

    const res = await svc.permanentAddresses('w1');

    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ address: 'SoLbase111', memoRequired: true });
    expect(addresses.find).toHaveBeenCalledTimes(1); // nothing migrated, no refetch
  });

  it('all shared rows retired (custody off) — still migrates, no empty view', async () => {
    // The custody off-migration retired every shared row. Active-only
    // queries return nothing, so migration must key off the ACCOUNT —
    // a row-driven trigger leaves the wallet with no SOL address.
    const { svc, addresses, saved } = makeService([poolRow]);
    addresses.find
      .mockResolvedValueOnce([]) // shared rows all retired — none active
      .mockResolvedValueOnce([...pooledRows]);

    const res = await svc.permanentAddresses('w1');

    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ address: 'SoLpooled9', chain: 'SOL' });
    expect(saved.filter((s) => s.address === 'SoLpooled9')).toHaveLength(2);
  });

  it('already-migrated account: shared row hidden without re-migrating', async () => {
    const { svc, addresses, saved } = makeService(
      [{ ...poolRow, account: solAccount }],
      true,
    );
    addresses.find.mockResolvedValue([...sharedRows, ...pooledRows]);

    const res = await svc.permanentAddresses('w1');

    expect(res).toHaveLength(1);
    expect(res[0].address).toBe('SoLpooled9');
    // Mirror is idempotent — existing active pooled rows aren't re-saved
    expect(saved.filter((s) => s.asset)).toHaveLength(0);
  });
});
