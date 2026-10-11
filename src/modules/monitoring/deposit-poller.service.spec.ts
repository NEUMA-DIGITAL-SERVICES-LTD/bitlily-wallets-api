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
    notifier = { notify: jest.fn() };
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
