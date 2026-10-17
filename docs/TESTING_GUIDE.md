# Bitlily Crypto Service — End-to-End Endpoint Testing Guide

A complete walkthrough of every API surface, in the order a real integration
would exercise them: auth → wallets → deposits → withdrawals → webhooks →
admin/ops. Each endpoint lists its parameters, what they're for, and what a
correct response looks like.

Everything below is runnable from **Swagger UI** at
`http://localhost:3100/docs` or with plain `curl` against
`http://localhost:3100`.

---

## 0. Authentication model

Every endpoint requires `X-API-Key`. Admin endpoints *additionally* require
`X-Admin-Key`. The API key resolves your **tenant** (`appId`) — every wallet,
transaction, and webhook is scoped to it. There is no way to touch another
tenant's data with your key.

| Header | Where the value lives | Scope |
|---|---|---|
| `X-API-Key` | `API_CLIENTS` in `.env` (env clients), or returned once by `POST /admin/clients` (db clients) | All routes. Determines `appId` and scopes. |
| `X-Admin-Key` | `ADMIN_API_KEYS` in `.env` | `/admin/*` and `/kms/*` routes only — ops tooling, never given to app users |

In Swagger: click **Authorize**, paste the tenant key into `x-api-key` and the
admin key into `x-admin-key`. Both stay set for the session.

**Scopes:** a key's `scopes` array gates what it may call. `["wallet"]` = full
tenant access; `["read"]` = read-only shared endpoints. Calls outside scope
return 403.

```bash
# Set these once in your shell — used in every curl below
API_KEY="ak_live_..."      # your tenant key
ADMIN_KEY="..."            # ops key (never client-facing)
BASE="http://localhost:3100/api/v1"
```

---

## 1. Health & readiness (no auth)

| Endpoint | Purpose | 200 means |
|---|---|---|
| `GET /api/v1/health` | Liveness — process is up | Service running |
| `GET /api/v1/ready` | Readiness — DB + provider reachable | Safe to send traffic |

```bash
curl $BASE/health   # {"status":"ok"}
curl $BASE/ready    # {"status":"ready"} — check this before any test run
```

If `/ready` fails, nothing below will work — check `docker compose ps`.

---

## 2. Wallets — provision a user

The wallet is the anchor for everything: balances, deposit addresses,
withdrawal attribution. **Create it before the user ever needs it** — even
fiat-only users need a wallet row before their first crypto withdrawal.

### `POST /api/v1/wallets` — get-or-create a wallet + addresses

| Param | Type | Required | What it's for |
|---|---|---|---|
| `externalUserId` | string (body) | **yes** | **Your** user id — the foreign key your backend uses everywhere else. Not an email, not a crypto id — your app's user identifier. |
| `ensure` | string[] (body) | no | Asset codes to provision deposit addresses for, e.g. `["TRX","USDT_TRON"]`. **Omit → provisions every supported chain at once.** Idempotent: repeat calls return the same addresses. Same-chain assets share one address. |

```bash
curl -X POST $BASE/wallets \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"externalUserId":"user_1001"}'
```

**Response** — the full permanent address set, one row per address:

```json
{
  "id": "4f8c...", "appId": "acme", "externalUserId": "user_1001",
  "addresses": [
    { "address": "tb1q...", "chain": "BTC",  "assets": ["BTC"] },
    { "address": "0x8f3...", "chain": "ETH",  "assets": ["ETH","USDT_ETH","USDC_ETH"] },
    { "address": "TQpe...",  "chain": "TRON", "assets": ["TRX","USDT_TRON"] },
    { "address": "9xQy...",  "chain": "SOL",
      "assets": ["SOL","USDC_SOL"],
      "memo": "bl-jw5pxfcb", "memoRequired": true }
  ]
}
```

**`memo` / `memoRequired`** — SOL uses a shared custody address; the memo is
the only thing that attributes a deposit to this wallet. Deposits without it
become *unattributed* (real funds, credited to no one — see §7). Surface this
in your UI: SOL deposits must carry the memo.

### `GET /api/v1/wallets/{externalUserId}` — wallet + balances + history

| Param | Where | What it's for |
|---|---|---|
| `externalUserId` | path | Your user id |
| `include` | query | Comma-separated sections: `balances,addresses,transactions`. Default `balances,addresses` |
| `txLimit` / `txPage` | query | Transactions page size (1–100, default 20) / page number |
| `chain`, `asset`, `reference` | query | Narrow the transactions section — `reference` is your check-before-retry lookup after a 409 or timeout |

```bash
curl "$BASE/wallets/user_1001?include=balances,addresses,transactions&chain=TRON" \
  -H "X-API-Key: $API_KEY"
```

`balances[].balance` is **ledger truth** — credits minus debits. It only moves
on *confirmed* deposits and posted withdrawal debits; pending deposits don't
count toward it.

---

## 3. Address validation & fee estimation — before the user sends

### `GET /api/v1/addresses/validate` — is this address well-formed?

| Param | Required | What it's for |
|---|---|---|
| `address` | **yes** | The address to check |
| `asset` | yes* | Asset code — `USDT_TRON` resolves to chain TRON. *Either `asset` or `chain` required |
| `chain` | yes* | Raw chain code — `BTC, LTC, ETH, POLYGON, SOL, TRON` |

```bash
curl "$BASE/addresses/validate?asset=USDT_TRON&address=TQpeU63gg..." \
  -H "X-API-Key: $API_KEY"
# → {"address":"TQpeU63gg...","chain":"TRON","valid":true}
```

`valid:false` is a **200 answer, not an error** — your UI uses it inline
("that doesn't look like a TRON address"). The gate is charset/length/prefix
only — a well-formed but *wrong* address still passes; the withdrawal endpoint
applies the same check server-side before any money moves.

### `GET /api/v1/fees/estimate` — what will this send cost?

| Param | Required | What it's for |
|---|---|---|
| `asset` | **yes** | Asset code |
| `amount` | **yes** | Human units, e.g. `"10"` |
| `toAddress` | no | Omit → typical-transfer estimate. Provide → destination-priced quote (UTXO output count, EVM contract-vs-EOA gas). Malformed → 400 |

```bash
# Quick quote while the user types — no address yet
curl "$BASE/fees/estimate?asset=TRX&amount=10" -H "X-API-Key: $API_KEY"
# → {"asset":"TRX","chain":"TRON","amount":"10","fee":"1"}

# Precise quote once the address is known
curl "$BASE/fees/estimate?asset=USDT_TRON&toAddress=TQpe...&amount=25" \
  -H "X-API-Key: $API_KEY"
```

Returned `fee` is in the **chain's native currency** (TRX for USDT_TRON, ETH
for USDT_ETH) — that's what gas costs, and it's what the treasury pays, not
the user's asset. *Deposits have no fee estimate — the sender pays inbound
fees.*

---

## 4. Deposits — the inbound flow

**There is no "create deposit" endpoint.** Deposits are chain events: the user
sends crypto to their permanent address; the service detects it (webhook +
poller), tracks confirmations, credits the ledger, and fires an outbound
notification to your `webhookUrl`.

**Test path:**

1. Get the user's address from `GET /wallets/{id}` → `addresses[]`
2. Send testnet funds to it (faucet / another wallet). For SOL, attach the
   `memo` — without it the deposit lands in the unattributed queue
3. Watch `GET /transactions?externalUserId=...` or your webhook receiver for:
   - `deposit.detected` — seen on-chain, confirming
   - `deposit.confirmed` — final, ledger credited, `balance` updated

Poll status yourself:

```bash
curl "$BASE/transactions?externalUserId=user_1001&direction=inbound" \
  -H "X-API-Key: $API_KEY"
```

Each row carries `txid`, `confirmations` vs `requiredConfirmations`, `status`
(`pending → confirmed`), and `address`.

---

## 5. Withdrawals — the money-moving path

### `POST /api/v1/withdrawals` — send to an external address

| Param | Required | What it's for |
|---|---|---|
| `externalUserId` | **yes** | Which user's wallet this draw is attributed to — always required (ledger identity + tenant scoping), even when the ledger balance check is disabled for your tenant |
| `asset` | **yes** | `BTC, LTC, ETH, POL, SOL, TRX, USDT_TRON, USDT_ETH, USDC_ETH, USDC_POL, USDC_SOL` |
| `toAddress` | **yes** | Destination — format-validated **before** the debit; malformed → 400, nothing moves |
| `amount` | **yes** | Positive decimal string, human units — `"0.05"`. Regex-strict (no `-5`, `.5`, `1e3`) |
| `reference` | recommended | **Your idempotency key.** Unique per send in your app. Same reference + same payload → returns the original tx (safe retry). Same reference + different payload → **409**. Omit it and every call sends fresh — required in production |

```bash
curl -X POST $BASE/withdrawals \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"externalUserId":"user_1001","asset":"TRX",
       "toAddress":"TQpe...","amount":"5","reference":"payout-0042"}'
```

**Response** includes `fee` — the network-fee estimate stamped **at request
time**, so your UI can show the cost in the same call. It gets overwritten by
the actual chain fee once the tx is sighted on-chain.

**What happens inside, in order:**

1. Asset + destination + amount validated (400s before anything writes)
2. Wallet resolved by `(externalUserId, your appId)` — 404 if never created
3. `reference` dupe check → 409 on collision
4. Withdrawal limits → over `maxPerTx` = 400; over `approvalAbove` →
   `requires_approval` (parked, no broadcast until admin approval — §7)
5. Ledger debit + `pending` tx row written **atomically**
6. **Treasury coverage pre-check** — if the chain treasury can't cover
   amount+fee → 503, debit reversed, tx marked `failed`
7. Broadcast via Tatum/KMS; `txid` replaced by the real hash
8. `withdrawal.broadcast` → status worker tracks → `withdrawal.confirmed`
   (or `withdrawal.failed` with automatic debit reversal)

**Balance semantics:** with `enforceBalance=true` (default), step 4 also
verifies `ledger balance ≥ amount` under a row lock. For `acme`
(`enforceBalance=false`), the debit still posts — the wallet can go negative,
meaning your books owe custody that much. **Your backend must do its own
atomic check** — "read → compare → call" races.

**Failure states to test:** `400` malformed address/amount/over-limit ·
`400` insufficient balance (enforce tenants) · `404` unknown user · `409`
reference reuse · `503` treasury underfunded · `requires_approval` status on
over-threshold amounts.

### `GET /api/v1/transactions` — the tenant-wide feed

| Param | What it's for |
|---|---|
| `page`, `limit` | Pagination (limit ≤ 100, default 20) |
| `direction` | `inbound` deposits / `outbound` withdrawals |
| `status` | `pending, confirmed, failed, reorged, requires_approval, rejected` |
| `chain`, `asset` | `TRON` catches TRX+USDT_TRON; `asset` is exact |
| `externalUserId` | One user's history |
| `reference`, `txid` | Look up by your ref or the chain hash |

Internal treasury sweeps never appear here — the feed is customer-meaningful
only.

### `GET /api/v1/transactions/{id}` — single transaction status

The row's own id (from the send response or the list). Returns status,
confirmations vs required, `fee` (estimate → actual), `txid`, and pricing
fields once the notification pipeline stamped them.

---

## 6. Outbound webhooks — what your backend receives

Events POST to the `webhookUrl` configured on your client, HMAC-signed with
your `webhookSecret` (`x-bitlily-signature`, `x-bitlily-timestamp` headers —
**verify and check timestamp skew before trusting**).

| Event | Fires when |
|---|---|
| `deposit.detected` | Inbound tx first sighted on-chain |
| `deposit.confirmed` | Required confirmations reached — **safe to credit the user** |
| `deposit.reorged` | A confirmed deposit lost confirmations — reverse your credit |
| `withdrawal.broadcast` | Send accepted on-chain; carries `txid` + estimated `fee` |
| `withdrawal.confirmed` | Final — actual `fee` now on the payload |
| `withdrawal.failed` | Broadcast/solvency failed — debit reversed, notify the user |

Payload `data` block:

```json
{
  "transactionId": "...", "walletId": "...",
  "direction": "inbound", "asset": "TRX", "chain": "TRON",
  "txid": "a1b2...", "address": "TQpe...", "amount": "5",
  "fee": "1", "status": "confirmed", "confirmations": 20,
  "reference": "payout-0042",
  "usdPrice": "0.3345", "usdValue": "1.67",
  "priceSource": "tatum", "pricedAt": "2026-10-16T08:00:00Z"
}
```

- `usdPrice`/`usdValue` are **informational** — ledger math stays in token
  units. `priceSource` ∈ `tatum | coingecko | peg`; `null` when unpriced
- `fee` is best-known: estimate at broadcast, actual at confirmed
- Delivery retries on non-2xx — **make your handler idempotent** on
  `transactionId`+`status`; the same event can legitimately arrive twice

`GET /webhook` (unauthenticated) returns this documentation as JSON —
`curl http://localhost:3100/webhook` for a self-describing reference.

---

## 7. Admin / ops surface (`X-Admin-Key` + `X-API-Key`)

Ops tooling — not for app users. All under `/api/v1/admin`.

| Endpoint | Params | Purpose |
|---|---|---|
| `GET /clients` | — | List tenants — `source: env` (edit `.env`, API-immutable) or `db` (PATCHable) + `enforceBalance` |
| `POST /clients` | `slug*` (`^[a-z0-9-]+$`), `name`, `webhookUrl`, `scopes`, `allowedIps` (CIDRs), `enforceBalance` | Register a tenant — **returns `apiKey` + `webhookSecret` exactly once** |
| `PATCH /clients/{slug}` | `name`, `webhookUrl`, `scopes`, `allowedIps` (`[]` clears), `active` (false suspends), `enforceBalance`, `rotate` (new creds, old key dies) | Update a **db** client — env slugs 404 by design |
| `GET /custody` / `POST /custody` | `chain`, `xpub`/`baseAddress`, `signatureId`, `kmsAddress` (pair proof), `treasuryAddress`, `rotate` | List / enroll KMS custody wallets — the pair proof refuses mismatched key material |
| `POST /wallets/{id}/watch` | `address`, `asset`, `expiresInMinutes` | Re-watch an address — late payments to expired addresses, wrong-asset sends |
| `POST /withdrawals/{id}/approve` | path id | Broadcast a parked `requires_approval` withdrawal (treasury gate still applies) |
| `POST /withdrawals/{id}/reject` | path id | Refuse it — the debit reverses, user balance restored |
| `GET /deposits/unattributed?chain=` | `chain` optional | Ops queue: real on-chain funds with no attribution (memo-less SOL deposits) |
| `POST /deposits/{id}/credit` | `appId`, `externalUserId` | Manually credit an unattributed deposit — idempotent, 409 if already attributed |

`GET /api/v1/kms/verify/{requestId}` (admin) — inspect a pending KMS signing
request (hang diagnostics).

**Approval-flow test:** set `WITHDRAWAL_APPROVAL_ABOVE={"TRX":"1"}` → send 5
TRX → tx parks as `requires_approval`, ledger already debited →
`POST /admin/withdrawals/{id}/approve` broadcasts it, or `/reject` reverses.

---

## 8. The canonical end-to-end run

```bash
# 0. Ready?
curl $BASE/ready

# 1. Create the user wallet (once — idempotent)
curl -X POST $BASE/wallets -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" -d '{"externalUserId":"e2e-user"}'

# 2. Fund it: send testnet TRX to the TRON address from step 1.
#    Poll until confirmed:
curl "$BASE/wallets/e2e-user?include=balances,transactions" -H "X-API-Key: $API_KEY"

# 3. Pre-flight: validate + quote
curl "$BASE/addresses/validate?asset=TRX&address=<DEST>"   -H "X-API-Key: $API_KEY"
curl "$BASE/fees/estimate?asset=TRX&toAddress=<DEST>&amount=2" -H "X-API-Key: $API_KEY"

# 4. Withdraw — fee estimate arrives in the response itself
curl -X POST $BASE/withdrawals -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"externalUserId":"e2e-user","asset":"TRX","toAddress":"<DEST>",
       "amount":"2","reference":"e2e-001"}'

# 5. Same reference again → returns the SAME tx (retry safety); different
#    payload + same reference → 409 (bug caught, not double-send)

# 6. Track it
curl "$BASE/transactions?reference=e2e-001" -H "X-API-Key: $API_KEY"
#    and watch your webhook receiver for broadcast → confirmed
```

---

## 9. Testing-notes cheatsheet

- **`reference` discipline** is the single most important client-side rule:
  generate one per logical payout, reuse it across retries, never across
  different payouts
- **Memo-less SOL deposits** don't disappear — they sit in
  `/admin/deposits/unattributed` until ops credits them
- **Balance vs treasury**: user balance is ledger liability; the treasury
  coverage gate independently refuses sends the vault can't fund
- **Negative balances** are possible under `enforceBalance=false` — they
  mean *your app owes custody*, and reconciler ignores them for solvency
- **Testnet pricing** is mainnet-market — for display plumbing only
- Env-managed clients (`acme`) are **immutable via API** — `.env` + restart
- All timestamps are ISO-8601 UTC; all amounts are decimal **strings**
