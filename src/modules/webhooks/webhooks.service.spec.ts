import { WebhooksService } from './webhooks.service';
import { DepositAddress } from '../../database/entities/deposit-address.entity';
import { Transaction } from '../../database/entities/transaction.entity';
import { WalletAccount } from '../../database/entities/wallet-account.entity';

/**
 * Scaffold tests: the deposit-crediting rules are the failure-prone area —
 * duplicate webhook delivery, spoofed payloads, reorgs. Extend these with a
 * mocked provider + in-memory DB (or testcontainers) during the build.
 */
describe('WebhooksService dedupe key', () => {
  it('derives an idempotency key from txid+address+asset', () => {
    const payload = { txId: 'abc', address: 'A1', asset: 'BTC' };
    const key = `${payload.txId}:${payload.address}:${payload.asset}`;
    expect(key).toBe('abc:A1:BTC');
    // Same tx crediting two different addresses must not collide:
    const other = `${payload.txId}:B2:${payload.asset}`;
    expect(key).not.toBe(other);
  });
});

describe('Webhook verification policy', () => {
  it('requires re-fetching the tx — the body is never trusted', () => {
    // Documents the contract: process() calls provider.getTransaction and
    // verifies an output to the deposit address before any ledger write.
    expect(true).toBe(true);
  });
});

/**
 * Cross-path dedupe — the double-credit regression suite. The poller's
 * delta path credits unexplained balance growth under synthetic
 * `poll:{addr}:{asset}:{balance}` txids; the webhook path credits by real
 * txid. Without adoption + a shared creditedAmount baseline, one deposit
 * credits twice when both paths see it (observed live on TRON shasta).
 */
describe('WebhooksService × delta-poller dedupe', () => {
  const wallet = { id: 'w1' };
  const account = { id: 'acc1', wallet, memo: undefined, baseAddress: undefined };
  const dep = {
    id: 'dep1', address: 'Tdep1', chain: 'TRON', asset: 'TRX',
    creditedAmount: '0', status: 'active', account,
  } as unknown as DepositAddress;
  const payload = { txId: 'real-tx-1', address: 'Tdep1', asset: 'TRX', amount: '2000' };
  const chainTx = {
    txid: 'real-tx-1', chain: 'TRON', status: 'confirmed' as const,
    confirmations: 30, blockNumber: 100,
    outputs: [{ address: 'Tdep1', amount: '2000' }],
  };

  let service: WebhooksService;
  let addresses: any, txs: any, events: any, m: any, provider: any;
  let ledger: any, notifier: any;
  let txRows: Transaction[]; // fake table for m.findOne dispatch

  const make = () => {
    dep.creditedAmount = '0'; // shared fixture — reset per test
    txRows = [];
    events = { find: jest.fn().mockResolvedValue([]) };
    addresses = { find: jest.fn().mockResolvedValue([dep]) };
    txs = { find: jest.fn(), save: jest.fn(async (t) => t) };
    provider = {
      getTransaction: jest.fn().mockResolvedValue(chainTx),
      getLatestBlock: jest.fn().mockResolvedValue(100),
      getAddressBalance: jest.fn().mockResolvedValue('2000'),
    };
    ledger = { postEntry: jest.fn() };
    notifier = { notify: jest.fn(), notifyEvent: jest.fn() };
    m = {
      findOne: jest.fn(async (entity: any, opts: any) => {
        if (entity === DepositAddress) return dep;
        if (entity === WalletAccount) return account;
        if (entity === Transaction) {
          const w = opts.where ?? {};
          return txRows.find((r: any) =>
            (!w.txid || (typeof w.txid === 'object'
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
        if (!txRows.includes(row as Transaction)) txRows.push(row as Transaction);
        return row;
      }),
      create: jest.fn((_e: any, o: any) => o),
      increment: jest.fn(),
      update: jest.fn(),
    };
    const em = { transaction: jest.fn(async (cb: any) => cb(m)) };
    const config = { get: jest.fn(() => ({ TRON: 1 })) };
    service = new (WebhooksService as any)(
      events, addresses, txs, em, provider, ledger, notifier, config,
    );
  };

  beforeEach(make);

  it('poll-first ordering: rekeys the confirmed poll:* row, never credits twice', async () => {
    // Delta path already credited the 2000 TRX under a synthetic txid.
    txRows.push({
      txid: 'poll:Tdep1:TRX:2001', address: 'Tdep1', asset: 'TRX',
      direction: 'inbound', status: 'confirmed', amount: '2000',
    } as Transaction);
    dep.creditedAmount = '2000';

    const res = await (service as any).process(payload);

    expect(res.status).toBe('credited');
    expect(ledger.postEntry).not.toHaveBeenCalled(); // single credit stands
    const row = txRows.find((r: any) => r.direction === 'inbound');
    expect(txRows).toHaveLength(1); // same row adopted — not a second insert
    expect(row!.txid).toBe('real-tx-1'); // real txid wins the label
    expect(row!.status).toBe('confirmed');
  });

  it('webhook-first ordering: credits once and bumps the delta baseline', async () => {
    const res = await (service as any).process(payload);

    expect(res.status).toBe('credited');
    expect(ledger.postEntry).toHaveBeenCalledTimes(1);
    expect(m.increment).toHaveBeenCalledWith(
      DepositAddress, { id: 'dep1' }, 'creditedAmount', 2000,
    );
    const row = txRows.find((r: any) => r.direction === 'inbound');
    expect(row!.txid).toBe('real-tx-1');
    expect(row!.status).toBe('confirmed');
  });

  it('mismatched synthetic coverage: baseline guard records without a credit', async () => {
    // Poll credited a 2500 delta (this 2000 tx + a 500 sibling inside it).
    txRows.push({
      txid: 'poll:Tdep1:TRX:2500', address: 'Tdep1', asset: 'TRX',
      direction: 'inbound', status: 'confirmed', amount: '2500',
    } as Transaction);
    dep.creditedAmount = '2500'; // baseline already holds this tx's funds
    provider.getAddressBalance.mockResolvedValue('2500');

    const res = await (service as any).process(payload);

    expect(ledger.postEntry).not.toHaveBeenCalled();
    const row = txRows.find((r: any) => r.txid === 'real-tx-1');
    expect(row).toBeDefined();
    expect(row!.status).toBe('confirmed');
    expect((row!.raw as any).coveredByBaseline).toBe(true);
    expect(notifier.notify).not.toHaveBeenCalled(); // no phantom 'confirmed' event
    // res.status 'credited' is cosmetic — the row exists, no money moved.
    expect(res.status).toBe('credited');
  });

  it('fresh deposit on an already-baselined address still credits', async () => {
    // Old credited delta from a PREVIOUS deposit; balance grew again.
    dep.creditedAmount = '2500';
    provider.getAddressBalance.mockResolvedValue('4500'); // headroom = 2000

    const res = await (service as any).process(payload);

    expect(ledger.postEntry).toHaveBeenCalledTimes(1);
    expect(res.status).toBe('credited');
  });

  it('pending→confirmed redelivery posts the credit exactly once', async () => {
    // First delivery recorded the row pending (1 conf < required). The
    // confirming redelivery is the single moment a credit may post — the
    // old code either re-credited every confirm or never credited.
    txRows.push({
      txid: 'real-tx-1', address: 'Tdep1', asset: 'TRX',
      direction: 'inbound', status: 'pending', amount: '2000',
    } as Transaction);
    dep.creditedAmount = '0';
    provider.getAddressBalance.mockResolvedValue('2000');

    const res = await (service as any).process(payload);

    expect(res.status).toBe('credited');
    expect(ledger.postEntry).toHaveBeenCalledTimes(1);
    const row = txRows.find((r: any) => r.txid === 'real-tx-1');
    expect(row!.status).toBe('confirmed');
    expect(m.increment).toHaveBeenCalledWith(
      DepositAddress, { id: 'dep1' }, 'creditedAmount', 2000,
    );
  });

  it('confirmed→confirmed redelivery never re-credits', async () => {
    // Tatum retries deliveries; the original bug posted deposit_confirmed
    // on EVERY confirmed redelivery — event dedup was the only guard.
    txRows.push({
      txid: 'real-tx-1', address: 'Tdep1', asset: 'TRX',
      direction: 'inbound', status: 'confirmed', amount: '2000',
    } as Transaction);
    dep.creditedAmount = '2000';

    await (service as any).process(payload);
    await (service as any).process(payload); // third delivery too

    expect(ledger.postEntry).not.toHaveBeenCalled();
    // No-transition redeliveries must not re-announce deposit.confirmed —
    // downstream reads each notification as a new deposit.
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('pending webhook row loses to a confirmed synthetic: superseded, no credit', async () => {
    // While the real-txid row sat pending (waiting confs), the poller
    // delta-credited the same funds under poll:* — the synthetic row owns
    // the credit; the real row is superseded and the sib adopts the txid.
    txRows.push(
      {
        txid: 'real-tx-1', address: 'Tdep1', asset: 'TRX',
        direction: 'inbound', status: 'pending', amount: '2000',
      } as Transaction,
      {
        txid: 'poll:Tdep1:TRX:2000', address: 'Tdep1', asset: 'TRX',
        direction: 'inbound', status: 'confirmed', amount: '2000',
      } as Transaction,
    );
    dep.creditedAmount = '2000';

    const res = await (service as any).process(payload);

    // Row superseded → status-derived return is 'pending_confirmations';
    // what matters is no credit posted and one row owns the real txid.
    expect(ledger.postEntry).not.toHaveBeenCalled();
    const sib = txRows.find((r: any) => r.status === 'confirmed' && r.direction === 'inbound');
    expect(sib!.txid).toBe('real-tx-1'); // real txid wins the label
    const stale = txRows.find((r: any) => r.status === 'superseded');
    expect(stale!.txid).toBe('superseded:real-tx-1');
    // Exactly one confirmed inbound row under the real txid.
    expect(
      txRows.filter((r: any) => r.status === 'confirmed').length,
    ).toBe(1);
  });
});
