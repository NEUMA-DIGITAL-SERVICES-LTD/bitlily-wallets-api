import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import axios, { AxiosInstance } from 'axios';
import { AssetDef, Chain } from '../../config/assets';
import { parseErc20Transfers } from './evm-logs';
import { errMsg } from '../../common/errors';
import {
  BlockchainProvider,
  ChainAccountMaterial,
  FeeEstimate,
  PendingSignatureStatus,
  ProviderTx,
  SendTxParams,
  SendTxResult,
  SubscriptionResult,
} from '../provider.interface';

/** Maps our canonical chain names to Tatum v3 endpoint path segments. */
const CHAIN_PATH: Record<Chain, string> = {
  BTC: 'bitcoin',
  LTC: 'litecoin',
  ETH: 'ethereum',
  POLYGON: 'polygon',
  SOL: 'solana',
  TRON: 'tron',
};

/** Chains whose wallets expose an xpub for address derivation. */
const HD_CHAINS: Chain[] = ['BTC', 'LTC', 'ETH', 'POLYGON', 'TRON'];

/**
 * Tatum's `currency` field for native sends — its enum doesn't always
 * match our asset codes (Polygon's is still MATIC, not POL).
 */
const TATUM_NATIVE_CURRENCY: Partial<Record<Chain, string>> = {
  POLYGON: 'MATIC',
};

/**
 * Tatum's API-wide chain enum for Polygon is MATIC — our internal code
 * is POLYGON. Query endpoints (fee, token/balance) reject anything else.
 */
const TATUM_CHAIN_CODE: Partial<Record<Chain, string>> = {
  POLYGON: 'MATIC',
};

/**
 * Convert raw token base units → decimal string using BigInt math.
 * Tatum token endpoints return smallest units ("20000000" = 20 USDC @ 6dp);
 * a value already containing '.' is assumed pre-normalized and passed
 * through (some TRON responses are decimal strings).
 */
function fromRaw(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) return raw;
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** hex (41-prefixed or 20-byte) → TRON base58check address. */
function tronBase58(hexAddr: string): string | null {
  try {
    const hex = hexAddr.startsWith('41') ? hexAddr : `41${hexAddr}`;
    const bytes = Buffer.from(hex, 'hex');
    if (bytes.length !== 21 || bytes[0] !== 0x41) return null;
    const checksum = createHash('sha256')
      .update(createHash('sha256').update(bytes).digest())
      .digest()
      .subarray(0, 4);
    const payload = Buffer.concat([bytes, checksum]);
    let n = BigInt('0x' + payload.toString('hex'));
    let out = '';
    while (n > 0n) {
      out = BASE58_ALPHABET[Number(n % 58n)] + out;
      n /= 58n;
    }
    for (const b of payload) {
      if (b === 0) out = '1' + out;
      else break;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Tatum adapter — the ONLY place Tatum's API surface is allowed to appear.
 * Everything upstream talks to BlockchainProvider; swapping vendors means
 * replacing this file, not touching business logic.
 */
@Injectable()
export class TatumProvider implements BlockchainProvider {
  readonly name = 'tatum';
  private readonly logger = new Logger(TatumProvider.name);
  private readonly http: AxiosInstance;
  private readonly network: 'testnet' | 'mainnet';

  constructor(private readonly config: ConfigService) {
    this.network = this.config.get('tatum.network') ?? 'testnet';
    this.http = axios.create({
      baseURL: this.config.get('tatum.baseUrl') ?? 'https://api.tatum.io',
      headers: { 'x-api-key': this.config.get('tatum.apiKey') ?? '' },
      timeout: 20_000,
    });
    this.http.interceptors.response.use(
      (r) => r,
      (err) => {
        const status = err.response?.status;
        const body = JSON.stringify(err.response?.data ?? {}).slice(0, 500);
        this.logger.error(`Tatum ${status} on ${err.config?.url}: ${body}`);
        throw err;
      },
    );
  }

  /**
   * Generates a fresh chain wallet (mnemonic + xpub) via Tatum.
   * The mnemonic returned here must be handed to the secret store (KMS/Vault)
   * and NEVER persisted by this service — we return only public material.
   */
  async createChainAccount(chain: Chain): Promise<ChainAccountMaterial & { mnemonic?: string }> {
    if (chain === 'SOL') {
      const { data } = await this.http.get(`/v3/${CHAIN_PATH.SOL}/wallet`);
      // SOL wallets yield a single address + private key, no xpub.
      return { chain, baseAddress: data.address, secretRef: data.privateKey ? 'kms:pending' : undefined, mnemonic: data.privateKey };
    }
    const { data } = await this.http.get(`/v3/${CHAIN_PATH[chain]}/wallet`);
    return { chain, xpub: data.xpub, secretRef: 'kms:pending', mnemonic: data.mnemonic };
  }

  async generateDepositAddress(
    account: ChainAccountMaterial,
    index: number,
  ): Promise<string> {
    if (account.baseAddress) return account.baseAddress; // SOL-style account model
    if (!account.xpub) throw new Error('Account has neither xpub nor baseAddress');
    // Tatum derives addresses from the xpub server-side:
    // /v3/{chain}/address/{xpub}/{index} — private keys never leave KMS.
    const { data } = await this.http.get(
      `/v3/${CHAIN_PATH[account.chain]}/address/${account.xpub}/${index}`,
    );
    return data.address;
  }

  async getAddressBalance(address: string, asset: AssetDef): Promise<string> {
    const path = CHAIN_PATH[asset.chain];
    if (asset.type === 'token') {
      // Token endpoints return RAW base units (e.g. 20 USDC → "20000000"
      // at 6 decimals) — normalize by 10^decimals or deposits credit 10^6x.
      if (asset.chain === 'TRON') {
        const { data } = await this.http.get(`/v3/tron/account/${address}`);
        const trc20 = (data?.trc20 ?? []) as Record<string, string>[];
        const hit = trc20.find((t) => t[asset.contract ?? '']);
        return hit ? fromRaw(String(hit[asset.contract ?? '']), asset.decimals) : '0';
      }
      if (asset.chain === 'SOL') {
        // SPL balances ride the same unified token route — but unlike EVM
        // it returns UI units already ("20" = 20 USDC), NOT base units.
        // Do not run fromRaw here or 20 USDC reads as 0.00002.
        const { data } = await this.http.get(
          `/v3/blockchain/token/balance/SOL/${asset.contract}/${address}`,
        );
        return String(data.balance ?? data ?? '0');
      }
      // Universal token-balance route — takes chain CODES (ETH, MATIC…),
      // not path names. The /v3/{chain}/account/balance/erc20/ variant
      // exists on ethereum but 404s on polygon (verified live).
      const { data } = await this.http.get(
        `/v3/blockchain/token/balance/${TATUM_CHAIN_CODE[asset.chain] ?? asset.chain}/${asset.contract}/${address}`,
      );
      return fromRaw(String(data.balance ?? data ?? '0'), asset.decimals);
    }
    if (asset.chain === 'BTC' || asset.chain === 'LTC') {
      const { data } = await this.http.get(`/v3/${path}/address/balance/${address}`);
      const incoming = parseFloat(data.incoming ?? '0');
      const outgoing = parseFloat(data.outgoing ?? '0');
      return String(incoming - outgoing);
    }
    if (asset.chain === 'TRON') {
      // TRON's native balance lives on the account object (sun units),
      // not the /account/balance path — that route 404s.
      const { data } = await this.http.get(`/v3/tron/account/${address}`);
      return String(Number(data.balance ?? 0) / 1e6);
    }
    const { data } = await this.http.get(`/v3/${path}/account/balance/${address}`);
    return String(data.balance ?? data ?? '0');
  }

  async getTransaction(txid: string, chain: Chain, asset?: AssetDef): Promise<ProviderTx | null> {
    const path = CHAIN_PATH[chain];
    try {
      const { data } = await this.http.get(`/v3/${path}/transaction/${txid}`);
      return this.normalizeTx(data, txid, chain, asset);
    } catch (err: any) {
      if (err.response?.status === 404) return null;
      throw err;
    }
  }

  /** Current chain height (block number / slot) per family. */
  async getLatestBlock(chain: Chain): Promise<number> {
    const path = CHAIN_PATH[chain];
    switch (chain) {
      case 'BTC':
      case 'LTC': {
        const { data } = await this.http.get(`/v3/${path}/info`);
        return Number(data.blocks ?? data.headers ?? 0);
      }
      case 'SOL': {
        // Tatum v3 exposes no SOL chain-height endpoint; normalizeTx reports
        // finalized (32) directly, so the sweeper's head-refinement is a no-op.
        return 0;
      }
      case 'TRON': {
        const { data } = await this.http.get(`/v3/${path}/current/block`);
        return Number(data.block_header?.raw_data?.number ?? data.blockNumber ?? 0);
      }
      default: {
        // EVM: block/current returns the latest block number
        const { data } = await this.http.get(`/v3/${path}/block/current`);
        return Number(data ?? 0);
      }
    }
  }

  /**
   * Normalizes wildly different per-chain tx shapes into ProviderTx.
   * `asset` scopes token-output extraction — for token assets, outputs come
   * from contract events, not native value fields.
   */
  private normalizeTx(data: any, txid: string, chain: Chain, asset?: AssetDef): ProviderTx {
    switch (chain) {
      case 'BTC':
      case 'LTC': {
        // Tatum returns outputs[].value in SATOSHIS (1000 = 0.00001 BTC).
        const outputs = (data.outputs ?? data.vout ?? []).map((o: any) => ({
          address: o.address ?? o.scriptPubKey?.addresses?.[0] ?? '',
          amount: fromRaw(String(o.value ?? '0'), 8),
        }));
        return {
          txid, chain, outputs,
          confirmations: data.confirmations ?? 0,
          blockNumber: data.blockNumber ?? data.block_number ?? null,
          fee: data.fee != null ? String(fromRaw(String(data.fee), 8)) : undefined,
          status: (data.confirmations ?? 0) > 0 ? 'confirmed' : 'pending',
          raw: data,
        };
      }
      case 'SOL': {
        const meta = data.result ?? data;
        let outs: { address: string; amount: string }[];
        if (asset?.type === 'token') {
          // SPL token transfers live in pre/postTokenBalances, not lamports.
          const keys = meta.transaction?.message?.accountKeys ?? [];
          const addrAt = (i: number) => {
            const k = keys[i];
            return typeof k === 'string' ? k : k?.pubkey ?? '';
          };
          const pre = new Map<number, number>();
          for (const b of meta.meta?.preTokenBalances ?? []) {
            if (b.mint === asset.contract) pre.set(b.accountIndex, Number(b.uiTokenAmount?.amount ?? 0) / 10 ** (b.uiTokenAmount?.decimals ?? asset.decimals));
          }
          outs = (meta.meta?.postTokenBalances ?? [])
            .filter((b: any) => b.mint === asset.contract)
            .map((b: any) => ({
              // The token-balance's OWNER is the depositable wallet;
              // accountIndex→accountKeys yields the token *account* address
              // (ATA), which never matches a watched wallet address.
              address: b.owner ?? addrAt(b.accountIndex),
              amount: String(
                Number(b.uiTokenAmount?.uiAmount ?? 0) - (pre.get(b.accountIndex) ?? 0),
              ),
            }))
            .filter((o: any) => parseFloat(o.amount) > 0);
        } else {
          outs = (meta.transaction?.message?.accountKeys ?? []).map(
            (k: any, i: number) => ({
              address: typeof k === 'string' ? k : k.pubkey,
              amount: String(
                ((meta.meta?.postBalances?.[i] ?? 0) - (meta.meta?.preBalances?.[i] ?? 0)) / 1e9,
              ),
            }),
          ).filter((o: any) => parseFloat(o.amount) > 0);
        }
        // Tatum's SOL surface is thin — no info/web3 endpoint exists, so
        // chain-tip confirmation counting isn't possible. Indexed txs are
        // already settled; err:null + slot ⇒ treated as finalized (32 confs).
        // Signature-status freshness is a documented gap.
        const solOk = !meta.meta?.err;
        return {
          txid, chain, outputs: outs,
          confirmations: solOk ? 32 : 0,
          blockNumber: meta.slot ?? null,
          fee: meta.meta?.fee != null ? String(meta.meta.fee / 1e9) : undefined,
          status: solOk ? 'confirmed' : 'failed',
          raw: data,
        };
      }
      case 'TRON': {
        // `?? {}` made the old ternary always-truthy — the unsafe branch
        // then dereferenced raw_data.contract on txs that lack raw_data.
        const contracts = data.raw_data?.contract ?? [];
        const v = contracts[0]?.parameter?.value;
        let outs: { address: string; amount: string }[] = [];
        if (asset?.type === 'token' && v?.data) {
          // TRC20 sends are TriggerSmartContract calls: to_address is the
          // CONTRACT, and the recipient/amount live in the ABI `data`
          // (a9059cbb + 32-byte addr + 32-byte amount, tron-hex = 41+20b).
          const call = String(v.data).replace(/^0x/, '');
          if (call.startsWith('a9059cbb') && call.length >= 136) {
            const toHex = call.slice(8 + 24, 8 + 64); // last 20B of the to-word
            const amount = BigInt('0x' + call.slice(72, 136));
            const to = tronBase58(toHex);
            outs = to
              ? [{ address: to, amount: fromRaw(amount.toString(), asset.decimals) }]
              : [];
          }
        } else if (v) {
          outs = [{
            address: v.to_address ?? v.contract_address ?? '',
            amount: String((v.amount ?? 0) / 1e6),
          }];
        }
        const conf = data.ret?.[0]?.contractRet === 'SUCCESS' ? 20 : 0;
        return {
          txid, chain, outputs: outs,
          confirmations: conf,
          blockNumber: data.blockNumber ?? null,
          status: conf > 0 ? 'confirmed' : 'pending',
          raw: data,
        };
      }
      default: {
        // EVM family: ETH / POLYGON
        const logs = data.logs ?? data.receipt?.logs ?? [];
        let outputs: { address: string; amount: string }[];
        if (asset?.type === 'token') {
          // Token deposits are contract events — tx.to is the token contract.
          outputs = parseErc20Transfers(logs, asset.decimals)
            .filter(
              (t) =>
                !asset.contract ||
                t.contract === asset.contract.toLowerCase(),
            )
            .map((t) => ({ address: t.to, amount: t.amount }));
        } else {
          const to = data.to ?? '';
          const value = data.value != null ? String(Number(data.value) / 1e18) : '0';
          outputs = to ? [{ address: to.toLowerCase(), amount: value }] : [];
        }
        // Confirmations are the mined flag here; callers refine via
        // getLatestBlock(chain) - blockNumber + 1.
        const mined = data.blockNumber != null && data.status !== false && data.status !== '0x0';
        return {
          txid, chain, outputs,
          confirmations: mined ? 1 : 0,
          blockNumber: data.blockNumber ?? null,
          fee: data.gasUsed != null && data.gasPrice != null
            ? String((Number(data.gasUsed) * Number(data.gasPrice)) / 1e18)
            : undefined,
          status: data.status === false || data.status === '0x0' ? 'failed'
            : mined ? 'confirmed' : 'pending',
          raw: data,
        };
      }
    }
  }

  async estimateFee(asset: AssetDef, toAddress: string, amount: string): Promise<FeeEstimate> {
    const path = CHAIN_PATH[asset.chain];
    try {
      const { data } = await this.http.post(`/v3/blockchain/estimation`, {
        chain: TATUM_CHAIN_CODE[asset.chain] ?? asset.chain,
        type: 'TRANSFER',
        fromAddress: undefined,
        to: toAddress,
        amount,
      });
      return { asset: asset.code, fee: String(data.gasFee ?? data.fee ?? data) };
    } catch {
      // Fall back to a plain network-fee lookup. This endpoint takes the
      // chain CODE (enum: ETH|BTC|LTC|DOGE), not the URL path — passing
      // 'litecoin' 400s, which silently zeroed fee estimates. UTXO chains
      // return sats/byte — convert to coin units over a ~226-byte tx or
      // callers subtract "10" as if it were a whole-coin fee.
      const { data } = await this.http.get(
        `/v3/blockchain/fee/${TATUM_CHAIN_CODE[asset.chain] ?? asset.chain}`,
      ).catch(() => ({ data: null }));
      const rate = Number(data?.fast ?? data?.medium ?? 0);
      const fee = (asset.chain === 'BTC' || asset.chain === 'LTC')
        ? String((rate * 226) / 1e8)
        : String(rate || '0');
      // A zero fee here means "unknown", not "free" — callers subtract it
      // from sweep amounts, so silence produces full-balance sends that
      // fail on-chain with insufficient-for-fee. Fail loudly instead.
      if (!rate || parseFloat(fee) <= 0) {
        throw new Error(
          `Fee estimation unavailable for ${asset.code} — refusing to guess`,
        );
      }
      return { asset: asset.code, fee, speed: 'medium' };
    }
  }

  async sendTransaction(params: SendTxParams): Promise<SendTxResult> {
    const path = CHAIN_PATH[params.asset.chain];
    const useKms = this.config.get('tatum.useKms') === true;
    // Under KMS the signatureId IS the custody reference enrolled at wallet
    // creation — absent means the account was created before KMS was wired
    // or enrollment failed. Fail loudly; never fall back to env keys here.
    if (useKms && !params.signatureId) {
      throw new Error(
        `No signatureId on account ${params.fromAccountId} — ` +
        `material was never enrolled in KMS.`,
      );
    }
    const signer = useKms
      ? { signatureId: params.signatureId, ...(params.derivationIndex != null ? { index: params.derivationIndex } : {}) }
      : { fromPrivateKey: process.env[`TESTNET_PK_${params.asset.chain}`] };
    // Production path: signatureId references KMS-held keys — private keys
    // never transit this service. Testnet/dev path may pass a private key
    // from env via the caller (documented, testnet-only).
    // EVM token sends go through the custom-token endpoint — the chain
    // transaction endpoint only accepts Tatum's enumerated currencies.
    const isEvm = params.asset.chain === 'ETH' || params.asset.chain === 'POLYGON';
    const isToken = params.asset.type === 'token';
    if (isEvm && isToken) {
      // EVM gas estimate + margin — Tatum's default estimate can lag baseFee.
      const fee = await this.estimateEvmFee(path, params);
      const tokenBody: Record<string, unknown> = {
        // Body fields take the chain CODE enum (ETH|MATIC|...), not our
        // canonical name — 'POLYGON' 400s the same way the query path did.
        chain: TATUM_CHAIN_CODE[params.asset.chain] ?? params.asset.chain,
        to: params.toAddress,
        amount: params.amount,
        contractAddress: params.asset.contract,
        digits: params.asset.decimals,
        ...signer,
        // This endpoint takes gasLimit/gasPrice flat — a nested `fee`
        // object is silently ignored and Tatum falls back to gasLimit
        // 21000, which fails ERC-20 transfers ("gasLimit too low").
        ...(fee ?? {}),
      };
      const { data } = await this.http.post('/v3/blockchain/token/transaction', tokenBody);
      return this.sendResult(data, useKms);
    }

    // UTXO chains (BTC/LTC) have a fundamentally different send schema:
    // inputs are explicit fromAddress/privateKey pairs and change must be
    // directed back to the sender. TESTNET_FROM_{chain} holds the address
    // matching TESTNET_PK_{chain}. Under KMS, signatureId replaces the key.
    if (params.asset.chain === 'BTC' || params.asset.chain === 'LTC') {
      // Under custody, UTXOs live at the treasury (index-0) address after
      // sweeps; env-mode falls back to the dev key's address.
      const fromAddr =
        params.sourceAddress ?? process.env[`TESTNET_FROM_${params.asset.chain}`];
      const pk = process.env[`TESTNET_PK_${params.asset.chain}`];
      if (!useKms && (!fromAddr || !pk)) {
        throw new Error(
          `UTXO send requires TESTNET_FROM_${params.asset.chain} + ` +
          `TESTNET_PK_${params.asset.chain} (or KMS)`,
        );
      }
      // Under KMS the signatureId alone identifies the signing key; the
      // address field still names the UTXO source, so it stays required.
      if (useKms && !fromAddr && params.derivationIndex == null) {
        throw new Error(`UTXO send under KMS requires a source address or derivation index`);
      }
      // Tatum requires `fee` + `changeAddress` together or neither — and
      // "neither" does NOT mean auto-change: the entire unspent input
      // becomes miner fee (verified live: a 0.0002 send burned 0.00105).
      // Always pin both; change returns to the UTXO source.
      const feeRate = await this.utxoFeeRate(params.asset.chain); // sats/byte
      const estSize = 148 + 34 * 2 + 10; // 1 input, recipient + change
      const feeSats = Math.max(Math.ceil(estSize * feeRate), 1000);
      const utxoBody = {
        fromAddress: [
          useKms
            ? { address: fromAddr, signatureId: params.signatureId, ...(params.derivationIndex != null ? { index: params.derivationIndex } : {}) }
            : { address: fromAddr, privateKey: pk },
        ],
        to: [{ address: params.toAddress, value: Number(params.amount) }],
        fee: String(feeSats / 1e8),
        changeAddress: fromAddr,
      };
      const { data } = await this.http.post(`/v3/${path}/transaction`, utxoBody);
      return this.sendResult(data, useKms);
    }

    // TRC20 sends use Tatum's dedicated trc20 endpoint — posting a token
    // transfer to /v3/tron/transaction would send native TRX instead.
    // SPL sends ride the unified token endpoint with a SOL-specific body:
    // {chain, from, to, amount, contractAddress, digits, signatureId}.
    // Verified live — the schema queued a real KMS request.
    if (params.asset.chain === 'SOL' && isToken) {
      const splBody = {
        chain: 'SOL',
        from: params.sourceAddress,
        to: params.toAddress,
        amount: params.amount,
        contractAddress: params.asset.contract,
        digits: params.asset.decimals,
        ...signer,
      };
      const { data } = await this.http.post('/v3/blockchain/token/transaction', splBody);
      return this.sendResult(data, useKms);
    }

    // KMS signs via signatureId; `from` names the treasury holding the
    // tokens. feeLimit is required by the schema (TRX, not sun).
    if (params.asset.chain === 'TRON' && isToken) {
      const trc20Body = {
        to: params.toAddress,
        amount: params.amount,
        tokenAddress: params.asset.contract,
        from: params.sourceAddress,
        feeLimit: 10,
        ...signer,
      };
      const { data } = await this.http.post(`/v3/tron/trc20/transaction`, trc20Body);
      return this.sendResult(data, useKms);
    }

    const body: Record<string, unknown> = {
      to: params.toAddress,
      amount: params.amount,
      // Tatum's send schema requires currency — the chain's NATIVE symbol
      // as Tatum names it, which is not always our asset code
      // (POL → MATIC). Verified live: 'POL' is rejected by the schema.
      currency: TATUM_NATIVE_CURRENCY[params.asset.chain] ?? params.asset.code,
      ...signer,
    };
    // Account-model chains name the sender explicitly (`from` = the address
    // holding the funds — custody base/treasury under KMS).
    if (params.asset.chain === 'SOL' || params.asset.chain === 'TRON') {
      body.from = params.sourceAddress;
      delete body.currency; // rejected by the SOL/TRON transaction schemas
    }
    if (isEvm) {
      const fee = await this.estimateEvmFee(path, params);
      if (fee) body.fee = fee;
    }
    const { data } = await this.http.post(`/v3/${path}/transaction`, body);
    return this.sendResult(data, useKms);
  }

  /**
   * Direct-key sends return a txid immediately; KMS sends return a pending
   * signature request id — the daemon signs+broadcasts asynchronously and
   * the txid arrives later via /v3/kms/{requestId}.
   */
  private sendResult(data: any, useKms: boolean): SendTxResult {
    const txid = TatumProvider.extractTxid(data);
    if (!useKms) return { txid };
    if (txid) return { txid, kmsRequestId: data.id };
    return { kmsRequestId: data?.id ?? data?.signatureId };
  }

  /**
   * Tatum returns txids in inconsistent shapes per chain — a plain string
   * (BTC), a {txId} object, or a stringified object (SOL KMS responses
   * arrive as "{\"txId\":\"...\"}"). Normalize all of them or the literal
   * JSON blob gets stored as the transaction's txid.
   */
  private static extractTxid(data: any): string | undefined {
    let v = data?.txId ?? data?.txid ?? data?.hash;
    if (typeof v === 'string' && v.trim().startsWith('{')) {
      try { v = JSON.parse(v); } catch { /* keep as-is */ }
    }
    if (v && typeof v === 'object') v = v.txId ?? v.txid ?? v.hash;
    return typeof v === 'string' && v ? v : undefined;
  }

  /** KMS pending-request status — the sweeper resolves txids through this. */
  async getPendingSignature(requestId: string): Promise<PendingSignatureStatus | null> {
    try {
      const { data } = await this.http.get(`/v3/kms/${requestId}`);
      const s = String(data?.status ?? '').toUpperCase();
      const txid = TatumProvider.extractTxid(data);
      if (txid || s === 'COMPLETED' || s === 'SUCCESS') {
        return { status: 'signed', txid };
      }
      if (s === 'PENDING' || s === 'PROCESSING' || s === '') {
        return { status: 'pending' };
      }
      return { status: 'failed' };
    } catch (err: any) {
      if (err.response?.status === 404) return null;
      throw err;
    }
  }

  /**
   * UTXO fee rate in sats/byte — Tatum's fee endpoint returns per-byte
   * recommendations; floor at 1 to never dust-fee a real send, and a
   * conservative 10 fallback if the endpoint is unreachable.
   */
  private async utxoFeeRate(chain: string): Promise<number> {
    try {
      // Endpoint takes chain code (BTC|LTC|DOGE|ETH), not path name.
      const { data } = await this.http.get(`/v3/blockchain/fee/${chain}`);
      const rate = Number(data?.medium ?? data?.fast ?? data?.slow ?? 0);
      return rate > 0 ? rate : 10;
    } catch {
      return 10;
    }
  }

  /**
   * EVM gas estimation. Tatum's per-tx /gas endpoint balance-checks `from`,
   * which fails for token sends when the caller doesn't know the signing
   * address — fall back to the chain fee schedule with a standard limit.
   * Returned gasPrice is converted wei→Gwei (schema units).
   */
  private async estimateEvmFee(
    path: string,
    params: SendTxParams,
  ): Promise<{ gasLimit: string; gasPrice: string } | null> {
    const defaultLimit = params.asset.type === 'token' ? '100000' : '21000';
    const toGwei = (wei: string) =>
      (((BigInt(wei) * 150n) / 100n + 999_999_999n) / 1_000_000_000n).toString();
    try {
      const { data } = await this.http.post(`/v3/${path}/gas`, {
        from: '0x0000000000000000000000000000000000000000',
        to: params.toAddress,
        amount: params.amount,
      });
      const wei = String(data?.gasPrice ?? '0');
      if (wei === '0') throw new Error('zero gasPrice');
      return { gasLimit: String(data.gasLimit ?? defaultLimit), gasPrice: toGwei(wei) };
    } catch (e) {
      try {
        const feeChain = TATUM_CHAIN_CODE[params.asset.chain] ?? params.asset.chain;
        const { data } = await this.http.get(`/v3/blockchain/fee/${feeChain}`);
        const wei = String(data?.fast ?? data?.medium ?? '0');
        if (wei === '0') return null;
        return { gasLimit: defaultLimit, gasPrice: toGwei(wei) };
      } catch (e2) {
        this.logger.warn(`EVM fee estimate failed, using Tatum default: ${errMsg(e2)}`);
        return null;
      }
    }
  }

  async createAddressSubscription(address: string, chain: Chain): Promise<SubscriptionResult> {
    const ingressUrl = process.env.WEBHOOK_INGRESS_URL;
    if (!ingressUrl) {
      this.logger.debug('WEBHOOK_INGRESS_URL unset — skipping address subscription');
      return { subscriptionId: '' };
    }
    const { data } = await this.http.post('/v4/subscription', {
      type: 'ADDRESS_EVENT',
      attr: {
        address,
        chain: chain.toUpperCase(),
        url: ingressUrl,
      },
    });
    return { subscriptionId: data.id ?? data.subscriptionId ?? '' };
  }

  /**
   * Per-address tx history — implemented for UTXO chains where Tatum offers
   * a direct endpoint. EVM/SOL/TRON return [] (their per-address history
   * needs indexer APIs that cost extra credits); deposit detection on those
   * chains relies on balance deltas, not tx enumeration.
   */
  async getAddressTransactions(
    address: string,
    asset: AssetDef,
    limit = 10,
  ): Promise<ProviderTx[]> {
    const path = CHAIN_PATH[asset.chain];
    if (asset.chain !== 'BTC' && asset.chain !== 'LTC') return [];
    try {
      const { data } = await this.http.get(
        `/v3/${path}/transaction/address/${address}?pageSize=${limit}`,
      );
      const list = Array.isArray(data) ? data : data?.txs ?? [];
      return list.map((t: any) =>
        this.normalizeTx(t, t.hash ?? t.txid ?? '', asset.chain),
      );
    } catch (err: any) {
      if (err.response?.status === 404) return [];
      throw err;
    }
  }
}
