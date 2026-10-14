import { LedgerService } from './ledger.service';
import { Transaction } from '../database/entities/transaction.entity';

/**
 * The ledger's hard invariant: no deposit_confirmed credit may post
 * under a synthetic poll:{addr}:{asset}:{balance} txid. Detection-path
 * placeholders are not on-chain proof — every credit must trace to a
 * real transaction. This is the structural backstop behind the
 * cross-path dedupe work (a synthetic credit is how the shasta double-
 * credit happened).
 */
describe('LedgerService synthetic-txid invariant', () => {
  const make = () => {
    const m = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((_e: any, o: any) => o),
      save: jest.fn(async (_e: any, o?: any) => o ?? _e),
    };
    const svc = new (LedgerService as any)({}, {});
    return { svc, m };
  };

  it('refuses deposit_confirmed credit on a poll:* txid', async () => {
    const { svc, m } = make();
    const tx = { id: 't1', txid: 'poll:addr1:TRX:5', asset: 'TRX' } as Transaction;
    await expect(
      svc.postEntry(m as any, { id: 'w1' } as any, tx, 'deposit_confirmed', '5', 'credit'),
    ).rejects.toThrow(/synthetic txid/);
    expect(m.save).not.toHaveBeenCalled();
  });

  it('refuses on poll:* even when the amount is valid', async () => {
    const { svc, m } = make();
    const tx = { id: 't2', txid: 'poll:X:USDT_TRON:1000', asset: 'USDT_TRON' } as Transaction;
    await expect(
      svc.postEntry(m as any, { id: 'w1' } as any, tx, 'deposit_confirmed', '1000', 'credit'),
    ).rejects.toThrow(/synthetic txid/);
  });

  it('allows a real txid through the same path', async () => {
    const { svc, m } = make();
    const tx = { id: 't3', txid: '48SHb2Zreal-txid', asset: 'SOL' } as Transaction;
    await svc.postEntry(m as any, { id: 'w1' } as any, tx, 'deposit_confirmed', '0.002', 'credit');
    expect(m.save).toHaveBeenCalled();
  });

  it('reversals of poll:* rows stay permitted — remediation must not deadlock', async () => {
    const { svc, m } = make();
    const tx = { id: 't4', txid: 'poll:addr:TRX:2001', asset: 'TRX' } as Transaction;
    await svc.postEntry(m as any, { id: 'w1' } as any, tx, 'deposit_reversal', '2000', 'debit');
    expect(m.save).toHaveBeenCalled();
  });
});
