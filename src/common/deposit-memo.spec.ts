import { newDepositMemo } from './deposit-memo';

/**
 * Deposit memos are the ONLY attribution channel for shared-custody
 * addresses — their format must stay typeable and their entropy high
 * enough that two wallets never collide before the DB index would matter.
 */
describe('newDepositMemo', () => {
  it('matches the documented client-facing format bl-xxxxxxxx', () => {
    for (let i = 0; i < 100; i++) {
      expect(newDepositMemo()).toMatch(/^bl-[a-z2-9]{8}$/);
    }
  });

  it('uses only the unambiguous alphabet (no 0/o, 1/l/i)', () => {
    for (let i = 0; i < 200; i++) {
      const code = newDepositMemo().slice(3); // after the bl- prefix
      expect(code).not.toMatch(/[01loi]/);
    }
  });

  it('stays short enough for exchange memo fields (< 32 chars)', () => {
    expect(newDepositMemo().length).toBeLessThanOrEqual(12);
  });

  it('generates distinct values (no trivial collisions)', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => newDepositMemo()));
    expect(seen.size).toBe(1000);
  });
});
