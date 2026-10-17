#!/usr/bin/env node
/**
 * Seeds the SOL unique-deposit address pool.
 *
 * Solana is ed25519 — hardened-only derivation, no xpub — so unique deposit
 * addresses can only be derived where the key material lives: the KMS host.
 * The tatum-kms daemon has no derivation API, so this script shells
 * `getaddress {signatureId} {index}` inside the KMS container for a range,
 * then bulk-imports the (index → address) pairs via POST /admin/address-pool.
 *
 * Usage:
 *   API_URL=http://localhost:3100 API_KEY=ak_... ADMIN_KEY=... \
 *   node scripts/sol-pool-seed.js --start 1 --count 100
 *
 * Options:
 *   --container bitlily-kms   KMS container name (default: bitlily-kms)
 *   --signature-id <id>       Custody signatureId (default: fetched from
 *                             GET /admin/custody for chain SOL)
 *   --start 1                 First derivation index (0 = treasury — skipped)
 *   --count 100               How many addresses to derive
 *   --dry-run                 Derive + print, do not import
 *
 * Index 0 is the custody base/treasury address — the pool must never hand it
 * out, so --start is forced to >= 1. Indices 1+ are unused by the legacy
 * shared-address model, so the full range is safe.
 */
const { execFileSync } = require('child_process');

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) =>
    a.startsWith('--') ? [[a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]] : [],
  ),
);

const API_URL = process.env.API_URL ?? 'http://localhost:3100';
const API_KEY = process.env.API_KEY ?? '';
const ADMIN_KEY = process.env.ADMIN_KEY ?? '';
const CONTAINER = args.container ?? 'bitlily-kms';
const START = Math.max(parseInt(args.start ?? '1', 10), 1);
const COUNT = parseInt(args.count ?? '100', 10);
const DRY = args['dry-run'] === true || args['dry-run'] === 'true';

if (!API_KEY || !ADMIN_KEY) {
  console.error('API_KEY and ADMIN_KEY env vars are required.');
  process.exit(1);
}

const headers = {
  'X-API-Key': API_KEY,
  'X-Admin-Key': ADMIN_KEY,
  'Content-Type': 'application/json',
};

async function solSignatureId() {
  if (args['signature-id']) return args['signature-id'];
  const res = await fetch(`${API_URL}/api/v1/admin/custody`, { headers });
  if (!res.ok) throw new Error(`GET /admin/custody → ${res.status}: ${await res.text()}`);
  const row = (await res.json()).find((c) => c.chain === 'SOL');
  if (!row?.secretRef) throw new Error('No SOL custody row enrolled — POST /admin/custody first');
  return row.secretRef;
}

function getAddress(signatureId, index) {
  const out = execFileSync(
    'docker',
    ['exec', CONTAINER, 'node', '/opt/app/dist/index.js', 'getaddress', signatureId, String(index)],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] ?? out);
  if (!parsed.address) throw new Error(`No address in getaddress ${index} output: ${out}`);
  return parsed.address;
}

(async () => {
  const signatureId = await solSignatureId();
  console.log(`Deriving ${COUNT} SOL addresses from signatureId ${signatureId} (index ${START}..${START + COUNT - 1})`);

  const entries = [];
  for (let i = START; i < START + COUNT; i++) {
    entries.push({ derivationIndex: i, address: getAddress(signatureId, i) });
    if (entries.length % 10 === 0) process.stdout.write(`  ${entries.length}/${COUNT}\r`);
  }
  console.log(`  ${entries.length}/${COUNT} derived`);

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
