# Client Verification — End-to-End Sign-off Runbook

Run these in order against the staging environment. Everything below is
expected to pass; anything that doesn't is a finding, not a retry.

Base URL: `https://<staging-host>/api/v1` — all calls need header
`X-API-Key: <your tenant key>`.

## 1. Create a wallet (permanent, one per user)

```bash
curl -X POST $BASE/wallets -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"externalUserId":"verify-user-1"}'
```

Expected: `201` → `{ "id": "<walletId>", "appId": "<your slug>", ... }`.
Re-running with the same `externalUserId` returns the **same** wallet —
call it freely at signup; it's idempotent.

## 2. Permanent deposit address (exchange model)

```bash
curl -X POST $BASE/wallets/<walletId>/addresses \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"asset":"TRX","persistent":true}'
```

Expected: `{ "address": "T...", "expiresAt": null }`.

- Call it again → **identical** `address` and `id` (proves permanence).
- `{"asset":"USDT_TRON","persistent":true}` → **same** address (same chain).
- `{"asset":"TRX","persistent":true,"expiresInMinutes":30}` → `400` —
  permanent and expiring are contradictory.
- Omitting `persistent` → a temporary per-payment address with a TTL.

## 3. Deposit → credit → webhook

Send a small amount of the asset to the address (any external wallet, or
ask ops to seed). Within ~2 poll cycles (≤ ~4 min):

```bash
curl $BASE/wallets/<walletId> -H "X-API-Key: $KEY"
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

## 4. Withdrawal → broadcast → confirm

```bash
curl -X POST $BASE/transactions -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"walletId":"<walletId>","asset":"TRX","toAddress":"<dest>","amount":"1","reference":"verify-1"}'
```

Expected: `201` → `status:"pending"`. The KMS daemon signs within seconds;
status flips `pending → confirmed` as chain confirmations land
(`GET $BASE/transactions/<id>`). A `withdrawal.confirmed` webhook fires.

## 5. Tenant isolation

Ask ops for a wallet ID from a *different* tenant, then:

```bash
curl $BASE/wallets/<foreign-wallet-id> -H "X-API-Key: $KEY"
```

Expected: `404` — your key cannot see another app's data.

## 6. Registering additional apps

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

## Known boundary — SOL deposits

SOL shares one custody base address across wallets, so per-user SOL
deposits **are not auto-credited** (deliberate — balance deltas can't be
attributed safely). Detected SOL inflows surface for manual/memo-based
crediting instead of guessing the owner. Use TRX/BTC/ETH/LTC/POLYGON or
EVM/TRON tokens for deposit verification.
