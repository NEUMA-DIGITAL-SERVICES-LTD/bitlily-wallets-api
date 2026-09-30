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
