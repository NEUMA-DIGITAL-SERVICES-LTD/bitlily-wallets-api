import { DepositPollerService } from './deposit-poller.service';
import { DepositAddress } from '../../database/entities/deposit-address.entity';
import { Transaction } from '../../database/entities/transaction.entity';

/**
 * The deposit credit path is the highest-risk code in the service —
 * three bugs here were only caught by live testnet funding. These tests
 * pin the money-path behavior: delta detection, synthetic-txid dedupe,
 * confirmation gating, and pending→confirmed advancement.
 */
describe('DepositPollerService', () => {
  const wallet = { id: 'w1' };
  const dep = {
    id: 'dep1',
    address: 'addr-1',
    chain: 'BTC',
    asset: 'BTC',
    creditedAmount: '0',
    reference: 'order-1',
    status: 'active',
    account: { wallet },
  } as unknown as DepositAddress;

  let service: DepositPollerService;
  let addresses: any;
  let txs: any;
  let custody: any;
  let em: any;
  let m: any; // transactional EntityManager
  let provider: any;
  let ledger: any;
  let notifier: any;
  let config: any;

  const makePoller = () => {
    addresses = {
      find: jest.fn().mockResolvedValue([dep]),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      findOneOrFail: jest.fn(async () => {
        const [d] = await addresses.find();
        return { creditedAmount: d.creditedAmount };
      }),
      // Shared-address ambiguity probe — 0 = this wallet owns the address
      // exclusively, >0 = another wallet watches it too (skip crediting).
      createQueryBuilder: jest.fn(() => ({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      })),
    };
    custody = { find: jest.fn().mockResolvedValue([]) };
    txs = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    };
    m = {
      findOne: jest.fn(),
      save: jest.fn(async (_e: any, o?: any) => o ?? _e),
      create: jest.fn((_e: any, o: any) => o),
      update: jest.fn(),
    };
    em = { transaction: jest.fn(async (cb: any) => cb(m)) };
    provider = {
      getAddressBalance: jest.fn(),
      getAddressTransactions: jest.fn().mockResolvedValue([]),
      getLatestBlock: jest.fn().mockResolvedValue(0),
      getTransaction: jest.fn().mockResolvedValue(null),
    };
    ledger = { postEntry: jest.fn() };
    notifier = { notify: jest.fn(), notifyEvent: jest.fn() };
    config = {
      get: jest.fn((k: string) =>
        k === 'detection.strategy' ? 'polling'
        : k === 'confirmations' ? { BTC: 2, ETH: 12, SOL: 32 }
        : undefined,
      ),
    };
    service = new DepositPollerService(
      addresses, txs, custody, em, provider, ledger, notifier, config,
    );
  };

  beforeEach(makePoller);

  it('records an unattributed UTXO delta as pending — never credits it (0-conf guard)', async () => {
    // UTXO balance reads include the mempool: an unattributed delta may be
    // a 0-conf deposit that a double-spend can still claw back. It must
    // stay pending until a real txid confirms — this was finding #4 in the
    // audit (instant credit → withdraw → RBF = stolen funds).
    provider.getAddressBalance.mockResolvedValue('0.5');
    m.findOne.mockImplementation((e: any) =>
      e === DepositAddress ? { ...dep, creditedAmount: '0' } : null);

    await service.poll();

    expect(ledger.postEntry).not.toHaveBeenCalled();
    const created = m.create.mock.calls.find((c: any[]) => c[0] === Transaction)?.[1];
    expect(created.txid).toMatch(/^poll:/); // synthetic until attributed
    expect(created.status).toBe('pending');
    expect(created.amount).toBe('0.50000000');
    expect(notifier.notify).toHaveBeenCalledWith('deposit.pending', expect.anything());
  });

  it('adopts a pending synthetic row once the real txid shows up, then credits on confirm', async () => {
    const synth = {
      id: 'tx1', wallet, txid: 'poll:addr-1:BTC:0.5', address: 'addr-1',
      asset: 'BTC', amount: '0.50000000', status: 'pending', confirmations: 0,
    } as unknown as Transaction;
    provider.getAddressBalance.mockResolvedValue('0.5');
    provider.getAddressTransactions.mockResolvedValue([{
      txid: 'realtxid',
      chain: 'BTC',
      outputs: [{ address: 'addr-1', amount: '0.5' }],
      confirmations: 0,
      blockNumber: 100,
    }]);
    provider.getLatestBlock.mockResolvedValue(104); // → 5 confs ≥ required 2
    m.findOne.mockImplementation((e: any, o: any) => {
      if (e === DepositAddress) return { ...dep, creditedAmount: '0' };
      if (e === Transaction) {
        // First lookup: exact txid match fails; the pending-adoption
        // fallback finds the synthetic row.
        return o?.where?.txid === 'realtxid' ? null : synth;
      }
      return null;
    });

    await service.poll();

    expect(synth.txid).toBe('realtxid'); // attribution resolved in place
    expect(synth.status).toBe('confirmed');
    expect(ledger.postEntry).toHaveBeenCalledWith(
      m, wallet, synth, 'deposit_confirmed', '0.50000000', 'credit',
    );
  });

  it('does nothing when balance equals creditedAmount', async () => {
    provider.getAddressBalance.mockResolvedValue('0.5');
    const depCredited = { ...dep, creditedAmount: '0.5' };
    addresses.find.mockResolvedValue([depCredited]);

    await service.poll();

    expect(em.transaction).not.toHaveBeenCalled();
    expect(ledger.postEntry).not.toHaveBeenCalled();
  });

  it('ignores sub-precision float noise — no phantom poll:* zombie row', async () => {
    // Provider balance strings can carry IEEE-754 tails: '…000000084'
    // minus credited '…000000000' is 8.4e-20 — positive but ZERO at BTC's
    // 8 decimals. Creating a row for it mints a 0-amount pending 'poll:*'
    // record that the confirm sweeper can never resolve (seen live:
    // provider 400 spam every cycle on the unresolvable synthetic txid).
    provider.getAddressBalance.mockResolvedValue('0.000006120000000000084');
    const depCredited = { ...dep, creditedAmount: '0.000006120000000000' };
    addresses.find.mockResolvedValue([depCredited]);

    await service.poll();

    expect(em.transaction).not.toHaveBeenCalled();
    expect(m.create.mock.calls.filter((c: any[]) => c[0] === Transaction)).toHaveLength(0);
    expect(ledger.postEntry).not.toHaveBeenCalled();
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('records UTXO deposit as pending below confirmation threshold, no ledger credit', async () => {
    provider.getAddressBalance.mockResolvedValue('0.001');
    provider.getAddressTransactions.mockResolvedValue([{
      txid: 'realtxid',
      chain: 'BTC',
      outputs: [{ address: 'addr-1', amount: '0.001' }],
      confirmations: 0,
      blockNumber: 100,
    }]);
    provider.getLatestBlock.mockResolvedValue(100); // → 1 conf < required 2
    m.findOne.mockImplementation((e: any) =>
      e === DepositAddress ? { ...dep, creditedAmount: '0' } : null);

    await service.poll();

    expect(ledger.postEntry).not.toHaveBeenCalled();
    const created = m.create.mock.calls.find((c: any[]) => c[0] === Transaction)?.[1];
    expect(created.txid).toBe('realtxid');
    expect(created.status).toBe('pending');
    expect(notifier.notify).toHaveBeenCalledWith('deposit.pending', expect.anything());
  });

  it('advances a pending UTXO tx to confirmed when threshold reached', async () => {
    const pendingTx = {
      id: 'tx1', wallet, txid: 'realtxid', address: 'addr-1', asset: 'BTC',
      amount: '0.00100000', status: 'pending', confirmations: 1,
    } as unknown as Transaction;
    provider.getAddressBalance.mockResolvedValue('0.001');
    provider.getAddressTransactions.mockResolvedValue([{
      txid: 'realtxid',
      chain: 'BTC',
      outputs: [{ address: 'addr-1', amount: '0.001' }],
      confirmations: 0,
      blockNumber: 100,
    }]);
    provider.getLatestBlock.mockResolvedValue(101); // → 2 confs = required
    m.findOne.mockImplementation((e: any, o: any) => {
      if (e === DepositAddress) return { ...dep, creditedAmount: '0' };
      if (e === Transaction) return pendingTx;
      return null;
    });

    await service.poll();

    expect(pendingTx.status).toBe('confirmed');
    expect(pendingTx.confirmations).toBe(2);
    expect(ledger.postEntry).toHaveBeenCalledWith(
      m, wallet, pendingTx, 'deposit_confirmed', '0.00100000', 'credit',
    );
    // creditedAmount advanced by the tx amount, not the whole balance
    const savedDep = m.save.mock.calls.map((c: any[]) => c[0])
      .find((o: any) => o?.creditedAmount !== undefined);
    expect(savedDep.creditedAmount).toBe('0.00100000');
  });

  it('reverses a confirmed deposit whose txid vanished (reorg)', async () => {
    const creditedDep = { ...dep, creditedAmount: '0.50000000' };
    addresses.find.mockResolvedValue([creditedDep]);
    const confirmedTx = {
      id: 'tx1', wallet, txid: 'realtxid', address: 'addr-1', asset: 'BTC',
      amount: '0.50000000', status: 'confirmed', confirmations: 3,
      direction: 'inbound', createdAt: new Date(),
    } as unknown as Transaction;
    txs.find.mockResolvedValue([confirmedTx]);
    provider.getTransaction.mockResolvedValue(null); // tx gone from chain
    provider.getAddressBalance.mockResolvedValue('0'); // funds gone too
    m.findOne.mockImplementation((e: any) =>
      e === DepositAddress ? { ...creditedDep } : null);

    await service.poll();

    expect(m.update).toHaveBeenCalledWith(
      Transaction, 'tx1',
      expect.objectContaining({ status: 'reorged' }),
    );
    expect(ledger.postEntry).toHaveBeenCalledWith(
      m, wallet, confirmedTx, 'deposit_reversal', '0.50000000', 'debit',
    );
    expect(notifier.notify).toHaveBeenCalledWith('deposit.reorged', confirmedTx);
    // No re-credit attempted against the dropped balance
    expect(m.create.mock.calls.filter((c: any[]) => c[0] === Transaction)).toHaveLength(0);
  });

  it('rebaselines creditedAmount when the balance dropped (funds swept out)', async () => {
    const creditedDep = { ...dep, creditedAmount: '0.50000000' };
    addresses.find.mockResolvedValue([creditedDep]);
    provider.getAddressBalance.mockResolvedValue('0.1'); // swept

    await service.poll();

    // The stored baseline is precision-normalized — provider strings can
    // carry float noise, and persisting the raw value would poison the
    // next delta comparison the same way.
    expect(addresses.update).toHaveBeenCalledWith('dep1', { creditedAmount: '0.10000000' });
    expect(ledger.postEntry).not.toHaveBeenCalled();
  });

  it('never credits an address+asset shared by another wallet — shared custody cannot attribute', async () => {
    // SOL's enrolled baseAddress is one custody address for ALL wallets:
    // each holds its own watch row, and a balance delta can't tell whose
    // deposit it is. Crediting whichever row polls first would put funds
    // in the wrong wallet — an actual fund loss, not a bookkeeping quirk.
    provider.getAddressBalance.mockResolvedValue('0.5');
    addresses.createQueryBuilder.mockReturnValue({
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(1), // another wallet watches it
    });

    await service.poll();

    // Skipped before even the balance call — ambiguous addresses cost
    // no provider credits and produce no credit, no tx, no event.
    expect(provider.getAddressBalance).not.toHaveBeenCalled();
    expect(em.transaction).not.toHaveBeenCalled();
    expect(ledger.postEntry).not.toHaveBeenCalled();
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('never credits a watch row pointing at a custody treasury/base address', async () => {
    // A wallet account that resolved to the treasury address would turn
    // every ops refill/sweep into a phantom user deposit — and custody
    // outflows would rebaseline the user downward. Skip before the
    // provider call: treasury inflows are never user deposits.
    custody.find.mockResolvedValue([
      { chain: 'BTC', treasuryAddress: 'addr-1', baseAddress: null },
    ]);
    provider.getAddressBalance.mockResolvedValue('0.5');

    await service.poll();

    expect(provider.getAddressBalance).not.toHaveBeenCalled();
    expect(em.transaction).not.toHaveBeenCalled();
    expect(ledger.postEntry).not.toHaveBeenCalled();
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('re-polling a confirmed deposit is a no-op (idempotent)', async () => {
    provider.getAddressBalance.mockResolvedValue('0.5');
    const depDone = { ...dep, creditedAmount: '0.5' };
    addresses.find.mockResolvedValue([depDone]);

    await service.poll();
    await service.poll();

    expect(ledger.postEntry).not.toHaveBeenCalled();
    expect(notifier.notify).not.toHaveBeenCalled();
  });
});

/**
 * Shared-custody memo attribution (SOL): one base address serves every
 * wallet — inbound txs are enumerated and the Memo program instruction
 * resolves the wallet. Money-path tests: a wrong attribution is a fund
 * loss; a missed one strands user funds in custody.
 */
describe('DepositPollerService — shared-custody memo scan (SOL)', () => {
  const BASE = 'SoLbaseAddreSS111111111111111111111111';
  const solWallet = { id: 'w-sol', appId: 'acme' };
  const solDep = {
    id: 'dep-sol',
    address: BASE,
    chain: 'SOL',
    asset: 'SOL',
    status: 'active',
    creditedAmount: '0',
    account: { memo: 'bl-abc12345', wallet: solWallet },
  } as unknown as DepositAddress;

  let service: DepositPollerService;
  let addresses: any;
  let txs: any;
  let custody: any;
  let em: any;
  let m: any;
  let provider: any;
  let ledger: any;
  let notifier: any;

  const historyItem = (txid: string) => ({
    txid, chain: 'SOL',
    outputs: [{ address: BASE, amount: '0' }],
    confirmations: 0, blockNumber: 100,
    status: 'confirmed' as const, raw: {},
  });
  const fullTx = (over: any = {}) => ({
    txid: 'sigA', chain: 'SOL',
    outputs: [{ address: BASE, amount: '0.5' }],
    confirmations: 32, blockNumber: 100,
    status: 'confirmed', memo: 'bl-abc12345', raw: {},
    ...over,
  });

  beforeEach(() => {
    addresses = {
      find: jest.fn().mockResolvedValue([]), // no delta-detect rows — scan only
      findOne: jest.fn(async (o: any) =>
        o?.where?.account?.memo === 'bl-abc12345' ? solDep : null),
      update: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      })),
    };
    custody = {
      find: jest.fn().mockResolvedValue([
        { chain: 'SOL', baseAddress: BASE, treasuryAddress: BASE },
      ]),
    };
    txs = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    };
    m = {
      findOne: jest.fn(async (e: any) =>
        e === DepositAddress ? { ...solDep } : null),
      save: jest.fn(async (_e: any, o?: any) => o ?? _e),
      create: jest.fn((_e: any, o: any) => o),
      update: jest.fn(),
    };
    em = { transaction: jest.fn(async (cb: any) => cb(m)) };
    provider = {
      getAddressBalance: jest.fn(),
      // Scan runs once per enabled SOL asset — only SOL native carries
      // history here; USDC_SOL's fungible scan returns empty.
      getAddressTransactions: jest.fn(async (_a: string, asset: any) =>
        asset.code === 'SOL' ? [historyItem('sigA')] : []),
      getLatestBlock: jest.fn().mockResolvedValue(0),
      getTransaction: jest.fn().mockResolvedValue(fullTx()),
    };
    ledger = { postEntry: jest.fn() };
    notifier = { notify: jest.fn(), notifyEvent: jest.fn() };
    const config = {
      get: jest.fn((k: string) =>
        k === 'detection.strategy' ? 'polling'
        : k === 'confirmations' ? { SOL: 32 }
        : undefined),
    };
    service = new DepositPollerService(
      addresses, txs, custody, em, provider, ledger, notifier, config as any,
    );
  });

  it('credits the wallet whose memo matches — exact match only', async () => {
    await service.poll();

    const created = m.create.mock.calls.find((c: any[]) => c[0] === Transaction)?.[1];
    expect(created.wallet).toBe(solWallet);
    expect(created.amount).toBe('0.500000000'); // SOL = 9 decimals
    expect(created.status).toBe('confirmed'); // 32 confs = finalized
    expect(created.raw).toMatchObject({ memo: 'bl-abc12345', unattributed: false });
    expect(ledger.postEntry).toHaveBeenCalledWith(
      m, solWallet, expect.anything(), 'deposit_confirmed', '0.500000000', 'credit',
    );
    expect(notifier.notify).toHaveBeenCalledWith('deposit.confirmed', expect.anything());
    expect(notifier.notifyEvent).not.toHaveBeenCalled();
  });

  it('records a memo-less deposit unattributed — real funds, ops queue, NO credit', async () => {
    provider.getTransaction.mockResolvedValue(fullTx({ memo: undefined }));

    await service.poll();

    expect(ledger.postEntry).not.toHaveBeenCalled();
    const created = m.create.mock.calls.find((c: any[]) => c[0] === Transaction)?.[1];
    expect(created.wallet).toBeNull();
    expect(created.status).toBe('confirmed'); // on-chain truth — just uncredited
    expect(created.raw.unattributed).toBe(true);
    expect(notifier.notifyEvent).toHaveBeenCalledWith(
      'deposit.unattributed',
      expect.objectContaining({ txid: 'sigA', amount: '0.500000000', memo: null }),
    );
    expect(notifier.notify).not.toHaveBeenCalled(); // no tenant event — no owner yet
  });

  it('records an unknown memo unattributed — never guesses ownership', async () => {
    provider.getTransaction.mockResolvedValue(fullTx({ memo: 'bl-nomatch0' }));

    await service.poll();

    expect(addresses.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          asset: 'SOL',
          account: { memo: 'bl-nomatch0' },
        }),
      }),
    );
    expect(ledger.postEntry).not.toHaveBeenCalled();
    const created = m.create.mock.calls.find((c: any[]) => c[0] === Transaction)?.[1];
    expect(created.wallet).toBeNull();
    expect(created.raw.unattributed).toBe(true);
  });

  it('skips an already-recorded signature without a detail fetch', async () => {
    txs.findOne.mockResolvedValue({ id: 'existing', status: 'confirmed', wallet: null });

    await service.poll();

    expect(provider.getTransaction).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalledWith(Transaction, expect.anything());
    expect(ledger.postEntry).not.toHaveBeenCalled();
  });

  it('ignores a failed on-chain tx entirely', async () => {
    provider.getTransaction.mockResolvedValue(fullTx({ status: 'failed', confirmations: 0 }));

    await service.poll();

    expect(m.create).not.toHaveBeenCalledWith(Transaction, expect.anything());
    expect(ledger.postEntry).not.toHaveBeenCalled();
    expect(notifier.notifyEvent).not.toHaveBeenCalled();
  });

  it('records below-threshold as pending, credits only after it advances', async () => {
    provider.getTransaction.mockResolvedValue(fullTx({ confirmations: 10 }));

    await service.poll();

    const created = m.create.mock.calls.find((c: any[]) => c[0] === Transaction)?.[1];
    expect(created.status).toBe('pending');
    expect(created.wallet).toBe(solWallet); // attribution known — just not final
    expect(ledger.postEntry).not.toHaveBeenCalled();
    expect(notifier.notify).toHaveBeenCalledWith('deposit.pending', expect.anything());
  });

  it('advances an attributed pending row once confirmations reach the threshold', async () => {
    const pending = {
      id: 'tx-p', status: 'pending', wallet: solWallet,
      txid: 'sigA', chain: 'SOL', asset: 'SOL',
      amount: '0.500000000', confirmations: 10,
    } as unknown as Transaction;
    txs.findOne.mockResolvedValue(pending);
    m.findOne.mockImplementation(async (e: any) =>
      e === Transaction ? { ...pending, wallet: 'w-sol' } : null);

    await service.poll();

    expect(ledger.postEntry).toHaveBeenCalledWith(
      m, solWallet, expect.objectContaining({ status: 'confirmed' }),
      'deposit_confirmed', '0.500000000', 'credit',
    );
    expect(notifier.notify).toHaveBeenCalledWith('deposit.confirmed', expect.anything());
  });

  it('scopes the memo lookup by the scanned asset — a token row resolves on its own asset', async () => {
    provider.getAddressTransactions.mockImplementation(async (_a: string, asset: any) =>
      asset.code === 'USDC_SOL' ? [historyItem('sigT')] : []);
    provider.getTransaction.mockResolvedValue(fullTx({
      txid: 'sigT',
      outputs: [{ address: BASE, amount: '10' }],
    }));
    addresses.findOne.mockResolvedValue({
      ...solDep, asset: 'USDC_SOL', creditedAmount: '0',
    });

    await service.poll();

    expect(addresses.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          asset: 'USDC_SOL',
          account: { memo: 'bl-abc12345' },
        }),
      }),
    );
    const created = m.create.mock.calls.find((c: any[]) => c[0] === Transaction)?.[1];
    expect(created.asset).toBe('USDC_SOL');
  });
});

/**
 * Cross-path dedupe — the delta path must never mint a second credit for
 * funds already inside creditedAmount (webhook-credited deposits) or reach
 * into pending rows the webhook path owns. Regression coverage for the
 * live TRON double-credit found on 2026-10-14.
 */
describe('DepositPollerService × webhook dedupe', () => {
  const wallet = { id: 'w1' };
  const dep = {
    id: 'dep1', address: 'Tdep1', chain: 'TRON', asset: 'TRX',
    creditedAmount: '0', status: 'active', account: { wallet },
  } as unknown as DepositAddress;

  let service: DepositPollerService;
  let addresses: any, txs: any, custody: any, em: any, m: any;
  let provider: any, ledger: any, notifier: any, config: any;
  let txRows: any[];

  const isLikePoll = (v: any) => typeof v === 'object' && v !== null;

  const makePoller = () => {
    txRows = [];
    addresses = {
      find: jest.fn().mockResolvedValue([dep]),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      findOneOrFail: jest.fn(async () => ({ creditedAmount: dep.creditedAmount })),
      createQueryBuilder: jest.fn(() => ({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      })),
    };
    custody = { find: jest.fn().mockResolvedValue([]) };
    txs = { find: jest.fn().mockResolvedValue([]), findOne: jest.fn(), update: jest.fn() };
    m = {
      findOne: jest.fn(async (e: any, o: any) => {
        if (e === DepositAddress) return { ...dep, creditedAmount: dep.creditedAmount };
        if (e === Transaction) {
          const w = o?.where ?? {};
          return txRows.find((r) =>
            (!w.txid || (isLikePoll(w.txid)
              ? (r.txid ?? '').startsWith('poll:')
              : r.txid === w.txid)) &&
            (!w.address || r.address === w.address) &&
            (!w.asset || r.asset === w.asset) &&
            (!w.status || r.status === w.status) &&
            (!w.direction || r.direction === w.direction),
          ) ?? null;
        }
        return null;
      }),
      save: jest.fn(async (_e: any, o?: any) => {
        const row = o ?? _e;
        if (!txRows.includes(row)) txRows.push(row);
        return row;
      }),
      create: jest.fn((_e: any, o: any) => o),
      update: jest.fn(),
    };
    em = { transaction: jest.fn(async (cb: any) => cb(m)) };
    provider = {
      getAddressBalance: jest.fn(),
      getAddressTransactions: jest.fn().mockResolvedValue([]),
      getLatestBlock: jest.fn().mockResolvedValue(200),
      getTransaction: jest.fn().mockResolvedValue(null),
    };
    ledger = { postEntry: jest.fn() };
    notifier = { notify: jest.fn(), notifyEvent: jest.fn() };
    config = {
      get: jest.fn((k: string) =>
        k === 'detection.strategy' ? 'polling'
        : k === 'confirmations' ? { TRON: 1 }
        : undefined),
    };
    service = new DepositPollerService(
      addresses, txs, custody, em, provider, ledger, notifier, config,
    );
  };

  beforeEach(makePoller);

  it('does NOT adopt a webhook-created pending row (real txid) into the delta path', async () => {
    // Webhook recorded a pending inbound with a REAL txid; the delta must
    // not merge it — the row confirms through the webhook sweep, not here.
    txRows.push({
      txid: 'real-tx-webhook', address: 'Tdep1', asset: 'TRX',
      direction: 'inbound', status: 'pending', amount: '0.5',
    });
    provider.getAddressBalance.mockResolvedValue('0.5');

    await service.poll();

    const wh = txRows.find((r) => r.txid === 'real-tx-webhook');
    // The webhook row's identity and amount are untouched by the poll.
    expect(wh!.amount).toBe('0.5');
    expect(wh!.txid).toBe('real-tx-webhook');
    // The unattributed delta records a PENDING synthetic row — never a
    // credit. The ledger invariant (no deposit_confirmed on poll:*)
    // backs this at the DB layer; the pending row waits for a real
    // txid to adopt it (poll hit, webhook supersede, or manual credit).
    expect(ledger.postEntry).not.toHaveBeenCalled();
    const synthetic = txRows.find((r) => r.txid.startsWith('poll:'));
    expect(synthetic).toBeDefined();
    expect(synthetic!.status).toBe('pending');
    expect((synthetic!.raw as any).needsAttribution).toBe(true);
  });

  it('hit amount exceeding the uncredited delta = covered — recorded, never re-credited', async () => {
    // creditedAmount 0.5 already holds an old deposit (credited under a
    // synthetic txid). Balance is 1.0: freshDelta=0.5 is genuinely new,
    // but history surfaces the OLD 0.9-value... simulate: hit amount 0.9
    // > freshDelta 0.5 → the tx predates the baseline.
    dep.creditedAmount = '0.5';
    provider.getAddressBalance.mockResolvedValue('1.0');
    provider.getAddressTransactions.mockResolvedValue([{
      txid: 'old-covered-tx', chain: 'TRON',
      outputs: [{ address: 'Tdep1', amount: '0.9' }],
      confirmations: 10, blockNumber: 190,
    }]);

    await service.poll();

    expect(ledger.postEntry).not.toHaveBeenCalled();
    const row = txRows.find((r) => r.txid === 'old-covered-tx');
    expect(row).toBeDefined();
    expect(row!.status).toBe('confirmed');
    expect((row!.raw as any).coveredByBaseline).toBe(true);
  });
});
