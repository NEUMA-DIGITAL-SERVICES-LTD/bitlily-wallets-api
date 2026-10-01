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
  let em: any;
  let m: any; // transactional EntityManager
  let provider: any;
  let ledger: any;
  let notifier: any;
  let config: any;

  const makePoller = () => {
    addresses = { find: jest.fn().mockResolvedValue([dep]), update: jest.fn() };
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
      addresses, {} as any, em, provider, ledger, notifier, config,
    );
  };

  beforeEach(makePoller);

  it('credits a new deposit on balance delta (no-txid path)', async () => {
    provider.getAddressBalance.mockResolvedValue('0.5');
    m.findOne.mockImplementation((e: any) =>
      e === DepositAddress ? { ...dep, creditedAmount: '0' } : null);

    await service.poll();

    expect(ledger.postEntry).toHaveBeenCalledWith(
      m, wallet, expect.objectContaining({ amount: '0.50000000' }),
      'deposit_confirmed', '0.50000000', 'credit',
    );
    // creditedAmount advanced to the observed balance
    const savedDep = m.save.mock.calls.map((c: any[]) => c[0])
      .find((o: any) => o?.creditedAmount !== undefined);
    expect(savedDep.creditedAmount).toBe('0.5');
    expect(notifier.notify).toHaveBeenCalledWith('deposit.confirmed', expect.anything());
  });

  it('does nothing when balance equals creditedAmount', async () => {
    provider.getAddressBalance.mockResolvedValue('0.5');
    const depCredited = { ...dep, creditedAmount: '0.5' };
    addresses.find.mockResolvedValue([depCredited]);

    await service.poll();

    expect(em.transaction).not.toHaveBeenCalled();
    expect(ledger.postEntry).not.toHaveBeenCalled();
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
