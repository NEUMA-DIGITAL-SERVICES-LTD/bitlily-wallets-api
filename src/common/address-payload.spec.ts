import { addressPayload } from './address-payload';

/**
 * Pair-proof normalization — KMS `getaddress` emits mainnet-serialized
 * forms while Tatum derives testnet forms. The payload hash must match
 * across encodings; these vectors are REAL outputs captured live from
 * the enrolled testnet custody wallets.
 */
describe('addressPayload', () => {
  it('bech32: bc1 (KMS mainnet) and tb1 (Tatum testnet) share one witness program', () => {
    const kms = addressPayload('BTC', 'bc1qp5dqw5rdp97eayskk3a93jjxmyqqm73z0qdh75');
    const tatum = addressPayload('BTC', 'tb1qp5dqw5rdp97eayskk3a93jjxmyqqm73z9xky98');
    // 'q' is the witness-version char — kept intentionally, identical
    // across networks so the compare still holds.
    expect(kms).toBe('qp5dqw5rdp97eayskk3a93jjxmyqqm73z');
    expect(kms).toBe(tatum);
  });

  it('base58check: L (LTC mainnet) and m (LTC testnet) share one hash160', () => {
    const kms = addressPayload('LTC', 'Lae7aRxckKZMwASdfEN9TnC1UfT2i1sPA8');
    const tatum = addressPayload('LTC', 'mvw7cGjmUgkZTUE6CfME1gLa8SgTXnyxEr');
    expect(kms).toBe('a91ba515c5e796cbfb5b10deecc7e284838b9399');
    expect(kms).toBe(tatum);
  });

  it('TRON T-address extracts the embedded 20-byte hash', () => {
    expect(addressPayload('TRON', 'TAuiQSBQWLRqEMW95W5aXZJZgAqBqYJD5U'))
      .toBe('0a4f01a059116134759cda43005b9e1573a82fa5');
  });

  it('EVM: 0x compare is case-insensitive', () => {
    expect(addressPayload('ETH', '0xC7765B4AF6173FF8452783A00D64D29FAB58B047'))
      .toBe('0xc7765b4af6173ff8452783a00d64d29fab58b047');
  });

  it('SOL: raw base58 pubkey passes through unchanged', () => {
    const a = addressPayload('SOL', '2V7Xt3ej4iLBXUpFNtF39Lesr3eajL8evfS5vuRUxZiX');
    const b = addressPayload('SOL', '2V7Xt3ej4iLBXUpFNtF39Lesr3eajL8evfS5vuRUxZiX');
    expect(a).toBe(b);
    expect(a).not.toBe(
      addressPayload('SOL', '4GfZJJj1FyG9G8zSK7d3ioZWsWNgMbdiQVVYc5q3TNLN'),
    );
  });

  it('different wallets never collide', () => {
    expect(
      addressPayload('SOL', '2V7Xt3ej4iLBXUpFNtF39Lesr3eajL8evfS5vuRUxZiX'),
    ).not.toBe(addressPayload('SOL', '4GfZJJj1FyG9G8zSK7d3ioZWsWNgMbdiQVVYc5q3TNLN'));
  });

  it('garbage decodes to null — pair proof fails closed', () => {
    expect(addressPayload('BTC', 'not-an-address')).toBeNull();
    expect(addressPayload('LTC', '!!!!')).toBeNull();
  });
});
