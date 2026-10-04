import { OutboundStatusService } from './outbound-status.service';
import { Transaction } from '../../database/entities/transaction.entity';

/**
 * The outbound sweeper is the truth-teller for payouts: KMS async signing
 * resolves or reverses, placeholder-txid orphans get alerted once, and
 * on-chain disappearance marks failed. These tests pin the KMS lifecycle
 * and the crash-window reconciliation path.
 */
describe('OutboundStatusService', () => {
  const wallet = { id: 'w1' } as any;
  const baseTx: Partial<Transaction> = {
    id: 'tx-1',
    wallet,
    direction: 'outbound',
    chain: 'ETH',
    asset: 'ETH',
    amount: '0.005',
    address: '0xdest',
    status: 'pending',
    confirmations: 0,
    requiredConfirmations: 12,
    createdAt: new Date(),
  };

  let service: OutboundStatusService;
  let txs: any;
  let provider: any;
  let ledger: any;
  let notifier: any;
  let m: any;

  beforeEach(() => {
    txs = { find: jest.fn(), save: jest.fn(async (t: any) => t) };
    provider = {
      getPendingSignature: jest.fn(),
      getTransaction: jest.fn(),
      getLatestBlock: jest.fn().mockResolvedValue(1000),
    };
    ledger = { postEntry: jest.fn() };
    notifier = { notify: jest.fn() };
    m = { update: jest.fn() };
    const em = { transaction: jest.fn(async (cb: any) => cb(m)) };
    service = new OutboundStatusService(
      txs, em as any, provider, ledger, notifier,
      { get: jest.fn().mockReturnValue({}) } as any,
    );
  });

  const queue = (tx: Partial<Transaction>) =>
    txs.find.mockResolvedValue([tx as Transaction]);

  it('resolves a KMS request into a real txid and continues lifecycle', async () => {
    queue({
      ...baseTx,
      txid: 'pending:abc',
      raw: { kmsRequestId: 'kms-1' },
    });
    provider.getPendingSignature.mockResolvedValue({ txid: '0xreal' });
    provider.getTransaction.mockResolvedValue({
      txid: '0xreal',
      blockNumber: 995,
      confirmations: 1,
      status: 'confirmed',
    });

    await service.sweep();

    expect(txs.save).toHaveBeenCalledWith(
      expect.objectContaining({ txid: '0xreal' }),
    );
    expect(notifier.notify).toHaveBeenCalledWith(
      'withdrawal.broadcast',
      expect.objectContaining({ txid: '0xreal' }),
    );
    // No reversal — funds moved.
    expect(ledger.postEntry).not.toHaveBeenCalled();
  });

  it('reverses the debit when KMS rejects the signing request', async () => {
    queue({
      ...baseTx,
      txid: 'pending:abc',
      raw: { kmsRequestId: 'kms-1' },
    });
    provider.getPendingSignature.mockResolvedValue({ status: 'failed' });

    await service.sweep();

    expect(m.update).toHaveBeenCalledWith(
      Transaction, 'tx-1', { status: 'failed' },
    );
    expect(ledger.postEntry).toHaveBeenCalledWith(
      m, wallet, expect.anything(), 'withdrawal_reversal', '0.005', 'credit',
    );
    expect(notifier.notify).toHaveBeenCalledWith(
      'withdrawal.failed', expect.anything(),
    );
    expect(txs.save).not.toHaveBeenCalled();
  });

  it('reverses the debit when the KMS request vanished', async () => {
    queue({
      ...baseTx,
      txid: 'pending:abc',
      raw: { kmsRequestId: 'kms-gone' },
    });
    provider.getPendingSignature.mockResolvedValue(null);

    await service.sweep();

    expect(ledger.postEntry).toHaveBeenCalledWith(
      m, wallet, expect.anything(), 'withdrawal_reversal', '0.005', 'credit',
    );
  });

  it('leaves a still-signing KMS request pending without reversal', async () => {
    queue({
      ...baseTx,
      txid: 'pending:abc',
      raw: { kmsRequestId: 'kms-1' },
    });
    provider.getPendingSignature.mockResolvedValue({ status: 'pending' });

    await service.sweep();

    expect(ledger.postEntry).not.toHaveBeenCalled();
    expect(txs.save).not.toHaveBeenCalled();
  });

  it('alerts once on a stale placeholder txid (crash between debit and broadcast)', async () => {
    const staleTx = {
      ...baseTx,
      txid: 'pending:orphan',
      raw: {},
      createdAt: new Date(Date.now() - 11 * 60 * 1000),
    };
    queue(staleTx);

    await service.sweep();

    expect(notifier.notify).toHaveBeenCalledWith(
      'withdrawal.reconcile_required', staleTx,
    );
    expect(txs.save).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: expect.objectContaining({ reconcileAlerted: true }),
      }),
    );

    // Second sweep — alert deduped.
    notifier.notify.mockClear();
    staleTx.raw = { reconcileAlerted: true };
    await service.sweep();
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('marks failed when the txid never appears on-chain after the window', async () => {
    queue({
      ...baseTx,
      txid: '0xdropped',
      createdAt: new Date(Date.now() - 61 * 60 * 1000),
    });
    provider.getTransaction.mockResolvedValue(null);

    await service.sweep();

    expect(txs.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(notifier.notify).toHaveBeenCalledWith(
      'withdrawal.failed', expect.anything(),
    );
  });
});
