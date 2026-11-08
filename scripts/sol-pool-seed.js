#!/usr/bin/env node
/**
 * Seeds the SOL unique-deposit address pool.
 *
 * Solana is ed25519 — no xpub derivation — and Tatum's managed SOL wallet is
 * a single private key: `getaddress {sigId} {anyIndex}` returns ONE address
 * forever (verified live). A unique SOL deposit address therefore means a
 * unique KMS signatureId — this script runs `generatemanagedwallet SOL` on
 * the KMS container once per address (key material never leaves KMS), then
 * bulk-imports the {signatureId, address} pairs via POST /admin/address-pool.
 *
 * Usage:
 *   API_URL=http://localhost:3100 API_KEY=ak_... ADMIN_KEY=... \
 *   node scripts/sol-pool-seed.js --count 100
 *
 * Options:
 *   --container bitlily-kms   KMS container name (default: bitlily-kms)
 *   --count 100               How many per-user keypairs to mint
 *   --dry-run                 Mint + print, do not import
 *
 * Each minted signatureId is a real keypair stored in the KMS wallet file —
 * even unassigned pool rows are recoverable, and the pool's audit trail is
 * `GET /admin/address-pool/stats` (free vs assigned).
 */
const { execFileSync } = require('child_process');
const { createHash } = require('crypto');

// Client-side hashing: headers carry the sha256 digest of each env key —
// env vars hold the RAW keys; the digest is what the API accepts.
const digest = (s) => createHash('sha256').update(s).digest('hex');

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) =>
    a.startsWith('--') ? [[a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]] : [],
  ),
);

const API_URL = process.env.API_URL ?? 'http://localhost:3100';
const API_KEY = process.env.API_KEY ?? '';
const ADMIN_KEY = process.env.ADMIN_KEY ?? '';
const CONTAINER = args.container ?? 'bitlily-kms';
const COUNT = parseInt(args.count ?? '100', 10);
const DRY = args['dry-run'] === true || args['dry-run'] === 'true';

if (!API_KEY || !ADMIN_KEY) {
  console.error('API_KEY and ADMIN_KEY env vars are required.');
  process.exit(1);
}

const headers = {
  'X-API-Key': digest(API_KEY),
  'X-Admin-Key': digest(ADMIN_KEY),
  'Content-Type': 'application/json',
};

function mintWallet() {
  const out = execFileSync(
    'docker',
    ['exec', CONTAINER, 'node', '/opt/app/dist/index.js', 'generatemanagedwallet', 'SOL'],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] ?? out);
  if (!parsed.address || !parsed.signatureId) {
    throw new Error(`generatemanagedwallet SOL returned nothing usable: ${out}`);
  }
  return { signatureId: parsed.signatureId, address: parsed.address };
}

(async () => {
  console.log(`Minting ${COUNT} SOL deposit keypairs in ${CONTAINER}…`);
  const entries = [];
  for (let i = 0; i < COUNT; i++) {
    entries.push(mintWallet());
    if ((i + 1) % 10 === 0) process.stdout.write(`  ${i + 1}/${COUNT}\r`);
  }
  console.log(`  ${entries.length}/${COUNT} minted`);

  if (DRY) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  const res = await fetch(`${API_URL}/api/v1/admin/address-pool`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ chain: 'SOL', entries }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`POST /admin/address-pool → ${res.status}: ${body}`);
  console.log('Imported:', body);
})().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
