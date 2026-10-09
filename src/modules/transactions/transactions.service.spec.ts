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
    walletId: 'w1',
    asset: 'ETH',
    toAddress: '0x' + 'ab'.repeat(20),
    amount: '0.01',
    reference: 'payout-1',
  };

  let service: TransactionsService;
  let txs: any;
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
      txs, accounts, provider, ledger, notifier,
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

  it('returns the existing row when the reference was sent before with the same payload', async () => {
    const prior = {
      id: 'tx-orig', txid: '0xreal',
      asset: 'ETH', address: dto.toAddress, amount: '0.01',
      wallet: { id: 'w1', appId: 'default' },
    };
    txs.findOne.mockResolvedValue(prior);

    const tx = await service.send(dto, 'default');

    expect(tx).toBe(prior);
    expect(ledger.postEntry).not.toHaveBeenCalled();
    expect(provider.sendTransaction).not.toHaveBeenCalled();
  });

  it('409s when the reference was used with a DIFFERENT payload — reuse is a bug, not a retry', async () => {
    const prior = {
      id: 'tx-orig', txid: '0xreal',
      asset: 'ETH', address: '0x' + 'cd'.repeat(20), amount: '0.5',
      wallet: { id: 'w1', appId: 'default' },
    };
    txs.findOne.mockResolvedValue(prior);

    await expect(service.send(dto, 'default')).rejects.toThrow(
      /reference "payout-1" was already used/,
    );
    expect(ledger.postEntry).not.toHaveBeenCalled();
    expect(provider.sendTransaction).not.toHaveBeenCalled();
  });

  it('loses the concurrent race to a DIFFERENT payload under the same reference → 409, not the winner\'s tx', async () => {
    // Both sends pass the dupe check; loser hits UQ_tx_reference. Returning
    // the winner unconditionally would claim a send that never happened.
    txs.findOne
      .mockResolvedValueOnce(null) // dupe lookup — no prior row
      .mockResolvedValueOnce({     // winner after the 23505 — different amount
        id: 'tx-winner', txid: '0xreal',
        asset: 'ETH', address: dto.toAddress, amount: '9.0',
        wallet: { id: 'w1', appId: 'default' },
      });
    dataSource.transaction.mockRejectedValue({ code: '23505' });

    await expect(service.send(dto, 'default')).rejects.toThrow(
      /reference "payout-1" was already used/,
    );
  });

  it('loses the concurrent race to the SAME payload → returns the winner (true retry)', async () => {
    const winner = {
      id: 'tx-winner', txid: '0xreal',
      asset: 'ETH', address: dto.toAddress, amount: '0.010000000000000000',
      wallet: { id: 'w1', appId: 'default' },
    };
    txs.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    dataSource.transaction.mockRejectedValue({ code: '23505' });

    // '0.01' vs stored '0.010000000000000000' — exact decimal normalization.
    await expect(service.send(dto, 'default')).resolves.toBe(winner);
  });

  it('scopes the account lookup by tenant — foreign walletId finds nothing', async () => {
    // The where clause carries both id and appId; with a foreign appId the
    // DB returns nothing, so emulate that (the mock is otherwise honest
    // regardless of the clause).
    accounts.findOne.mockImplementation(({ where }: any) =>
      where.wallet.appId === 'default' ? account : null,
    );

    await expect(service.send(dto, 'other-app')).rejects.toThrow(/No ETH account/);
    expect(accounts.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { wallet: { id: 'w1', appId: 'other-app' }, chain: 'ETH' },
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
