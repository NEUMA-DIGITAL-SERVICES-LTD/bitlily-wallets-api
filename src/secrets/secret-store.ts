/**
 * Secret custody boundary. Wallet material (mnemonics, private keys) is
 * generated per chain at wallet creation and MUST be handed to a secret
 * store; only the returned opaque reference (e.g. a KMS signatureId) is
 * persisted on wallet_accounts.secret_ref.
 *
 * Implementations:
 * - EnvSecretStore — dev/testnet only; material is discarded, sends sign
 *   with TESTNET_PK_* env vars. Returns null (no ref).
 * - TatumKmsStore — production; enrolls material into the Tatum KMS daemon
 *   and returns its signatureId.
 */
export const SECRET_STORE = 'SECRET_STORE';

export interface SecretStore {
  readonly name: string;
  /** Enroll chain material; returns the opaque secret reference or null. */
  enroll(chain: string, material: { mnemonic?: string; privateKey?: string }): Promise<string | null>;
}
