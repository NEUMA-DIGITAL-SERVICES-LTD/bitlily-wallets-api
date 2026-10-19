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
  let walletOps: any;

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
    walletOps = { createWallet: jest.fn() };
    service = new TransactionsService(
      txs, wallets, accounts, provider, ledger, notifier,
      { get: jest.fn().mockReturnValue({}) } as any,
      dataSource,
      walletOps,
    );
  });

  it('rejects when the ledger cannot cover the send', async () => {
    ledger.getBalance.mockResolvedValue('0.005');
    await expect(service.send(dto, 'default')).rejects.toThrow(/Insufficient/);
    expect(provider.sendTransaction).not.toHaveBeenCalled();
    expect(ledger.postEntry).not.toHaveBeenCalled();
  });

  it('skips the balance gate for enforceBalance=false clients — fiat-funded sends still debit', async () => {
    ledger.getBalance.mockResolvedValue('0.001'); // less than the 0.01 send
    provider.sendTransaction.mockResolvedValue({ txid: '0xreal' });

    const tx = await service.send(dto, 'fiat-app', false);

    // The balance is never even read — the app's backend is the
    // authority. The debit still posts: the ledger records what the
    // app's books owe custody.
    expect(ledger.getBalance).not.toHaveBeenCalled();
    expect(ledger.postEntry).toHaveBeenCalledWith(
      m, wallet, expect.anything(), 'withdrawal', '0.01', 'debit',
    );
    expect(provider.sendTransaction).toHaveBeenCalled();
    expect(tx.txid).toBe('0xreal');
  });

  it('still enforces the balance gate by default when the flag is omitted', async () => {
    ledger.getBalance.mockResolvedValue('0.005');
    await expect(service.send(dto, 'default')).rejects.toThrow(/Insufficient/);
    expect(provider.sendTransaction).not.toHaveBeenCalled();
  });

  it('stamps the request-time fee estimate on the row — the app shows it without a second call', async () => {
    provider.estimateFee = jest.fn().mockResolvedValue({ fee: '0.00021' });
    provider.sendTransaction.mockResolvedValue({ txid: '0xreal' });

    await service.send(dto, 'default');

    const created = m.create.mock.calls.find((c: any[]) => c[0] === Transaction)?.[1];
    expect(created.fee).toBe('0.00021');
    expect(provider.estimateFee).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ETH' }), dto.toAddress, '0.01',
    );
  });

  it('an estimate failure never blocks the send — fee stays null', async () => {
    provider.estimateFee = jest.fn().mockRejectedValue(new Error('RPC down'));
    provider.sendTransaction.mockResolvedValue({ txid: '0xreal' });

    const tx = await service.send(dto, 'default');

    const created = m.create.mock.calls.find((c: any[]) => c[0] === Transaction)?.[1];
    expect(created.fee).toBeNull();
    expect(tx.txid).toBe('0xreal');
  });

  it('omitted externalUserId debits the app-level sentinel wallet (auto-provisioned)', async () => {
    // No existing wallet — the sentinel path must create it, then use it.
    wallets.findOne.mockResolvedValue(null);
    const sentinelWallet = { id: 'w-app', externalUserId: '__app_level__' };
    walletOps.createWallet.mockResolvedValue(sentinelWallet);
    accounts.findOne.mockResolvedValue({ ...account, wallet: sentinelWallet });
    provider.sendTransaction.mockResolvedValue({ txid: '0xreal' });

    const tx = await service.send(
      { asset: 'ETH', toAddress: '0x' + 'a'.repeat(40), amount: '0.01' } as any,
      'default',
    );

    expect(walletOps.createWallet).toHaveBeenCalledWith('__app_level__', 'default');
    expect(ledger.postEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ externalUserId: '__app_level__' }),
      expect.anything(), 'withdrawal', '0.01', 'debit',
    );
    expect(tx.txid).toBe('0xreal');
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

  it('503s + reverses when treasury cannot fund the send — no KMS call at all', async () => {
    // Custody holds 0.02 ETH; the send needs 0.01 + ~0.00021 gas. Without
    // the pre-check this debits, fails at broadcast, reverses — a confusing
    // 502. The gate must catch it first and alert ops immediately.
    const custRepo = { findOne: jest.fn().mockResolvedValue({ treasuryAddress: '0xtreasury' }) };
    dataSource.getRepository.mockReturnValue(custRepo);
    notifier.notifyEvent = jest.fn();
    provider.getAddressBalance = jest.fn().mockResolvedValue('0.005');
    provider.estimateFee = jest.fn().mockResolvedValue({ fee: '0.00021' });

    await expect(service.send(dto, 'default')).rejects.toThrow(/Treasury underfunded/);

    expect(provider.sendTransaction).not.toHaveBeenCalled();
    expect(notifier.notifyEvent).toHaveBeenCalledWith(
      'treasury.insufficient',
      expect.objectContaining({ chain: 'ETH', balance: '0.005' }),
    );
    // The committed debit still reverses — the user's balance is untouched.
    expect(ledger.postEntry).toHaveBeenCalledWith(
      m, wallet, expect.anything(), 'withdrawal_reversal', '0.01', 'credit',
    );
  });

  it('broadcasts when treasury covers amount + native fee', async () => {
    dataSource.getRepository.mockReturnValue({
      findOne: jest.fn().mockResolvedValue({ treasuryAddress: '0xtreasury' }),
    });
    provider.getAddressBalance = jest.fn().mockResolvedValue('0.5');
    provider.estimateFee = jest.fn().mockResolvedValue({ fee: '0.00021' });
    provider.sendTransaction.mockResolvedValue({ txid: '0xreal' });

    const tx = await service.send(dto, 'default');

    expect(provider.getAddressBalance).toHaveBeenCalledWith('0xtreasury', expect.anything());
    expect(provider.sendTransaction).toHaveBeenCalled();
    expect(tx.txid).toBe('0xreal');
  });

  it('fails open when the treasury balance is unreadable — broadcast still decides', async () => {
    dataSource.getRepository.mockReturnValue({
      findOne: jest.fn().mockResolvedValue({ treasuryAddress: '0xtreasury' }),
    });
    provider.getAddressBalance = jest.fn().mockRejectedValue(new Error('RPC down'));
    provider.sendTransaction.mockResolvedValue({ txid: '0xreal' });

    const tx = await service.send(dto, 'default');

    // A provider outage must not freeze withdrawals harder than it already
    // does — the broadcast path + reversal remains the safety net.
    expect(provider.sendTransaction).toHaveBeenCalled();
    expect(tx.txid).toBe('0xreal');
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

/**
 * The app-wide feed's contract: the tenant boundary is the join on
 * wallet.appId (never a client-supplied value), internal custody rows are
 * always excluded, pagination is bounded, and the wire shape drops `raw`
 * while flattening externalUserId onto each row.
 */
describe('TransactionsService.listForApp', () => {
  let service: TransactionsService;
  let qb: any;
  let txs: any;

  const row = (over: any = {}) => ({
    id: 'tx-1',
    direction: 'inbound',
    chain: 'TRON',
    asset: 'TRX',
    txid: 'abc123',
    address: 'Txyz',
    amount: '5',
    fee: null,
    status: 'confirmed',
    confirmations: 20,
    requiredConfirmations: 1,
    blockNumber: 100,
    reference: null,
    idempotencyKey: null,
    raw: { provider: 'tatum', secret: 'stuff' },
    wallet: { id: 'w1', externalUserId: 'user-1' },
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...over,
  });

  beforeEach(() => {
    const calls: any = { andWheres: [], wheres: [] };
    qb = {
      calls,
      innerJoin: jest.fn(() => qb),
      addSelect: jest.fn(() => qb),
      where: jest.fn((expr: string, params: any) => {
        calls.wheres.push({ expr, params });
        return qb;
      }),
      andWhere: jest.fn((expr: string, params?: any) => {
        calls.andWheres.push({ expr, params });
        return qb;
      }),
      orderBy: jest.fn(() => qb),
      addOrderBy: jest.fn(() => qb),
      take: jest.fn(() => qb),
      skip: jest.fn(() => qb),
      getManyAndCount: jest.fn(async () => [[row()], 1]),
    };
    txs = { createQueryBuilder: jest.fn(() => qb) };
    service = new TransactionsService(
      txs, {} as any, {} as any, {} as any, {} as any, {} as any,
      { get: jest.fn().mockReturnValue({}) } as any,
      {} as any,
      {} as any,
    );
  });

  it('scopes to the caller tenant and always excludes internal rows', async () => {
    await service.listForApp('acme', {} as any);
    expect(qb.where).toHaveBeenCalledWith('w.appId = :appId', { appId: 'acme' });
    expect(qb.calls.andWheres).toContainEqual(
      expect.objectContaining({ expr: `t.raw ->> 'internal' IS NULL` }),
    );
  });

  it('defaults page=1 limit=20, caps limit at 100, and offsets pages', async () => {
    await service.listForApp('a', {} as any);
    expect(qb.take).toHaveBeenLastCalledWith(20);
    expect(qb.skip).toHaveBeenLastCalledWith(0);

    await service.listForApp('a', { limit: 500 } as any);
    expect(qb.take).toHaveBeenLastCalledWith(100);

    await service.listForApp('a', { page: 3, limit: 10 } as any);
    expect(qb.take).toHaveBeenLastCalledWith(10);
    expect(qb.skip).toHaveBeenLastCalledWith(20);
  });

  it('applies each filter as a parameterized clause', async () => {
    await service.listForApp('a', {
      direction: 'outbound', status: 'pending', chain: 'tron',
      asset: 'trx', externalUserId: 'user-9', reference: 'r-1', txid: 'dead',
    } as any);

    const { andWheres } = qb.calls;
    expect(andWheres).toContainEqual(
      { expr: 't.direction = :direction', params: { direction: 'outbound' } });
    expect(andWheres).toContainEqual(
      { expr: 't.status = :status', params: { status: 'pending' } });
    // chain/asset normalize to canonical codes before binding
    expect(andWheres).toContainEqual(
      { expr: 't.chain = :chain', params: { chain: 'TRON' } });
    expect(andWheres).toContainEqual(
      { expr: 't.asset = :asset', params: { asset: 'TRX' } });
    expect(andWheres).toContainEqual(
      { expr: 'w.externalUserId = :externalUserId', params: { externalUserId: 'user-9' } });
    expect(andWheres).toContainEqual(
      { expr: 't.reference = :reference', params: { reference: 'r-1' } });
    expect(andWheres).toContainEqual(
      { expr: 't.txid = :txid', params: { txid: 'dead' } });
  });

  it('rejects unknown assets and chains with 400s', async () => {
    await expect(
      service.listForApp('a', { asset: 'NOTACOIN' } as any),
    ).rejects.toThrow(/Unsupported asset/);
    await expect(
      service.listForApp('a', { chain: 'NOTACHAIN' } as any),
    ).rejects.toThrow(/Unsupported chain/);
  });

  it('strips raw and the wallet join, flattening externalUserId', async () => {
    const res = await service.listForApp('a', {} as any);
    expect(res).toEqual({ data: [expect.any(Object)], total: 1, page: 1, limit: 20 });
    const item = res.data[0];
    expect(item.externalUserId).toBe('user-1');
    expect(item).not.toHaveProperty('raw');
    expect(item).not.toHaveProperty('wallet');
    expect(item.txid).toBe('abc123');
  });

  it('returns a valid empty page', async () => {
    qb.getManyAndCount.mockResolvedValue([[], 0]);
    const res = await service.listForApp('a', { page: 9 } as any);
    expect(res).toEqual({ data: [], total: 0, page: 9, limit: 20 });
  });
});

/**
 * Client-UI format check: same pre-broadcast gate as POST /withdrawals,
 * exposed so apps can validate on input instead of on submit. A malformed
 * address is the ANSWER (valid:false), never an error — only unknown
 * chains/assets 400.
 */
describe('TransactionsService.validateAddress', () => {
  let service: TransactionsService;

  beforeEach(() => {
    service = new TransactionsService(
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      { get: jest.fn().mockReturnValue({}) } as any,
      {} as any,
      {} as any,
    );
  });

  it('validates by asset code, resolving its chain (USDT_TRON → TRON)', async () => {
    const res = service.validateAddress(
      'TQpeU63gg1SZgDnsVT47fuWJkBQESJynYZ',
      { asset: 'USDT_TRON' },
    );
    expect(res).toEqual({
      address: 'TQpeU63gg1SZgDnsVT47fuWJkBQESJynYZ',
      chain: 'TRON',
      valid: true,
    });
  });

  it('validates by raw chain too', () => {
    const res = service.validateAddress('0x' + 'ab'.repeat(20), { chain: 'eth' });
    expect(res).toEqual({ address: '0x' + 'ab'.repeat(20), chain: 'ETH', valid: true });
  });

  it('returns valid:false for malformed input — the answer, not an error', () => {
    expect(service.validateAddress('not-an-address', { chain: 'BTC' }).valid).toBe(false);
    // Wrong-chain paste is a false, same as the send gate would reject.
    expect(
      service.validateAddress('mvw7cGjmWaSBFeQmGebZeVBVYx7h9pU2k', { asset: 'ETH' }).valid,
    ).toBe(false);
  });

  it('400s on unknown asset, unknown chain, or neither param', () => {
    expect(() => service.validateAddress('x', { asset: 'NOTACOIN' }))
      .toThrow(/Unsupported asset/);
    expect(() => service.validateAddress('x', { chain: 'NOTACHAIN' }))
      .toThrow(/Unsupported chain/);
    expect(() => service.validateAddress('x', {}))
      .toThrow(/either asset or chain/);
  });
});

describe('TransactionsService.estimateFee', () => {
  let service: TransactionsService;
  let provider: any;

  beforeEach(() => {
    provider = { estimateFee: jest.fn().mockResolvedValue({ asset: 'ETH', fee: '0.001' }) };
    service = new TransactionsService(
      {} as any, {} as any, {} as any, provider, {} as any, {} as any,
      { get: jest.fn().mockReturnValue({}) } as any,
      { getRepository: jest.fn().mockReturnValue({ findOne: jest.fn().mockResolvedValue(null) }) } as any,
      {} as any,
    );
  });

  it('forwards an omitted destination — providers fall back to a typical-transfer quote', async () => {
    const res = await service.estimateFee('ETH', undefined, '0.01');
    expect(provider.estimateFee).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ETH' }), undefined, '0.01', undefined,
    );
    expect(res.fee).toBe('0.001');
  });

  it('still rejects a malformed destination when one IS provided', async () => {
    await expect(service.estimateFee('ETH', 'garbage', '0.01'))
      .rejects.toThrow(/not a valid ETH address/);
    expect(provider.estimateFee).not.toHaveBeenCalled();
  });
});

/**
 * OPS manual credit for unattributed shared-custody deposits (SOL
 * missing/wrong memo): attribution must be explicit, idempotent (an
 * already-attributed deposit can never double-credit), and auditable.
 */
describe('TransactionsService.creditUnattributedDeposit', () => {
  const wallet = { id: 'w1', appId: 'acme', externalUserId: 'user-1' };
  const unattributed = {
    id: 'tx-u',
    wallet: null,
    direction: 'inbound',
    chain: 'SOL',
    asset: 'SOL',
    txid: 'sigA',
    address: 'SoLbase111',
    amount: '0.500000000',
    status: 'confirmed',
    raw: { detectedVia: 'memo-polling', memo: null, unattributed: true },
  } as unknown as Transaction;

  let service: TransactionsService;
  let txs: any;
  let wallets: any;
  let ledger: any;
  let notifier: any;
  let dataSource: any;
  let m: any;
  let walletOps: any;

  beforeEach(() => {
    m = {
      findOne: jest.fn().mockResolvedValue({ ...unattributed }),
      save: jest.fn(async (_e: any, o?: any) => o ?? _e),
      create: jest.fn((_e: any, o: any) => o),
      update: jest.fn(),
      increment: jest.fn(),
    };
    txs = {};
    wallets = { findOne: jest.fn().mockResolvedValue(wallet) };
    ledger = { postEntry: jest.fn() };
    notifier = { notify: jest.fn() };
    dataSource = { transaction: jest.fn(async (cb: any) => cb(m)) };
    service = new TransactionsService(
      txs, wallets, {} as any, {} as any, ledger, notifier,
      { get: jest.fn().mockReturnValue({}) } as any,
      dataSource,
      {} as any,
    );
  });

  it('credits the named wallet, posts the ledger entry, and audits attribution', async () => {
    const tx = await service.creditUnattributedDeposit('tx-u', 'acme', 'user-1');

    expect(m.findOne).toHaveBeenCalledWith(
      Transaction,
      expect.objectContaining({
        where: { id: 'tx-u' },
        lock: { mode: 'pessimistic_write' },
      }),
    );
    const saved = m.save.mock.calls[0][0];
    expect(saved.wallet).toBe(wallet);
    expect(saved.raw.unattributed).toBe(false);
    expect(saved.raw.attribution).toMatchObject({ by: 'admin', appId: 'acme', externalUserId: 'user-1' });
    expect(ledger.postEntry).toHaveBeenCalledWith(
      m, wallet, saved, 'deposit_confirmed', '0.500000000', 'credit',
    );
    // The manual credit must advance the delta baseline — otherwise the
    // next poll re-detects the same balance growth and mints a second
    // credit under a synthetic poll:* txid (live double-credit on TRON).
    expect(m.increment).toHaveBeenCalledWith(
      expect.anything(),
      { address: 'SoLbase111', asset: 'SOL' },
      'creditedAmount',
      0.5,
    );
    expect(notifier.notify).toHaveBeenCalledWith('deposit.confirmed', tx);
  });

  it('rejects a second credit — already-attributed rows conflict, never double-credit', async () => {
    m.findOne.mockResolvedValue({ ...unattributed, wallet: 'w-other' });

    await expect(
      service.creditUnattributedDeposit('tx-u', 'acme', 'user-1'),
    ).rejects.toThrow(/already attributed/);
    expect(ledger.postEntry).not.toHaveBeenCalled();
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('404s when the target wallet does not exist under that app', async () => {
    wallets.findOne.mockResolvedValue(null);

    await expect(
      service.creditUnattributedDeposit('tx-u', 'acme', 'ghost-user'),
    ).rejects.toThrow(/No wallet/);
    expect(ledger.postEntry).not.toHaveBeenCalled();
  });

  it('rejects crediting a deposit that has not confirmed on-chain', async () => {
    m.findOne.mockResolvedValue({ ...unattributed, status: 'pending' });

    await expect(
      service.creditUnattributedDeposit('tx-u', 'acme', 'user-1'),
    ).rejects.toThrow(/only confirmed\/finalized deposits/);
    expect(ledger.postEntry).not.toHaveBeenCalled();
  });

  it('rejects outbound rows and deposits not flagged unattributed', async () => {
    m.findOne.mockResolvedValue({ ...unattributed, direction: 'outbound' });
    await expect(
      service.creditUnattributedDeposit('tx-u', 'acme', 'user-1'),
    ).rejects.toThrow(/inbound deposits/);

    m.findOne.mockResolvedValue({ ...unattributed, raw: { detectedVia: 'polling' } });
    await expect(
      service.creditUnattributedDeposit('tx-u', 'acme', 'user-1'),
    ).rejects.toThrow(/not flagged unattributed/);
  });

  it('the ops queue lists only wallet-less inbound rows flagged unattributed', async () => {
    const qb: any = {
      where: jest.fn(() => qb),
      andWhere: jest.fn(() => qb),
      orderBy: jest.fn(() => qb),
      take: jest.fn(() => qb),
      getMany: jest.fn().mockResolvedValue([unattributed]),
    };
    txs.createQueryBuilder = jest.fn(() => qb);

    const res = await service.listUnattributedDeposits('sol');

    expect(qb.where).toHaveBeenCalledWith('t.wallet_id IS NULL');
    expect(qb.andWhere).toHaveBeenCalledWith(`t.raw ->> 'unattributed' = 'true'`);
    expect(qb.andWhere).toHaveBeenCalledWith('t.chain = :chain', { chain: 'SOL' });
    expect(res[0]).toMatchObject({ txid: 'sigA', memo: null });
    expect(res[0]).not.toHaveProperty('raw'); // provider blobs stay off the wire
  });
});

describe('TransactionsService.toView', () => {
  const service = new TransactionsService(
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    { get: jest.fn().mockReturnValue({}) } as any,
    {} as any,
    {} as any,
  );

  it('strips raw, idempotencyKey and the wallet object — flattens externalUserId', () => {
    const view = service.toView({
      id: 'tx-1', direction: 'outbound', chain: 'TRON', asset: 'TRX',
      txid: 'abc', address: 'TQpe', amount: '5', fee: '1',
      status: 'pending', confirmations: 0, requiredConfirmations: 19,
      blockNumber: null, reference: 'ref-1', idempotencyKey: 'legacy-x',
      raw: { kmsRequestId: 'secret-internal' },
      wallet: { externalUserId: 'user_1001' },
      createdAt: new Date(0), updatedAt: new Date(0),
    } as any);

    expect(view.externalUserId).toBe('user_1001');
    expect(view).not.toHaveProperty('raw');
    expect(view).not.toHaveProperty('idempotencyKey');
    expect(view).not.toHaveProperty('wallet');
    expect(view.reference).toBe('ref-1');
  });

  it('externalUserId is explicit null when the tx has no wallet (unattributed)', () => {
    const view = service.toView({ id: 't', wallet: null } as any);
    expect(view.externalUserId).toBeNull();
  });
});
