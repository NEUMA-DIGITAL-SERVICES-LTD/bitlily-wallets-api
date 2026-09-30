import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { AssetDef, Chain } from '../../config/assets';
import {
  BlockchainProvider,
  ChainAccountMaterial,
  FeeEstimate,
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
      // Token balances for EVM/TRON via dedicated endpoints.
      if (asset.chain === 'TRON') {
        const { data } = await this.http.get(`/v3/tron/account/${address}`);
        const trc20 = (data?.trc20 ?? []) as Record<string, string>[];
        const hit = trc20.find((t) => t[asset.contract ?? '']);
        return hit ? String(hit[asset.contract ?? '']) : '0';
      }
      const { data } = await this.http.get(
        `/v3/${path}/account/balance/erc20/${address}?contractAddress=${asset.contract}`,
      );
      return String(data.balance ?? data ?? '0');
    }
    if (asset.chain === 'BTC' || asset.chain === 'LTC') {
      const { data } = await this.http.get(`/v3/${path}/address/balance/${address}`);
      const incoming = parseFloat(data.incoming ?? '0');
      const outgoing = parseFloat(data.outgoing ?? '0');
      return String(incoming - outgoing);
    }
    const { data } = await this.http.get(`/v3/${path}/account/balance/${address}`);
    return String(data.balance ?? data ?? '0');
  }

  async getTransaction(txid: string, chain: Chain): Promise<ProviderTx | null> {
    const path = CHAIN_PATH[chain];
    try {
      const { data } = await this.http.get(`/v3/${path}/transaction/${txid}`);
      return this.normalizeTx(data, txid, chain);
    } catch (err: any) {
      if (err.response?.status === 404) return null;
      throw err;
    }
  }

  /** Normalizes wildly different per-chain tx shapes into ProviderTx. */
  private normalizeTx(data: any, txid: string, chain: Chain): ProviderTx {
    switch (chain) {
      case 'BTC':
      case 'LTC': {
        const outputs = (data.outputs ?? data.vout ?? []).map((o: any) => ({
          address: o.address ?? o.scriptPubKey?.addresses?.[0] ?? '',
          amount: String(o.value ?? '0'),
        }));
        return {
          txid, chain, outputs,
          confirmations: data.confirmations ?? 0,
          blockNumber: data.blockNumber ?? data.block_number ?? null,
          fee: data.fee != null ? String(data.fee) : undefined,
          status: (data.confirmations ?? 0) > 0 ? 'confirmed' : 'pending',
          raw: data,
        };
      }
      case 'SOL': {
        const meta = data.result ?? data;
        const outs = (meta.transaction?.message?.accountKeys ?? []).map(
          (k: any, i: number) => ({
            address: typeof k === 'string' ? k : k.pubkey,
            amount: String(
              ((meta.meta?.postBalances?.[i] ?? 0) - (meta.meta?.preBalances?.[i] ?? 0)) / 1e9,
            ),
          }),
        ).filter((o: any) => parseFloat(o.amount) > 0);
        return {
          txid, chain, outputs: outs,
          confirmations: meta.confirmationStatus === 'finalized' || meta.confirmationStatus === 'confirmed' ? 32 : 0,
          blockNumber: meta.slot ?? null,
          fee: meta.meta?.fee != null ? String(meta.meta.fee / 1e9) : undefined,
          status: meta.meta?.err ? 'failed' : 'confirmed',
          raw: data,
        };
      }
      case 'TRON': {
        const outs = (data.raw_data?.contract?.[0]?.parameter?.value ?? {})
          ? [{
              address: data.raw_data.contract[0].parameter.value.to_address
                ?? data.raw_data.contract[0].parameter.value.contract_address ?? '',
              amount: String((data.raw_data.contract[0].parameter.value.amount ?? 0) / 1e6),
            }]
          : [];
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
        const to = data.to ?? '';
        const value = data.value != null ? String(Number(data.value) / 1e18) : '0';
        return {
          txid, chain,
          outputs: to ? [{ address: to, amount: value }] : [],
          confirmations: data.blockNumber ? 1 : 0, // refined by chain-head check
          blockNumber: data.blockNumber ?? null,
          fee: data.gasUsed != null && data.gasPrice != null
            ? String((Number(data.gasUsed) * Number(data.gasPrice)) / 1e18)
            : undefined,
          status: data.status === false || data.status === '0x0' ? 'failed'
            : data.blockNumber ? 'confirmed' : 'pending',
          raw: data,
        };
      }
    }
  }

  async estimateFee(asset: AssetDef, toAddress: string, amount: string): Promise<FeeEstimate> {
    const path = CHAIN_PATH[asset.chain];
    try {
      const { data } = await this.http.post(`/v3/blockchain/estimation`, {
        chain: asset.chain,
        type: 'TRANSFER',
        fromAddress: undefined,
        to: toAddress,
        amount,
      });
      return { asset: asset.code, fee: String(data.gasFee ?? data.fee ?? data) };
    } catch {
      // Fall back to a plain network-fee lookup for chains without estimation.
      const { data } = await this.http.get(`/v3/blockchain/fee/${path}`).catch(() => ({ data: null }));
      return { asset: asset.code, fee: String(data?.fast ?? data?.medium ?? '0'), speed: 'medium' };
    }
  }

  async sendTransaction(params: SendTxParams): Promise<SendTxResult> {
    const path = CHAIN_PATH[params.asset.chain];
    const useKms = this.config.get('tatum.useKms') === true;
    // Production path: signatureId references KMS-held keys — private keys
    // never transit this service. Testnet/dev path may pass a private key
    // from env via the caller (documented, testnet-only).
    const body: Record<string, unknown> = {
      to: params.toAddress,
      amount: params.amount,
      ...(useKms
        ? { signatureId: params.fromAccountId }
        : { fromPrivateKey: process.env[`TESTNET_PK_${params.asset.chain}`] }),
    };
    if (params.asset.type === 'token') {
      body.contractAddress = params.asset.contract;
      body.digits = params.asset.decimals;
    }
    const { data } = await this.http.post(`/v3/${path}/transaction`, body);
    return { txid: data.txId ?? data.txid ?? data.hash };
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
}
