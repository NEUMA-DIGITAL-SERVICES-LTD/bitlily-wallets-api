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
  const dto = {
    walletId: 'w1',
    asset: 'ETH',
    toAddress: '0xdest',
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
    };
    txs = { update: jest.fn() };
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
    await expect(service.send(dto)).rejects.toThrow(/Insufficient/);
    expect(provider.sendTransaction).not.toHaveBeenCalled();
    expect(ledger.postEntry).not.toHaveBeenCalled();
  });

  it('debits first, then broadcasts, then records the real txid', async () => {
    provider.sendTransaction.mockResolvedValue({ txid: '0xreal' });

    const tx = await service.send(dto);

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
    expect(notifier.notify).toHaveBeenCalledWith('transaction.broadcast', tx);
  });

  it('marks failed and reverses the debit when broadcast throws', async () => {
    provider.sendTransaction.mockRejectedValue(new Error('insufficient funds for gas'));

    await expect(service.send(dto)).rejects.toThrow(BadGatewayException);

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
});
