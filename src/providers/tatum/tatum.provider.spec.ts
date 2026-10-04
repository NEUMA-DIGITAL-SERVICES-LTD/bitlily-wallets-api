import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { TatumProvider } from './tatum.provider';
import { AssetDef } from '../../config/assets';

const SOL_ASSET: AssetDef = {
  code: 'SOL', chain: 'SOL', type: 'native', decimals: 9,
} as AssetDef;
const BTC_ASSET: AssetDef = {
  code: 'BTC', chain: 'BTC', type: 'native', decimals: 8,
} as AssetDef;
const USDC_SOL: AssetDef = {
  code: 'USDC_SOL', chain: 'SOL', type: 'token', decimals: 6,
  contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
} as AssetDef;
const TRX_ASSET: AssetDef = {
  code: 'TRX', chain: 'TRON', type: 'native', decimals: 6,
} as AssetDef;
const USDT_TRON: AssetDef = {
  code: 'USDT_TRON', chain: 'TRON', type: 'token', decimals: 6,
  contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
} as AssetDef;

function makeProvider(http: any, useKms = true) {
  jest.spyOn(axios, 'create').mockReturnValue({
    ...http,
    interceptors: { response: { use: jest.fn() } },
  } as any);
  const config = {
    get: (k: string) =>
      k === 'tatum.useKms' ? useKms
        : k === 'tatum.network' ? 'testnet'
          : undefined,
  } as ConfigService;
  return new TatumProvider(config);
}

const sendParams = (asset: AssetDef, over: any = {}) => ({
  asset,
  toAddress: 'dest',
  amount: '0.001',
  fromAccountId: 'acct-1',
  signatureId: 'sig-1',
  sourceAddress: 'treasury-addr',
  ...over,
});

describe('TatumProvider', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('Solana transaction normalization', () => {
    const solTx = (err: any = null) => ({
      slot: 506849209,
      blockTime: 1730000000,
      meta: { err, fee: 5000 },
      transaction: {
        message: {
          accountKeys: ['from-addr', 'to-addr'],
        },
      },
    });

    it('treats err:null + slot as finalized (32 confs)', async () => {
      const get = jest.fn().mockResolvedValue({ data: solTx() });
      const p = makeProvider({ get });
      const tx = await p.getTransaction('sig', 'SOL', SOL_ASSET);
      expect(tx?.confirmations).toBe(32);
      expect(tx?.status).toBe('confirmed');
      expect(tx?.fee).toBe('0.000005');
      expect(tx?.blockNumber).toBe(506849209);
    });

    it('marks err-txs failed with 0 confs', async () => {
      const get = jest.fn().mockResolvedValue({
        data: solTx({ InstructionError: [0, 'Custom'] }),
      });
      const p = makeProvider({ get });
      const tx = await p.getTransaction('sig', 'SOL', SOL_ASSET);
      expect(tx?.confirmations).toBe(0);
      expect(tx?.status).toBe('failed');
    });

    it('getLatestBlock returns 0 — no SOL height endpoint exists', async () => {
      const get = jest.fn();
      const p = makeProvider({ get });
      expect(await p.getLatestBlock('SOL')).toBe(0);
      expect(get).not.toHaveBeenCalled();
    });
  });

  describe('Solana balances', () => {
    it('reads SPL balances via the unified route in UI units — never fromRaw', async () => {
      const get = jest.fn().mockResolvedValue({ data: { balance: '20' } });
      const p = makeProvider({ get });
      const bal = await p.getAddressBalance('treasury', USDC_SOL);
      expect(get).toHaveBeenCalledWith(
        `/v3/blockchain/token/balance/SOL/${USDC_SOL.contract}/treasury`,
      );
      // 20 UI units must NOT become 0.00002 — SOL returns decimals,
      // unlike the EVM variant which returns raw base units.
      expect(bal).toBe('20');
    });
  });

  describe('Tron transaction normalization', () => {
    // Real shape returned by /v3/tron/transaction for a native send —
    // camelCase `rawData` (NOT `raw_data`), hex to_address + base58 fields.
    const tronNativeTx = {
      ret: [{ contractRet: 'SUCCESS' }],
      blockNumber: 68932899,
      rawData: {
        contract: [{
          type: 'TransferContract',
          parameter: {
            value: {
              owner_address: '410a4f01a059116134759cda43005b9e1573a82fa5',
              to_address: '4133f5877e95d90dfa374a672171add008c0f5a85c',
              amount: 5000000,
              ownerAddressBase58: 'TAuiQSBQWLRqEMW95W5aXZJZgAqBqYJD5U',
              toAddressBase58: 'TEhwbWrJqDYKKfRyWDgf86SPBBTJ9KbBEb',
            },
          },
        }],
      },
    };

    it('reads camelCase rawData and prefers *Base58 output fields', async () => {
      const get = jest.fn().mockResolvedValue({ data: tronNativeTx });
      const p = makeProvider({ get });
      const tx = await p.getTransaction('txid', 'TRON', TRX_ASSET);
      expect(tx?.outputs).toEqual([
        { address: 'TEhwbWrJqDYKKfRyWDgf86SPBBTJ9KbBEb', amount: '5' },
      ]);
      expect(tx?.status).toBe('confirmed');
    });

    it('token-scoped query on a native transfer yields NO outputs — a token watch row must not verify a TRX send', async () => {
      const get = jest.fn().mockResolvedValue({ data: tronNativeTx });
      const p = makeProvider({ get });
      const tx = await p.getTransaction('txid', 'TRON', USDT_TRON);
      expect(tx?.outputs).toEqual([]);
    });

    it('getLatestBlock uses /v3/tron/info — /current/block is a 404', async () => {
      const get = jest.fn().mockResolvedValue({ data: { blockNumber: 68932984 } });
      const p = makeProvider({ get });
      expect(await p.getLatestBlock('TRON')).toBe(68932984);
      expect(get).toHaveBeenCalledWith('/v3/tron/info');
    });
  });

  describe('KMS txid extraction', () => {
    it('unwraps JSON-stringified txId payloads (SOL KMS shape)', async () => {
      const get = jest.fn().mockResolvedValue({
        data: { status: 'PENDING', txId: '{"txId":"37qNqrReal"}' },
      });
      const p = makeProvider({ get });
      const r = await p.getPendingSignature('req-1');
      expect(r).toEqual({ status: 'signed', txid: '37qNqrReal' });
    });

    it('handles object-shaped txId', async () => {
      const get = jest.fn().mockResolvedValue({
        data: { txId: { txId: '0xabc' } },
      });
      const p = makeProvider({ get });
      const r = await p.getPendingSignature('req-1');
      expect(r?.txid).toBe('0xabc');
    });

    it('returns null on 404 — request vanished', async () => {
      const get = jest.fn().mockRejectedValue({ response: { status: 404 } });
      const p = makeProvider({ get });
      expect(await p.getPendingSignature('req-1')).toBeNull();
    });
  });

  describe('send bodies', () => {
    it('SOL send includes `from`, omits `currency`', async () => {
      const post = jest.fn().mockResolvedValue({ data: { id: 'req-1' } });
      const p = makeProvider({ post });
      await p.sendTransaction(sendParams(SOL_ASSET));
      const body = post.mock.calls[0][1];
      expect(body.from).toBe('treasury-addr');
      expect(body.currency).toBeUndefined();
      expect(body.signatureId).toBe('sig-1');
    });

    it('UTXO send pins fee + changeAddress — unspent input never becomes fee', async () => {
      const post = jest.fn().mockResolvedValue({ data: { id: 'req-1' } });
      const get = jest.fn().mockResolvedValue({ data: { medium: 10 } });
      const p = makeProvider({ post, get });
      await p.sendTransaction(
        sendParams(BTC_ASSET, { derivationIndex: 0, amount: '0.0002' }),
      );
      const body = post.mock.calls[0][1];
      expect(body.changeAddress).toBe('treasury-addr');
      expect(body.fee).toBeDefined();
      expect(Number(body.fee)).toBeGreaterThan(0);
      expect(body.fromAddress[0]).toMatchObject({
        address: 'treasury-addr',
        signatureId: 'sig-1',
        index: 0,
      });
    });

    it('maps POLYGON→MATIC in the token-send chain field', async () => {
      const post = jest
        .fn()
        .mockResolvedValueOnce({ data: { gasPrice: '1000000000', gasLimit: '65000' } })
        .mockResolvedValueOnce({ data: { id: 'req-1' } });
      const p = makeProvider({ post });
      const USDC_MATIC: AssetDef = {
        code: 'USDC_MATIC', chain: 'POLYGON', type: 'token', decimals: 6,
        contract: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
      } as AssetDef;
      await p.sendTransaction(sendParams(USDC_MATIC));
      const body = post.mock.calls[1][1];
      expect(post.mock.calls[1][0]).toBe('/v3/blockchain/token/transaction');
      expect(body.chain).toBe('MATIC');
      expect(body.contractAddress).toBe(USDC_MATIC.contract);
      expect(body.digits).toBe(6);
    });

    it('SPL send uses the unified token endpoint with a SOL body', async () => {
      const post = jest.fn().mockResolvedValue({ data: { id: 'req-1' } });
      const p = makeProvider({ post });
      await p.sendTransaction(sendParams(USDC_SOL, { amount: '1' }));
      const body = post.mock.calls[0][1];
      expect(post.mock.calls[0][0]).toBe('/v3/blockchain/token/transaction');
      expect(body).toMatchObject({
        chain: 'SOL',
        from: 'treasury-addr',
        to: 'dest',
        amount: '1',
        contractAddress: USDC_SOL.contract,
        digits: 6,
        signatureId: 'sig-1',
      });
    });

    it('refuses KMS send without signatureId — no env-key fallback', async () => {
      const p = makeProvider({ post: jest.fn() });
      await expect(
        p.sendTransaction(sendParams(SOL_ASSET, { signatureId: undefined })),
      ).rejects.toThrow(/never enrolled in KMS/);
    });
  });
});
