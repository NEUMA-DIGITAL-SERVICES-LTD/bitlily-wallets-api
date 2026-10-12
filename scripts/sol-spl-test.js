// Devnet SPL-token transfer test — raw ATA create + Token transfer, optionally
// with a Memo instruction. No @solana/web3.js.
// Usage:
//   node scripts/sol-spl-test.js <mode> <args...>
// Modes:
//   fund  <mint> <dstOwner> <srcAta> <amount-raw>          — custody-funded ATA create + transfer (signer = SOL_FROM_KEY, pays rent)
//   send  <mint> <dstAta> <srcAta> <ownerBase58> <amount-raw> [memo] — token transfer signed by owner key (SOL_FROM_KEY)
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const RENT = 'SysvarRent111111111111111111111111111111111';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58enc = (bytes) => {
  const digits = [0];
  for (const b of bytes) { let carry = b; for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = (carry / 58) | 0; } while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; } }
  let s = ''; for (const b of bytes) { if (b === 0) s += '1'; else break; }
  return s + digits.reverse().map((d) => B58[d]).join('');
};
const b58dec = (str) => {
  const bytes = [0];
  for (const ch of str) { let carry = B58.indexOf(ch); if (carry < 0) throw new Error(`bad base58 ${ch}`); for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; } while (carry) { bytes.push(carry & 0xff); carry >>= 8; } }
  let pad = 0; for (const ch of str) { if (ch === '1') pad++; else break; }
  const body = Buffer.from(bytes.reverse());
  let off = 0; while (off < body.length && body[off] === 0) off++;
  return Buffer.concat([Buffer.alloc(pad), body.subarray(off)]);
};
const cu16 = (n) => { const out = []; do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); };

// ed25519 curve params for the PDA off-curve check
const P = 2n ** 255n - 19n;
const mod = (x) => ((x % P) + P) % P;
const pow = (b, e) => { let r = 1n, x = mod(b); while (e) { if (e & 1n) r = mod(r * x); x = mod(x * x); e >>= 1n; } return r; };
const D = mod(-121665n * pow(121666n, P - 2n));
const le = (buf) => { let n = 0n; for (let i = buf.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(buf[i]); return n; };
const onCurve = (bytes) => {
  const yB = Buffer.from(bytes);
  yB[31] &= 0x7f;
  const y = le(yB);
  if (y >= P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const x2 = mod(u * pow(v, P - 2n));
  const r = pow(x2, (P - 1n) / 2n);
  return r === 1n || r === 0n; // residue or zero → on curve; P-1 (non-residue) → off
};
const findAta = (owner, mint) => {
  for (let bump = 255; bump >= 0; bump--) {
    const seed = Buffer.concat([b58dec(owner), b58dec(TOKEN), b58dec(mint), Buffer.from([bump]), b58dec(ATA), Buffer.from('ProgramDerivedAddress')]);
    const cand = crypto.createHash('sha256').update(seed).digest();
    if (!onCurve(cand)) return b58enc(cand);
  }
  throw new Error('no PDA');
};

const rpc = (method, params) => new Promise((resolve, reject) => {
  const req = https.request(RPC, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    let d = ''; res.on('data', (c) => (d += c));
    res.on('end', () => { const j = JSON.parse(d); j.error ? reject(new Error(`${method}: ${JSON.stringify(j.error)}`)) : resolve(j.result); });
  });
  req.on('error', reject);
  req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
});

const seedToKeypair = (b58Secret) => {
  const secret = b58dec(b58Secret);
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), secret.subarray(0, 32)]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const pubBytes = Buffer.from(crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32));
  return { privateKey, pubBytes };
};

const send = async (payerKey, accounts /* [{key,signer,writable}] */, ixns, memo) => {
  const { value: bh } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const progKeys = new Map();
  const ordered = [];
  const addKey = (k, signer, writable) => {
    const idx = ordered.findIndex((a) => a.key === k);
    if (idx >= 0) { ordered[idx].writable ||= writable; ordered[idx].signer ||= signer; return idx; }
    ordered.push({ key: k, signer, writable });
    return ordered.length - 1;
  };
  ixns.forEach((ix) => {
    ix.progIdx = addKey(ix.program, false, false);
    ix.acctIdx = ix.accts.map((a) => addKey(a.key, a.signer ?? false, a.writable ?? false));
  });
  if (memo) {
    const progIdx = addKey(MEMO, false, false);
    ixns.push({ program: MEMO, progIdx, accts: [], acctIdx: [], data: Buffer.from(memo, 'utf8') });
  }
  // order: signers(writable, then readonly) then non-signers(writable, readonly) — payer first
  ordered.sort((a, b) => (b.signer - a.signer) || (b.writable - a.writable));
  const payerIdx = ordered.findIndex((a) => a.key === payerKey);
  ordered.splice(payerIdx, 1);
  ordered.unshift({ key: payerKey, signer: true, writable: true });
  const idx = (k) => ordered.findIndex((a) => a.key === k);
  ixns.forEach((ix) => { ix.progIdx = idx(ix.program); ix.acctIdx = ix.accts.map((a) => idx(a.key)); });

  const nSigners = ordered.filter((a) => a.signer).length;
  const nSignedRO = ordered.filter((a) => a.signer && !a.writable).length;
  const nUnsignedRO = ordered.filter((a) => !a.signer && !a.writable).length;
  const msg = Buffer.concat([
    Buffer.from([nSigners, nSignedRO, nUnsignedRO]),
    cu16(ordered.length), ...ordered.map((a) => b58dec(a.key)),
    b58dec(bh.blockhash),
    cu16(ixns.length),
    ...ixns.map((ix) => Buffer.concat([
      Buffer.from([ix.progIdx]), cu16(ix.acctIdx.length), Buffer.from(ix.acctIdx),
      cu16(ix.data.length), ix.data,
    ])),
  ]);
  return { msg, nSigners };
};

async function main() {
  const [mode, ...a] = process.argv.slice(2);
  const secret = process.env.SOL_FROM_KEY ?? JSON.parse(fs.readFileSync('scripts/.sol-funder.json', 'utf8')).secret;
  const { privateKey, pubBytes } = seedToKeypair(secret);
  const signer = b58enc(pubBytes);

  if (mode === 'derive') { // <owner> <mint>
    console.log('ATA:', findAta(a[0], a[1]));
    return;
  }
  if (mode === 'fund') { // <mint> <dstOwner> <srcAta> <amountRaw>
    const [mint, dstOwner, srcAta, amt] = a;
    const dstAta = findAta(dstOwner, mint);
    console.log('creating ATA', dstAta, 'for', dstOwner);
    const amount = Buffer.alloc(9); amount[0] = 3; amount.writeBigUInt64LE(BigInt(amt), 1);
    const { msg } = await send(signer, [], [
      { program: ATA, accts: [
        { key: signer, signer: true, writable: true }, { key: dstAta, writable: true },
        { key: dstOwner }, { key: mint }, { key: SYSTEM }, { key: TOKEN },
      ], data: Buffer.alloc(0) },
      { program: TOKEN, accts: [
        { key: srcAta, writable: true }, { key: dstAta, writable: true }, { key: signer, signer: true },
      ], data: amount },
    ]);
    const sig = crypto.sign(null, msg, privateKey);
    const txid = await rpc('sendTransaction', [Buffer.concat([cu16(1), sig, msg]).toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
    console.log('funded:', txid);
    return;
  }
  if (mode === 'send') { // <srcAta> <dstAta> <amountRaw> [memo]
    const [srcAta, dstAta, amt, memo] = a;
    const amount = Buffer.alloc(9); amount[0] = 3; amount.writeBigUInt64LE(BigInt(amt), 1);
    const { msg } = await send(signer, [], [
      { program: TOKEN, accts: [
        { key: srcAta, writable: true }, { key: dstAta, writable: true }, { key: signer, signer: true },
      ], data: amount },
    ], memo);
    const sig = crypto.sign(null, msg, privateKey);
    const txid = await rpc('sendTransaction', [Buffer.concat([cu16(1), sig, msg]).toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
    console.log('sent:', txid, memo ? `(memo: "${memo}")` : '(NO memo)');
    return;
  }
  throw new Error('mode: derive | fund | send');
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
