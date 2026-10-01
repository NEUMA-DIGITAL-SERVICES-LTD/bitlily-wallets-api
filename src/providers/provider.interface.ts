import { AssetDef, Chain } from '../config/assets';

/** Injection token — bind to TatumProvider now, swap for another later. */
export const BLOCKCHAIN_PROVIDER = Symbol('BLOCKCHAIN_PROVIDER');

export interface ChainAccountMaterial {
  /** The chain this material belongs to. */
  chain: Chain;
  /** xpub for HD chains; base address for account-model chains (SOL). */
  xpub?: string;
  baseAddress?: string;
  /** Opaque reference to signing material in KMS/secret store — never secrets. */
  secretRef?: string;
}

export interface ProviderTx {
  txid: string;
  chain: Chain;
  /** Outputs relevant to us: (address, amount) pairs in base units. */
  outputs: { address: string; amount: string }[];
  confirmations: number;
  blockNumber: number | null;
  fee?: string;
  status: 'pending' | 'confirmed' | 'failed';
  raw: Record<string, unknown>;
}

export interface FeeEstimate {
  asset: string;
  /** Estimated network fee in the chain's native asset, human units. */
  fee: string;
  /** slow | medium | fast if the provider supports tiers. */
  speed?: string;
}

export interface SendTxParams {
  asset: AssetDef;
  /** Internal account the funds are drawn from. */
  fromAccountId: string;
  toAddress: string;
  amount: string;
  /** Client reference echoed on the transaction record. */
  reference?: string;
}

export interface SendTxResult {
  txid: string;
}

export interface SubscriptionResult {
  subscriptionId: string;
}

/**
 * Provider-agnostic boundary between our service and the blockchain vendor.
 * The service NEVER calls Tatum (or any vendor) outside this interface.
 */
export interface BlockchainProvider {
  readonly name: string;

  /** Create chain-side account material (wallet / xpub) for custody. */
  createChainAccount(chain: Chain): Promise<ChainAccountMaterial>;

  /** Derive the deposit address for an account at a derivation index. */
  generateDepositAddress(
    account: ChainAccountMaterial,
    index: number,
  ): Promise<string>;

  /** On-chain balance of an address for an asset, in human units. */
  getAddressBalance(address: string, asset: AssetDef): Promise<string>;

  /** Fetch a transaction by hash — the verification step for webhooks. */
  getTransaction(txid: string, chain: Chain): Promise<ProviderTx | null>;

  estimateFee(asset: AssetDef, toAddress: string, amount: string): Promise<FeeEstimate>;

  /** Broadcast a signed withdrawal/send. */
  sendTransaction(params: SendTxParams): Promise<SendTxResult>;

  /** Register address monitoring (provider-side webhook subscription). */
  createAddressSubscription?(address: string, chain: Chain): Promise<SubscriptionResult>;

  /**
   * Recent transactions paying an address — used to attribute a detected
   * deposit to a txid when polling. May return [] on chains where the
   * provider lacks a cheap per-address history endpoint; callers must
   * tolerate missing attribution (synthetic keys still keep idempotency).
   */
  getAddressTransactions?(
    address: string,
    asset: AssetDef,
    limit?: number,
  ): Promise<ProviderTx[]>;
}
