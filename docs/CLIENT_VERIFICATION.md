# Client Verification — End-to-End Sign-off Runbook

Run these in order against the staging environment. Everything below is
expected to pass; anything that doesn't is a finding, not a retry.

Base URL: `https://<staging-host>/api/v1` — all calls need header
`X-API-Key: <your tenant key>`.

The client-facing wallet surface is exactly **two** routes, keyed by
**your** `externalUserId` — the service-generated `id` is internal and
never required:

| Route | Purpose |
|---|---|
| `POST /wallets` | Get-or-create the user's wallet AND provision permanent deposit addresses |
| `GET /wallets/{externalUserId}` | Aggregate read — `?include=` folds in balances, addresses, transactions |
| `GET /transactions` | App-wide tx feed — all your users' deposits + withdrawals, paginated + filterable |
| `GET /transactions/{id}` | Single transaction status |
| `POST /withdrawals` | Send from a user's wallet (`externalUserId` + unique `reference`) |
| `GET /fees/estimate` | Network-fee estimate for a send |

Everything else (per-address generation, balance/tx sub-resources,
re-watch, UUID/query lookups) was deliberately folded in or moved to
ops. A `404` on the old sub-routes is expected.

## 1. Create a wallet — all permanent addresses in one call

```bash
curl -X POST $BASE/wallets -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"externalUserId":"verify-user-1"}'
```

Expected: `201` → wallet + one permanent address **per HD chain**:

```json
{
  "id": "<walletId>",
  "externalUserId": "verify-user-1",
  "appId": "<your slug>",
  "addresses": [
    { "address": "T...",    "chain": "TRON",    "assets": ["TRX","USDT_TRON"],       "expiresAt": null },
    { "address": "tb1...",  "chain": "BTC",     "assets": ["BTC"],                   "expiresAt": null },
    { "address": "0x...",   "chain": "ETH",     "assets": ["ETH","USDT_ETH","USDC_ETH"], "expiresAt": null },
    { "address": "0x...",   "chain": "POLYGON", "assets": ["POL","USDT_MATIC","USDC_MATIC"], "expiresAt": null },
    { "address": "msS...",  "chain": "LTC",     "assets": ["LTC"],                   "expiresAt": null }
  ]
}
```

- Every address is **permanent** — `expiresAt: null`, reusable forever.
- One entry per *address*, not per asset — `assets` lists everything the
  address accepts (TRON covers TRX + USDT_TRON, ETH covers ETH + tokens).
- **SOL is deliberately not auto-provisioned**: it shares one custody
  address across wallets with no per-user attribution (see §Known
  boundary). Add it explicitly only if you handle its ops flow:
  `{"externalUserId":"…","ensure":["SOL"]}`.

## 2. Idempotency + selective provisioning + GET lookup

```bash
# Repeat the exact call — same wallet, same addresses:
curl -X POST $BASE/wallets -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"externalUserId":"verify-user-1"}'

# Provision just one chain (e.g. SOL opted-in later):
curl -X POST $BASE/wallets -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"externalUserId":"verify-user-1","ensure":["SOL"]}'

# Pure read by YOUR user id — never creates, 404 if absent:
curl "$BASE/wallets/verify-user-1" -H "X-API-Key: $KEY"
```

Expected: same `id` every time; `addresses` always returns the **full**
permanent set (existing + newly provisioned). If a new chain is enabled
later, an existing wallet's next `POST /wallets` mints its address then —
first touch on a new chain just works. The `id` field in responses is the
internal wallet UUID — keep it for support tickets if you like, but every
route addresses the wallet by `externalUserId`.

## 3. Read the wallet aggregate

```bash
# Default view (balances + addresses):
curl $BASE/wallets/verify-user-1 -H "X-API-Key: $KEY"

# Fold in transactions (paginated):
curl "$BASE/wallets/verify-user-1?include=balances,addresses,transactions&txLimit=50&txPage=1" \
  -H "X-API-Key: $KEY"

# Narrow transactions to a chain, asset, or your reference:
curl "$BASE/wallets/verify-user-1?include=transactions&chain=TRON" -H "X-API-Key: $KEY"
curl "$BASE/wallets/verify-user-1?include=transactions&asset=USDT_TRON" -H "X-API-Key: $KEY"
curl "$BASE/wallets/verify-user-1?include=transactions&reference=payout-42" -H "X-API-Key: $KEY"
```

Expected: `include` controls which sections appear; sections not
requested stay out of the payload. `txLimit`≤100, `txPage` is 1-based.
`chain=` returns that chain's native + token txs (TRON → TRX and
USDT_TRON); `asset=` is exact; `reference=` looks up your send/lookup
reference. Unknown chain/asset values return `400`. Without
filters the transactions section mixes all chains, newest first —
each entry carries `asset` and `chain`.

## 4. Deposit → credit → webhook

Send a small amount of the asset to the address (any external wallet, or
ask ops to seed). Within ~2 poll cycles (≤ ~4 min):

```bash
curl "$BASE/wallets/verify-user-1?include=balances,transactions" -H "X-API-Key: $KEY"
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
curl -X POST $BASE/withdrawals -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"externalUserId":"verify-user-1","asset":"TRX","toAddress":"<dest>","amount":"1","reference":"payout-42"}'
```

Expected: `201` → `status:"pending"`. The KMS daemon signs within seconds;
status flips `pending → confirmed` as chain confirmations land
(`GET $BASE/transactions/<id>` — the single retrieval endpoint; it serves
deposits AND withdrawals). A `withdrawal.confirmed` webhook fires.

**`reference` is strictly unique per send** — any reuse is an error:

- **Every** repeat of an existing reference returns `409` — even an
  identical retry. The error names the tx id + status so you can fetch
  it via `GET /transactions/<id>` or
  `GET /wallets/{externalUserId}?include=transactions&reference=<ref>`.
- Never infer a send succeeded from a network response alone — after a
  timeout, look up the reference first, then send with a **new**
  reference if nothing exists.
- Omit `reference` and every call sends fresh — **always send one in
  production**.

### Where the money actually lives (read once)

Balances are **not** read from the blockchain at withdrawal time. The
service keeps a double-entry ledger in PostgreSQL — one balance per
(wallet, asset):

1. Deposit lands on the user's address → poller detects it → confirms
   on-chain → **ledger credit** → `deposit.confirmed` webhook.
2. Withdrawal call → checks **ledger balance** for that asset →
   **ledger debit + transaction row in the same DB transaction** →
   KMS signs → broadcast → real txid recorded → confirmations tracked
   to `confirmed`.
3. Broadcast fails → debit is **reversed** and the tx marks `failed`
   (balance restored — verified in tests).
4. Chain balances are monitored for reconciliation, but the ledger is
   the **only** spend authorization source — a wallet cannot withdraw
   more than its confirmed ledger credits minus its debits.

## 6. App-wide transaction feed

One call returns deposits + withdrawals across **all your users** — the
support-dashboard / reconciliation / activity-feed endpoint:

```bash
# First page (defaults: page=1, limit=20, limit≤100):
curl "$BASE/transactions?page=1&limit=50" -H "X-API-Key: $KEY"

# Filtered — confirmed deposits for one user:
curl "$BASE/transactions?direction=inbound&status=confirmed&externalUserId=verify-user-1" \
  -H "X-API-Key: $KEY"
```

Response:

```json
{
  "data": [
    {
      "id": "a1b2…",
      "externalUserId": "verify-user-1",
      "direction": "inbound",
      "chain": "TRON",
      "asset": "TRX",
      "txid": "abc123…",
      "address": "T…",
      "amount": "5.000000000000000000",
      "status": "confirmed",
      "confirmations": 20,
      "requiredConfirmations": 1,
      "reference": null,
      "createdAt": "…",
      "updatedAt": "…"
    }
  ],
  "total": 137,
  "page": 1,
  "limit": 50
}
```

- **Your API key IS the tenant scope** — there is no `appId` parameter
  and never will be; the feed contains only your app's rows.
- Filters (all optional, combinable): `direction` (`inbound`/`outbound`),
  `status` (`pending`/`confirmed`/`failed`/`reorged`/`requires_approval`/
  `rejected`), `chain` (native + its tokens), `asset` (exact code),
  `externalUserId` (one user's history), `reference`, `txid`. Unknown
  `chain`/`asset` → `400`.
- Each row carries `externalUserId` so you can attribute transactions to
  your own users without a wallet join. Internal custody transfers
  (sweeps to treasury) are never included — this feed is user activity,
  not plumbing.
- `total` is the full filtered count; `page` is 1-based. Sort is newest
  first. For one user's history the `externalUserId` filter and the
  wallet aggregate (`?include=transactions`) return the same rows.

## 7. Tenant isolation

Ask ops for an `externalUserId` registered under a *different* tenant,
then:

```bash
curl $BASE/wallets/<foreign-externalUserId> -H "X-API-Key: $KEY"
```

Expected: `404` — your key cannot see another app's data, including its
external IDs. Same for `GET /transactions/<foreign-tx-id>` and a
`POST /withdrawals` naming another app's user. The `GET /transactions`
feed is equally scoped — nothing you pass (including any `appId`-looking
param) can widen it past your key's app.

## 8. Registering additional apps

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

## 9. Ops recovery (not part of your integration)

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
