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
  /** Secret material to enroll in the secret store — never persisted. */
  mnemonic?: string;
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
  /**
   * Sender-attached deposit memo (SOL Memo program instruction text).
   * Only set when the chain supports memos AND the tx carries one —
   * shared-custody attribution keys off this; absence is meaningful.
   */
  memo?: string;
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
  /** KMS signatureId for the account's enrolled material (required under KMS). */
  signatureId?: string | null;
  /**
   * HD derivation index of the deposit address being spent from — needed by
   * KMS-managed mnemonic wallets to sign a derived address (sweeps).
   */
  derivationIndex?: number | null;
  /** UTXO source address — treasury address under custody (funds sit there post-sweep). */
  sourceAddress?: string;
  toAddress: string;
  amount: string;
  /** Client reference echoed on the transaction record. */
  reference?: string;
}

export interface SendTxResult {
  /**
   * On-chain txid — known immediately for direct-key broadcasts. Absent
   * under KMS: signing is async (the daemon picks up the pending request),
   * so the request id is returned instead and resolved later.
   */
  txid?: string;
  /** KMS pending-signature request id — resolve via getPendingSignature. */
  kmsRequestId?: string;
}

export interface PendingSignatureStatus {
  /** e.g. PENDING | SUCCESS | REJECTED/FAILED — provider-normalized. */
  status: 'pending' | 'signed' | 'failed';
  /** Present once signed+broadcast. */
  txid?: string;
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

  /**
   * Fetch a transaction by hash — the verification step for webhooks.
   * `asset` scopes output extraction: for token assets, on-chain outputs are
   * parsed from contract Transfer events (tx.to is the contract, not the
   * recipient).
   */
  getTransaction(txid: string, chain: Chain, asset?: AssetDef): Promise<ProviderTx | null>;

  /** Current chain tip — used to compute real confirmation counts. */
  getLatestBlock(chain: Chain): Promise<number>;

  /**
   * Network fee for a send. UTXO estimation needs the source address to
   * count inputs — callers must pass the spending address (deposit
   * address for sweeps, treasury for withdrawals). toAddress may be
   * omitted for a typical-transfer estimate (constant-fee chains) —
   * UTXO/EVM paths then fall back to rate × typical size rather than a
   * destination-priced quote.
   */
  estimateFee(
    asset: AssetDef,
    toAddress: string | undefined,
    amount: string,
    fromAddress?: string,
  ): Promise<FeeEstimate>;

  /** Broadcast a signed withdrawal/send. */
  sendTransaction(params: SendTxParams): Promise<SendTxResult>;

  /**
   * KMS-only: resolve a pending signature request to its eventual txid.
   * Used by the outbound sweeper to advance rows that entered KMS's
   * pending queue — null when the provider isn't KMS-backed.
   */
  getPendingSignature?(requestId: string): Promise<PendingSignatureStatus | null>;

  /** Register address monitoring (provider-side webhook subscription). */
  createAddressSubscription?(address: string, chain: Chain): Promise<SubscriptionResult>;

  /**
   * Enroll the API key for webhook HMAC — providers that support
   * payload signing only send the signature header after opt-in.
   * Idempotent; called at boot when a webhook secret is configured.
   */
  enableWebhookHmac?(hmacSecret: string): Promise<void>;

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
