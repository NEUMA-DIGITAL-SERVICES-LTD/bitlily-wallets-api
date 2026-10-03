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
    it('rejects SPL balance lookups loudly — Tatum cannot read them', async () => {
      const p = makeProvider({ get: jest.fn() });
      await expect(p.getAddressBalance('addr', USDC_SOL)).rejects.toThrow(
        /SPL balances/,
      );
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

    it('refuses KMS send without signatureId — no env-key fallback', async () => {
      const p = makeProvider({ post: jest.fn() });
      await expect(
        p.sendTransaction(sendParams(SOL_ASSET, { signatureId: undefined })),
      ).rejects.toThrow(/never enrolled in KMS/);
    });
  });
});
