# Client Verification — End-to-End Sign-off Runbook

Run these in order against the staging environment. Everything below is
expected to pass; anything that doesn't is a finding, not a retry.

Base URL: `https://<staging-host>/api/v1` — all calls need header
`X-API-Key: <your tenant key>`.

The client-facing wallet surface is exactly **two** endpoints:

| Route | Purpose |
|---|---|
| `POST /wallets` | Get-or-create the user's wallet; `ensure` provisions permanent addresses in the same call |
| `GET /wallets/{id}` | Aggregate read — `?include=` folds in balances, addresses, transactions |

Everything else (per-address generation, balance/tx sub-resources,
re-watch) was deliberately folded in or moved to ops. A `404` on the old
sub-routes is expected.

## 1. Create a wallet + provision permanent addresses (one call)

```bash
curl -X POST $BASE/wallets -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"externalUserId":"verify-user-1","ensure":["TRX","BTC","USDT_TRON"]}'
```

Expected: `201` →

```json
{
  "id": "<walletId>",
  "externalUserId": "verify-user-1",
  "appId": "<your slug>",
  "addresses": [
    { "asset": "TRX",       "address": "T...",   "expiresAt": null },
    { "asset": "BTC",       "address": "tb1...", "expiresAt": null },
    { "asset": "USDT_TRON", "address": "T...",   "expiresAt": null }
  ]
}
```

- `ensure` creates a **permanent** address per chain — `expiresAt: null`.
- `USDT_TRON` reuses the `TRX` address (same-chain assets share one
  address — that is the exchange model, not a bug).
- Omit `ensure` to create the wallet with no addresses yet.

## 2. Idempotency + adding a chain later

```bash
# Repeat the exact call — same wallet, same addresses:
curl -X POST $BASE/wallets -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"externalUserId":"verify-user-1","ensure":["TRX","BTC","USDT_TRON"]}'

# First interaction on a NEW chain — same call, new ensure entry:
curl -X POST $BASE/wallets -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"externalUserId":"verify-user-1","ensure":["ETH"]}'
```

Expected: same `id` every time; existing addresses unchanged; the second
call appends a permanent `ETH` address (Bybit model — a chain's address
is minted once, on first use, and never expires).

## 3. Read the wallet aggregate

```bash
# Default view (balances + addresses):
curl $BASE/wallets/<walletId> -H "X-API-Key: $KEY"

# Fold in transactions (paginated):
curl "$BASE/wallets/<walletId>?include=balances,addresses,transactions&txLimit=50&txPage=1" \
  -H "X-API-Key: $KEY"
```

Expected: `include` controls which sections appear; sections not
requested stay out of the payload. `txLimit`≤100, `txPage` is 1-based.

## 4. Deposit → credit → webhook

Send a small amount of the asset to the address (any external wallet, or
ask ops to seed). Within ~2 poll cycles (≤ ~4 min):

```bash
curl "$BASE/wallets/<walletId>?include=balances,transactions" -H "X-API-Key: $KEY"
```

Expected: balance reflects the deposit; a `transactions` entry shows
`direction:"inbound"`, `status:"confirmed"`, real `txid`.

**Webhook**: your `webhookUrl` (set at app registration) receives POSTs:

```
POST <your webhookUrl>
X-Webhook-Signature: sha256=<hmac>
X-Webhook-Event-Id: <uuid>
{"event":"deposit.confirmed","data":{...transaction fields...}}
```

Verify: `sha256=` hex of `HMAC_SHA256(webhookSecret, raw body)` — reject
anything that doesn't match. Events are at-least-once — dedupe on
`X-Webhook-Event-Id` / `transactionId` (your endpoint must be idempotent).
If your endpoint is down, deliveries retry ~4h then dead-letter — nothing
is silently lost.

## 5. Withdrawal → broadcast → confirm

```bash
curl -X POST $BASE/transactions -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"walletId":"<walletId>","asset":"TRX","toAddress":"<dest>","amount":"1","reference":"verify-1"}'
```

Expected: `201` → `status:"pending"`. The KMS daemon signs within seconds;
status flips `pending → confirmed` as chain confirmations land
(`GET $BASE/transactions/<id>`). A `withdrawal.confirmed` webhook fires.

## 6. Tenant isolation

Ask ops for a wallet ID from a *different* tenant, then:

```bash
curl $BASE/wallets/<foreign-wallet-id> -H "X-API-Key: $KEY"
```

Expected: `404` — your key cannot see another app's data.

## 7. Registering additional apps

`POST /admin/clients` mints new tenant keys — it's **admin-gated**
(requires `X-Admin-Key`, held by platform ops). During staging, request new
apps through ops; at handover the admin key transfers to you and this is
self-serve:

```bash
curl -X POST $BASE/admin/clients \
  -H "X-API-Key: <ops key>" -H "X-Admin-Key: <admin>" \
  -H "Content-Type: application/json" \
  -d '{"slug":"newapp","webhookUrl":"https://app.io/hooks","scopes":["wallet"],"allowedIps":["203.0.113.0/24"]}'
```

Returns `apiKey` + `webhookSecret` **once** — store them immediately;
they're never shown again. `allowedIps` pins the key to your egress CIDRs
(a leaked key is dead off-network). `scopes:["read"]` makes a general-only
key (fees/health — cannot create wallets or move funds).

`PATCH /admin/clients/{slug}` — update webhookUrl/scopes/allowedIps,
`{"active":false}` suspends instantly, `{"rotate":true}` regenerates both
credentials (old ones die immediately).

## 8. Ops recovery (not part of your integration)

If a user pays an address after its watch window lapses, or sends the
wrong asset to a watched address, ops re-arms polling via
`POST /admin/wallets/<walletId>/watch` (admin-gated). This is operator
tooling — your app never calls it; raise it with ops when it happens.

## Known boundary — SOL deposits

SOL shares one custody base address across wallets, so per-user SOL
deposits **are not auto-credited** (deliberate — balance deltas can't be
attributed safely). Detected SOL inflows surface for manual/memo-based
crediting instead of guessing the owner. Use TRX/BTC/ETH/LTC/POLYGON or
EVM/TRON tokens for deposit verification.
