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

    it('reads SOL tx detail from the canonical RPC — Tatum never gets consulted', async () => {
      const get = jest.fn();
      const post = jest.fn().mockResolvedValue({ data: { result: solTx() } });
      const p = makeProvider({ get, post });
      const tx = await p.getTransaction('sig', 'SOL', SOL_ASSET);
      expect(post).toHaveBeenCalledWith('', expect.objectContaining({
        method: 'getTransaction',
        params: ['sig', expect.objectContaining({ encoding: 'json' })],
      }));
      expect(get).not.toHaveBeenCalled();
      expect(tx?.status).toBe('confirmed');
    });

    it('returns null when the canonical RPC reports the tx absent — null means truly gone (reorg reversal path)', async () => {
      const post = jest.fn().mockResolvedValue({ data: { result: null } });
      const p = makeProvider({ post });
      expect(await p.getTransaction('sig', 'SOL', SOL_ASSET)).toBeNull();
    });

    it('degrades to Tatum when the RPC transport fails', async () => {
      const post = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));
      const get = jest.fn().mockResolvedValue({ data: solTx() });
      const p = makeProvider({ get, post });
      const tx = await p.getTransaction('sig', 'SOL', SOL_ASSET);
      expect(get).toHaveBeenCalledWith('/v3/solana/transaction/sig');
      expect(tx?.status).toBe('confirmed');
    });

    it('still returns null for other chains on tx.not.found — no RPC fallback exists there', async () => {
      const notFound = { response: { status: 404, data: {} } };
      const get = jest.fn().mockRejectedValue(notFound);
      const post = jest.fn();
      const p = makeProvider({ get, post });
      expect(await p.getTransaction('txid', 'BTC', BTC_ASSET)).toBeNull();
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe('Solana memo extraction', () => {
    const MEMO_V2 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
    const MEMO_V1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';

    /** Minimal base58 encoder for fixture data (memo bytes → instruction data). */
    const b58 = (s: string): string => {
      const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      const bytes = Buffer.from(s, 'utf8');
      let n = BigInt('0x' + bytes.toString('hex'));
      let out = '';
      while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; }
      for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
      return out;
    };

    const solTxWithIx = (ix: any[], inner: any[] = []) => ({
      slot: 506849209,
      meta: { err: null, fee: 5000, innerInstructions: inner },
      transaction: {
        message: {
          accountKeys: ['from-addr', 'to-addr', MEMO_V2],
          instructions: ix,
        },
      },
    });

    it('decodes a base58 Memo-program instruction into tx.memo', async () => {
      const get = jest.fn().mockResolvedValue({
        data: solTxWithIx([{ programIdIndex: 2, data: b58('bl-abc12345'), accounts: [] }]),
      });
      const p = makeProvider({ get });
      const tx = await p.getTransaction('sig', 'SOL', SOL_ASSET);
      expect(tx?.memo).toBe('bl-abc12345');
    });

    it('accepts the jsonParsed wire shape — parsed string, direct programId', async () => {
      const get = jest.fn().mockResolvedValue({
        data: solTxWithIx([{ programId: MEMO_V2, parsed: 'bl-xyz98765' }]),
      });
      const p = makeProvider({ get });
      const tx = await p.getTransaction('sig', 'SOL', SOL_ASSET);
      expect(tx?.memo).toBe('bl-xyz98765');
    });

    it('finds memos in inner instructions and honors the v1 program id', async () => {
      const tx = solTxWithIx([
        { programIdIndex: 9, data: 'notamemo', accounts: [] }, // out-of-range program — skipped
      ], [
        { index: 0, instructions: [{ programId: MEMO_V1, parsed: 'bl-inner99' }] },
      ]);
      const get = jest.fn().mockResolvedValue({ data: tx });
      const p = makeProvider({ get });
      const res = await p.getTransaction('sig', 'SOL', SOL_ASSET);
      expect(res?.memo).toBe('bl-inner99');
    });

    it('ignores non-Memo-program instruction data — arbitrary tx text is not a memo', async () => {
      const get = jest.fn().mockResolvedValue({
        data: solTxWithIx([{ programIdIndex: 0, data: b58('bl-fake1234'), accounts: [] }]),
      });
      const p = makeProvider({ get });
      const tx = await p.getTransaction('sig', 'SOL', SOL_ASSET);
      expect(tx?.memo).toBeUndefined();
    });

    it('memo is undefined on plain transfers — absence is meaningful to attribution', async () => {
      const get = jest.fn().mockResolvedValue({ data: solTxWithIx([]) });
      const p = makeProvider({ get });
      const tx = await p.getTransaction('sig', 'SOL', SOL_ASSET);
      expect(tx?.memo).toBeUndefined();
    });
  });

  describe('Solana shared-address history', () => {
    it('discovers native signatures via getSignaturesForAddress (no Tatum SOL surface exists)', async () => {
      const post = jest.fn().mockResolvedValue({
        data: { result: [{ signature: 'sig1', slot: 100, err: null }] },
      });
      const p = makeProvider({ post });
      const txs = await p.getAddressTransactions('base-addr', SOL_ASSET, 25);
      expect(post).toHaveBeenCalledWith('', expect.objectContaining({
        method: 'getSignaturesForAddress',
        params: ['base-addr', { limit: 25 }],
      }));
      expect(txs[0]).toMatchObject({ txid: 'sig1', blockNumber: 100, status: 'confirmed' });
    });

    it('maps a failed signature to status failed — the caller never credits it', async () => {
      const post = jest.fn().mockResolvedValue({
        data: { result: [{ signature: 'sigX', slot: 100, err: { InstructionError: [] } }] },
      });
      const p = makeProvider({ post });
      const txs = await p.getAddressTransactions('base-addr', SOL_ASSET, 25);
      expect(txs[0].status).toBe('failed');
    });

    it('token scans resolve the owner\'s ATA by TOKEN PROGRAM + local mint filter — a non-mint server-side filter hard-errors on RPC', async () => {
      const post = jest.fn()
        .mockResolvedValueOnce({ data: { result: { value: [
          { pubkey: 'ATA-mine', account: { data: { parsed: { info: { mint: USDC_SOL.contract } } } } },
          { pubkey: 'ATA-other', account: { data: { parsed: { info: { mint: 'OtherMint1111111111111111111111111111' } } } } },
        ] } } })
        .mockResolvedValueOnce({ data: { result: [{ signature: 'sigT', slot: 55, err: null }] } });
      const p = makeProvider({ post });
      const txs = await p.getAddressTransactions('base-addr', USDC_SOL, 25);
      expect(post).toHaveBeenNthCalledWith(1, '', expect.objectContaining({
        method: 'getTokenAccountsByOwner',
        params: ['base-addr', { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }],
      }));
      expect(post).toHaveBeenNthCalledWith(2, '', expect.objectContaining({
        method: 'getSignaturesForAddress',
        params: ['ATA-mine', { limit: 25 }],
      }));
      expect(txs[0].txid).toBe('sigT');
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

  describe('UTXO balances', () => {
    it('incoming-outgoing is fixed-point — no IEEE-754 tail', async () => {
      // 0.00210056 - 0.00209444 in IEEE-754 is 6.120000000000083e-6;
      // a naive String() of that tail poisons the poller's delta math
      // into a phantom sub-satoshi deposit.
      const get = jest.fn().mockResolvedValue({
        data: { incoming: '0.00210056', outgoing: '0.00209444' },
      });
      const p = makeProvider({ get });
      const bal = await p.getAddressBalance('m-addr', {
        ...BTC_ASSET, chain: 'LTC', code: 'LTC',
      } as AssetDef);
      expect(get).toHaveBeenCalledWith('/v3/litecoin/address/balance/m-addr');
      expect(bal).toBe('0.00000612');
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

    it('floors a sub-protocol gasLimit — a 15000 estimate can never sign', async () => {
      const post = jest
        .fn()
        .mockResolvedValueOnce({ data: { gasPrice: '1000000000', gasLimit: '15000' } })
        .mockResolvedValueOnce({ data: { id: 'req-1' } });
      const p = makeProvider({ post });
      const ETH_ASSET: AssetDef = {
        code: 'ETH', chain: 'ETH', type: 'native', decimals: 18,
      } as AssetDef;
      await p.sendTransaction(sendParams(ETH_ASSET));
      const body = post.mock.calls[1][1];
      expect(body.fee.gasLimit).toBe('21000');
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

  describe('Address history — TRON (TronGrid) & EVM (etherscan-compat)', () => {
    // The delta poller must attribute real txids on every chain —
    // account-model history comes from indexers, not Tatum.
    const DEP = 'TQpeU63gg1SZgDnsVT47fuWJkBQESJynYZ';
    // 'TQpe…' hex form — the real deposit address's raw_data bytes.
    const DEP_HEX = '41a2eb66abc7955c3c4eb4c2d5fe6b6aa36cd339ef';
    const withHistory = (http: any) => {
      jest.spyOn(axios, 'create').mockReturnValue({
        ...http, interceptors: { response: { use: jest.fn() } },
      } as any);
      const config = {
        get: (k: string) =>
          k === 'tatum.network' ? 'testnet'
            : k === 'history.tronGridUrl' ? 'https://api.shasta.trongrid.io'
              : k === 'history.evm' ? {
                  ETH: { url: 'https://eth-sepolia.blockscout.com/api', apiKey: '' },
                  POLYGON: { url: 'https://api-amoy.polygonscan.com/api', apiKey: 'key1' },
                }
                : undefined,
      } as ConfigService;
      return new TatumProvider(config);
    };

    afterEach(() => jest.restoreAllMocks());

    it('TRON native: parses raw_data TransferContract, converts hex to_address, skips failures', async () => {
      const get = jest.spyOn(axios, 'get').mockResolvedValue({
        data: { data: [
          { txID: 'tx-good', blockNumber: 69221335,
            ret: [{ contractRet: 'SUCCESS' }],
            raw_data: { contract: [{ type: 'TransferContract',
              parameter: { value: { to_address: DEP_HEX, amount: 7000000 } } }] } },
          { txID: 'tx-fail', blockNumber: 69221336,
            ret: [{ contractRet: 'REVERT' }],
            raw_data: { contract: [{ type: 'TransferContract',
              parameter: { value: { to_address: DEP_HEX, amount: 5 } } }] } },
          { txID: 'tx-other-addr', blockNumber: 69221337,
            ret: [{ contractRet: 'SUCCESS' }],
            raw_data: { contract: [{ type: 'TransferContract',
              parameter: { value: { to_address: '410a4f01a059116134759cda43005b9e1573a82fa5', amount: 9 } } }] } },
        ] },
      });
      const p = withHistory({});
      const txs = await p.getAddressTransactions(DEP, TRX_ASSET, 5);

      expect(get).toHaveBeenCalledWith(
        expect.stringContaining('/v1/accounts/'),
        expect.objectContaining({ params: expect.objectContaining({ only_to: true, only_confirmed: true }) }),
      );
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        txid: 'tx-good', blockNumber: 69221335,
        outputs: [{ address: DEP, amount: '7' }],
      });
    });

    it('TRON TRC20: filters contract + Transfer type + to; resolves blockNumber per tx', async () => {
      const get = jest.spyOn(axios, 'get').mockResolvedValue({
        data: { data: [
          { transaction_id: 'tx-usdt', type: 'Transfer', to: DEP,
            value: '1000000000',
            token_info: { address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' } },
          { transaction_id: 'tx-wrong-contract', type: 'Transfer', to: DEP,
            value: '999',
            token_info: { address: 'TOTHERXXXXXXXXXXXXXXXXXXXXXXXXXX1' } },
        ] },
      });
      const post = jest.spyOn(axios, 'post').mockResolvedValue({
        data: { blockNumber: 69219265 },
      });
      const p = withHistory({});
      const txs = await p.getAddressTransactions(DEP, USDT_TRON, 5);

      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        txid: 'tx-usdt', blockNumber: 69219265,
        outputs: [{ address: DEP, amount: '1000' }],
      });
      // contract_address passed as query filter too (server-side)
      expect(get).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ params: expect.objectContaining({ contract_address: USDT_TRON.contract }) }),
      );
      expect(post).toHaveBeenCalledWith(
        expect.stringContaining('gettransactioninfobyid'),
        { value: 'tx-usdt' }, expect.anything(),
      );
    });

    it('TRON TRC20: info call failure leaves blockNumber null — poller keeps it pending', async () => {
      jest.spyOn(axios, 'get').mockResolvedValue({
        data: { data: [{ transaction_id: 'tx-usdt', type: 'Transfer', to: DEP,
          value: '1', token_info: { address: USDT_TRON.contract } }] },
      });
      jest.spyOn(axios, 'post').mockRejectedValue(new Error('timeout'));
      const p = withHistory({});
      const txs = await p.getAddressTransactions(DEP, USDT_TRON, 5);
      expect(txs[0].blockNumber).toBeNull();
    });

    it('EVM: etherscan-compat txlist filters to-address + failures', async () => {
      const get = jest.spyOn(axios, 'get').mockResolvedValue({
        data: { status: '1', result: [
          { hash: '0xdep', to: '0xC8319744bc1dc7216BE0CDFDF7d77Ac19C2D8CD6'.toLowerCase(),
            value: '1500000000000000000', blockNumber: '100', isError: '0' },
          { hash: '0xout', to: '0xother', value: '9', blockNumber: '99', isError: '0' },
          { hash: '0xerr', to: '0xc8319744bc1dc7216be0cdfdf7d77ac19c2d8cd6',
            value: '5', blockNumber: '98', isError: '1' },
        ] },
      });
      const ETH_ASSET: AssetDef = { code: 'ETH', chain: 'ETH', type: 'native', decimals: 18 } as AssetDef;
      const p = withHistory({});
      const txs = await p.getAddressTransactions('0xc8319744bc1dc7216be0cdfdf7d77ac19c2d8cd6', ETH_ASSET, 5);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        txid: '0xdep', blockNumber: 100,
        outputs: [{ amount: '1.5' }],
      });
      expect(get).toHaveBeenCalledWith(
        'https://eth-sepolia.blockscout.com/api',
        expect.objectContaining({ params: expect.objectContaining({ action: 'txlist', module: 'account' }) }),
      );
    });

    it('EVM token: tokentx filters contractAddress case-insensitively and uses tokenDecimal', async () => {
      jest.spyOn(axios, 'get').mockResolvedValue({
        data: { status: '1', result: [
          { hash: '0xusdc', to: '0xaddr', value: '2500000', blockNumber: '200',
            contractAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', tokenDecimal: '6' },
          { hash: '0xother', to: '0xaddr', value: '1', blockNumber: '199',
            contractAddress: '0xnotours', tokenDecimal: '6' },
        ] },
      });
      const USDC_ETH: AssetDef = {
        code: 'USDC_ETH', chain: 'ETH', type: 'token', decimals: 6,
        contract: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      } as AssetDef;
      const p = withHistory({});
      const txs = await p.getAddressTransactions('0xaddr', USDC_ETH, 5);
      expect(txs).toHaveLength(1);
      expect(txs[0].outputs[0].amount).toBe('2.5');
    });

    it('EVM: no explorer url configured → empty (history is optional, never fatal)', async () => {
      jest.spyOn(axios, 'create').mockReturnValue({ interceptors: { response: { use: jest.fn() } } } as any);
      const config = {
        get: (k: string) => k === 'tatum.network' ? 'testnet'
          : k === 'history.evm' ? { ETH: { url: '', apiKey: '' }, POLYGON: { url: '', apiKey: '' } }
            : undefined,
      } as ConfigService;
      const p = new TatumProvider(config);
      const POL: AssetDef = { code: 'POL', chain: 'POLYGON', type: 'native', decimals: 18 } as AssetDef;
      expect(await p.getAddressTransactions('0xaddr', POL, 5)).toEqual([]);
    });

    it('explorer failure → [] with a warn — poller stays unattributed, never crashes', async () => {
      jest.spyOn(axios, 'get').mockRejectedValue(new Error('ETIMEDOUT'));
      const p = withHistory({});
      expect(await p.getAddressTransactions(DEP, TRX_ASSET, 5)).toEqual([]);
    });
  });
});
