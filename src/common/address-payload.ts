import { createHash } from 'crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`invalid base58 character: ${c}`);
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let zeros = 0;
  for (const c of s) {
    if (c === '1') zeros++;
    else break;
  }
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, 'hex')]);
}

function sha256d(b: Buffer): Buffer {
  return createHash('sha256').update(createHash('sha256').update(b).digest()).digest();
}

/**
 * Reduces an address to its network-independent payload for custody
 * pair-proof comparison — "does the signatureId-derived index-0 address
 * equal the xpub-derived index-0 address?" The same key serializes
 * differently across networks (KMS `getaddress` always emits mainnet
 * forms: bc1…/L…; Tatum derives testnet forms: tb1…/m…), so string
 * equality is wrong — the payload hash is what's actually identical.
 *
 *  - bech32 (bc1/tb1/ltc1/tltc1): witness program = chars between the
 *    '1' separator and the 6-char checksum ('1' never appears in data).
 *  - base58check (BTC legacy, LTC, TRON): [version][20B hash][4B cksum]
 *    → trailing 20 bytes before the checksum, version length agnostic.
 *  - EVM 0x…: the 20-byte hash itself — lowercase.
 *  - SOL: raw base58 ed25519 pubkey, no version/checksum — decode as-is.
 * Returns null when the address can't be decoded.
 */
export function addressPayload(chain: string, address: string): string | null {
  try {
    const a = address.trim();
    if (a.startsWith('0x')) return a.toLowerCase();
    const sep = a.lastIndexOf('1');
    if (/^(bc|tb|ltc|tltc)/i.test(a) && sep > 0 && a.length - sep > 7) {
      return a.toLowerCase().slice(sep + 1, -6);
    }
    const raw = base58Decode(a);
    if (chain.toUpperCase() === 'SOL') return raw.toString('hex');
    // base58check: verify integrity, then the hash is the 20 bytes
    // before the 4-byte checksum regardless of version-byte width.
    if (raw.length < 25 || !sha256d(raw.subarray(0, -4)).subarray(0, 4).equals(raw.subarray(-4))) {
      return null;
    }
    return raw.subarray(-24, -4).toString('hex');
  } catch {
    return null;
  }
}
