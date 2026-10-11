import { BadGatewayException } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { Transaction } from '../../database/entities/transaction.entity';

/**
 * The withdrawal path's accounting invariants: debit lands before broadcast,
 * a failed broadcast reverses the debit, and a success swaps the placeholder
 * txid for the real one. A crash between debit and broadcast leaves a
 * pending:* row — the reconciler's job — but broadcast failure must never
 * leave the debit standing.
 */
describe('TransactionsService.send', () => {
  const wallet = { id: 'w1' };
  const account = { id: 'acct1', wallet, chain: 'ethereum' };
  // Valid-format address — the service rejects implausible destinations
  // before any ledger movement.
  const dto = {
    externalUserId: 'user-1',
    asset: 'ETH',
    toAddress: '0x' + 'ab'.repeat(20),
    amount: '0.01',
    reference: 'payout-1',
  };

  let service: TransactionsService;
  let txs: any;
  let wallets: any;
  let accounts: any;
  let provider: any;
  let ledger: any;
  let notifier: any;
  let dataSource: any;
  let m: any;

  beforeEach(() => {
    m = {
      save: jest.fn(async (_e: any, o?: any) => ({ ...(o ?? _e), id: 'tx-1' })),
      create: jest.fn((_e: any, o: any) => o),
      update: jest.fn(),
      findOneOrFail: jest.fn().mockResolvedValue(wallet),
    };
    txs = { update: jest.fn(), findOne: jest.fn().mockResolvedValue(null) };
    wallets = { findOne: jest.fn().mockResolvedValue(wallet) };
    accounts = { findOne: jest.fn().mockResolvedValue(account) };
    provider = { sendTransaction: jest.fn() };
    ledger = {
      getBalance: jest.fn().mockResolvedValue('1.0'),
      postEntry: jest.fn(),
    };
    notifier = { notify: jest.fn() };
    dataSource = {
      transaction: jest.fn(async (cb: any) => cb(m)),
      getRepository: jest.fn().mockReturnValue({
        findOne: jest.fn().mockResolvedValue(null),
      }),
    };
    service = new TransactionsService(
      txs, wallets, accounts, provider, ledger, notifier,
      { get: jest.fn().mockReturnValue({}) } as any,
      dataSource,
    );
  });

  it('rejects when the ledger cannot cover the send', async () => {
    ledger.getBalance.mockResolvedValue('0.005');
    await expect(service.send(dto, 'default')).rejects.toThrow(/Insufficient/);
    expect(provider.sendTransaction).not.toHaveBeenCalled();
    expect(ledger.postEntry).not.toHaveBeenCalled();
  });

  it('debits first, then broadcasts, then records the real txid', async () => {
    provider.sendTransaction.mockResolvedValue({ txid: '0xreal' });

    const tx = await service.send(dto, 'default');

    // Debit posted inside the DB transaction, before broadcast.
    // postEntry(em, wallet, tx, kind, amount, direction).
    const debitCall = ledger.postEntry.mock.calls.findIndex(
      (c: any[]) => c[3] === 'withdrawal' && c[5] === 'debit',
    );
    const broadcastCall = provider.sendTransaction.mock.invocationCallOrder[0];
    expect(debitCall).toBeGreaterThanOrEqual(0);
    expect(ledger.postEntry.mock.invocationCallOrder[debitCall])
      .toBeLessThan(broadcastCall);

    // Row created pending with placeholder txid, then updated to real txid.
    const created = m.create.mock.calls.find((c: any[]) => c[0] === Transaction)?.[1];
    expect(created.status).toBe('pending');
    expect(created.txid).toMatch(/^pending:/);
    expect(txs.update).toHaveBeenCalledWith('tx-1', { txid: '0xreal' });
    expect(tx.txid).toBe('0xreal');
    expect(notifier.notify).toHaveBeenCalledWith('withdrawal.broadcast', tx);
  });

  it('marks failed and reverses the debit when broadcast throws', async () => {
    provider.sendTransaction.mockRejectedValue(new Error('insufficient funds for gas'));

    await expect(service.send(dto, 'default')).rejects.toThrow(BadGatewayException);

    expect(m.update).toHaveBeenCalledWith(
      Transaction, 'tx-1', { status: 'failed' },
    );
    expect(ledger.postEntry).toHaveBeenCalledWith(
      m, wallet, expect.objectContaining({ status: 'pending' }),
      'withdrawal_reversal', '0.01', 'credit',
    );
    expect(notifier.notify).not.toHaveBeenCalled();
    expect(txs.update).not.toHaveBeenCalled(); // never a real txid
  });

  it('rejects non-positive amounts before any ledger movement', async () => {
    for (const amount of ['0', '-5', 'abc', '']) {
      await expect(service.send({ ...dto, amount }, 'default')).rejects.toThrow(
        /greater than zero|positive decimal/,
      );
    }
    expect(ledger.postEntry).not.toHaveBeenCalled();
    expect(provider.sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects malformed destination addresses before the debit', async () => {
    await expect(
      service.send({ ...dto, toAddress: 'not-an-address' }, 'default'),
    ).rejects.toThrow(/not a valid ETH address/);
    // Wrong chain's format must not pass either.
    await expect(
      service.send({ ...dto, toAddress: 'mvw7cGjmWaSBFeQmGebZeVBVYx7h9pU2k' }, 'default'),
    ).rejects.toThrow(/not a valid ETH address/);
    expect(ledger.postEntry).not.toHaveBeenCalled();
  });

  it('409s ANY repeat of a used reference — the hard-uniqueness contract', async () => {
    const prior = {
      id: 'tx-orig', txid: '0xreal',
      asset: 'ETH', address: dto.toAddress, amount: '0.01',
      wallet: { id: 'w1', appId: 'default' }, status: 'confirmed',
    };
    txs.findOne.mockResolvedValue(prior);

    await expect(service.send(dto, 'default')).rejects.toThrow(
      /reference "payout-1" already used by transaction tx-orig/,
    );
    expect(ledger.postEntry).not.toHaveBeenCalled();
    expect(provider.sendTransaction).not.toHaveBeenCalled();
  });

  it('loses the concurrent race under a used reference → 409 naming the winner', async () => {
    // Both sends pass the dupe check; loser hits UQ_tx_reference — it must
    // see the same loud 409 any other duplicate gets, never the winner.
    txs.findOne
      .mockResolvedValueOnce(null) // dupe lookup — no prior row
      .mockResolvedValueOnce({     // winner after the 23505
        id: 'tx-winner', txid: '0xreal', status: 'pending',
        wallet: { id: 'w1', appId: 'default' },
      });
    dataSource.transaction.mockRejectedValue({ code: '23505' });

    await expect(service.send(dto, 'default')).rejects.toThrow(
      /reference "payout-1" already used by transaction tx-winner/,
    );
  });

  it('scopes the wallet lookup by tenant — foreign externalUserId finds nothing', async () => {
    // The where clause carries appId; with a foreign tenant's key the DB
    // returns nothing, so emulate that (the mock is otherwise honest
    // regardless of the clause).
    wallets.findOne.mockImplementation(({ where }: any) =>
      where.appId === 'default' ? wallet : null,
    );

    await expect(service.send(dto, 'other-app')).rejects.toThrow(
      /No wallet for externalUserId/,
    );
    expect(wallets.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { externalUserId: 'user-1', appId: 'other-app' },
      }),
    );
    expect(ledger.postEntry).not.toHaveBeenCalled();
  });

  it('get() 404s a transaction belonging to another app', async () => {
    txs.findOne.mockResolvedValue({ id: 'tx-1', wallet: { id: 'w1', appId: 'acme' } });
    await expect(service.get('tx-1', 'default')).rejects.toThrow(/not found/);
    txs.findOne.mockResolvedValue({ id: 'tx-1', wallet: { id: 'w1', appId: 'default' } });
    await expect(service.get('tx-1', 'default')).resolves.toBeDefined();
  });
});
