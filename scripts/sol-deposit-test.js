// Devnet SOL send test: sign a raw legacy-format transfer locally, optionally
// with a Memo-program instruction. No @solana/web3.js — bs58 + node:crypto.
// Usage:
//   node scripts/sol-deposit-test.js <toBase58> <lamports> [memo] [--from-key <b58secret>]
// Env SOL_FROM_KEY (b58 64-byte secret) signs instead of an ephemeral airdropped key.
const crypto = require('crypto');
const https = require('https');

const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const SYSTEM = '11111111111111111111111111111111';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58enc = (bytes) => {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let s = '';
  for (const b of bytes) { if (b === 0) s += '1'; else break; }
  return s + digits.reverse().map((d) => B58[d]).join('');
};
const b58dec = (str) => {
  const bytes = [0];
  for (const ch of str) {
    let carry = B58.indexOf(ch);
    if (carry < 0) throw new Error(`bad base58 char ${ch}`);
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let pad = 0;
  for (const ch of str) { if (ch === '1') pad++; else break; }
  const body = Buffer.from(bytes.reverse());
  let off = 0;
  while (off < body.length && body[off] === 0) off++; // '111..' (all zeros) must not double-count the [0] digit
  return Buffer.concat([Buffer.alloc(pad), body.subarray(off)]);
};
const cu16 = (n) => {
  const out = [];
  do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
};
const rpc = (method, params) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const req = https.request(RPC, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => {
      const j = JSON.parse(d);
      j.error ? reject(new Error(`${method}: ${JSON.stringify(j.error)}`)) : resolve(j.result);
    });
  });
  req.on('error', reject);
  req.end(body);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// node ed25519 keys: spki DER pubkey = 12-byte header + 32 raw bytes;
// pkcs8 DER private = 16-byte header + 32-byte seed (signable KeyObject).
const seedToKeypair = (seed) => {
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), seed,
  ]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(privateKey);
  const pubBytes = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  return { privateKey, pubBytes };
};

async function main() {
  const args = process.argv.slice(2);
  const [to, lamportsStr] = args;
  const memo = args[2] && !args[2].startsWith('--') ? args[2] : undefined;
  if (!to || !lamportsStr) throw new Error('usage: sol-deposit-test.js <to> <lamports> [memo]');
  const lamports = BigInt(lamportsStr);

  let privateKey, pubBytes, from;
  if (process.env.SOL_FROM_KEY) {
    const secret = b58dec(process.env.SOL_FROM_KEY); // 64-byte secretKey = seed+pub
    ({ privateKey, pubBytes } = seedToKeypair(secret.subarray(0, 32)));
    // sanity: derived pubkey must match the secret's trailing 32 bytes
    if (!pubBytes.equals(secret.subarray(32))) throw new Error('secret/seed pubkey mismatch');
    from = b58enc(pubBytes);
    console.log('from (provided key):', from);
  } else {
    const kp = crypto.generateKeyPairSync('ed25519');
    privateKey = kp.privateKey;
    pubBytes = Buffer.from(kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
    from = b58enc(pubBytes);
    console.log('funder (ephemeral):', from);
    const drop = await rpc('requestAirdrop', [from, 1_000_000_000]);
    console.log('airdrop sig:', drop);
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const bal = await rpc('getBalance', [from]);
      if (bal?.value >= lamports + 10_000n) { console.log('funded:', bal.value); break; }
      if (i === 29) throw new Error('airdrop never landed');
    }
  }

  const { value: bh } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const toKey = b58dec(to);
  const sysKey = b58dec(SYSTEM);
  const keys = memo ? [pubBytes, toKey, sysKey, b58dec(MEMO)] : [pubBytes, toKey, sysKey];
  const transferData = Buffer.alloc(12);
  transferData.writeUInt32LE(2, 0);
  transferData.writeBigUInt64LE(lamports, 4);
  const ixns = [{ prog: 2, accts: [0, 1], data: transferData }];
  if (memo) ixns.push({ prog: 3, accts: [], data: Buffer.from(memo, 'utf8') });

  const header = Buffer.from([1, 0, keys.length - 2]);
  const msg = Buffer.concat([
    header, cu16(keys.length), ...keys,
    b58dec(bh.blockhash),
    cu16(ixns.length),
    ...ixns.map((ix) => Buffer.concat([
      Buffer.from([ix.prog]), cu16(ix.accts.length), Buffer.from(ix.accts),
      cu16(ix.data.length), ix.data,
    ])),
  ]);
  const sig = crypto.sign(null, msg, privateKey);
  const tx = Buffer.concat([cu16(1), sig, msg]);
  const txid = await rpc('sendTransaction', [tx.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  console.log('sent:', txid, memo ? `(memo: "${memo}")` : '(NO memo)');
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
