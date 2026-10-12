import { randomInt } from 'crypto';

/**
 * Deposit memo for shared-custody addresses (SOL today; any account-model
 * chain without per-wallet derivation tomorrow). The Binance/Kraken
 * destination-tag model: one deposit address per chain, the sender writes
 * their wallet's memo into the transaction and the poller attributes by it.
 *
 * Format `bl-` + 8 chars from an unambiguous lowercase alphabet (no 0/o,
 * 1/l/i — humans transcribe these). ~6.5e11 combinations; the DB unique
 * index is the collision guard, generation retries are handled by callers.
 * 11 chars total — well under Solana's 566-byte memo limit and short enough
 * for exchange withdrawal forms.
 */
const MEMO_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function newDepositMemo(): string {
  let out = 'bl-';
  for (let i = 0; i < 8; i++) out += MEMO_ALPHABET[randomInt(MEMO_ALPHABET.length)];
  return out;
}
