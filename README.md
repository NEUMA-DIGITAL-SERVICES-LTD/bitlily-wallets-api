# Bitlily Crypto Service

Multi-chain crypto infrastructure microservice for Bitlily. A standalone REST
API that sits between the main application and blockchain vendors:

```
Bitlily main app  →  this service  →  provider (Tatum)  →  blockchains
```

## Architecture

**Gateway + own ledger.** The main app owns user balances for its product
logic; this service owns the *crypto* ledger (who deposited what, where, and
when it's confirmed) and all blockchain I/O. The provider is behind a
`BlockchainProvider` interface — only `src/providers/tatum/` talks to Tatum.

> Note: we deliberately do **not** depend on Tatum Virtual Accounts — VA is
> restricted to pre-2025-11-24 Tatum accounts. Our own Postgres ledger is the
> source of truth, which also removes a vendor lock-in.

### Deposit flow (Selly-style)

1. `POST /api/v1/wallets` — wallet per `externalUserId` (one account per
   **chain**; assets on a chain share its xpub + derivation index, so
   ETH and USDC_ETH never derive colliding addresses)
2. `POST /api/v1/wallets/:id/addresses` `{asset, reference?, expiresInMinutes?}` —
   deposit address; `reference` ties it to an order/invoice, `expiresInMinutes`
   bounds monitoring cost (default 60). Same-chain assets on one address are
   tracked as separate (address, asset) watch pairs — an ETH payment to a
   USDC-labeled address can still be detected if an ETH watch exists.
3. Detection runs in one of two modes (`DEPOSIT_DETECTION`):
   - `polling` (default): DepositPoller checks active-address balances every
     ~2 min and credits deltas — credit-minimal, works on Tatum's free plan
   - `webhook`: Tatum pushes to `POST /api/v1/webhooks/tatum` — lower latency,
     needs paid plan + public `WEBHOOK_INGRESS_URL`
4. In webhook mode we **re-fetch the tx on-chain** (payload is a hint, never
   proof); in polling mode the balance itself is the on-chain evidence
5. On confirmation: idempotent ledger credit + HMAC-signed webhook to main app

### Withdrawal flow

`POST /api/v1/transactions` — ledger debit + broadcast recorded atomically.
An outbound sweeper (`OutboundStatusService`) re-fetches pending outbound
txids every ~2 min, derives confirmations from the chain tip, records real
on-chain fees, and marks them `confirmed`/`failed` — payout status is
always truthful. Production signing goes through Tatum KMS
(`TATUM_USE_KMS=true`); private keys never transit this service.
Dev/testnet signing uses `TESTNET_PK_{chain}` + `TESTNET_FROM_{chain}`
env vars — **testnet only, never mainnet**.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/wallets` | Create wallet for a user |
| POST | `/api/v1/wallets/:id/addresses` | Generate deposit address |
| GET | `/api/v1/wallets/:id/addresses` | List deposit addresses |
| GET | `/api/v1/wallets/:id/balance` | Ledger balances |
| GET | `/api/v1/wallets/:id/transactions` | Tx history |
| POST | `/api/v1/transactions` | Send/withdraw |
| GET | `/api/v1/transactions/:id` | Tx status |
| GET | `/api/v1/fees/estimate` | Network fee estimate |
| POST | `/api/v1/webhooks/tatum` | Provider ingress (public) |
| GET | `/api/v1/health` | Liveness |

Auth: `X-API-Key` header on all endpoints except webhooks/health.
Swagger UI at `/docs`.

## Reliability & security model

- **Two idempotency gates**: `webhook_events(provider, key)` dedupes
  deliveries; `transactions(txid, address, asset)` dedupes credits.
- **Verify-before-credit**: webhook payloads are never trusted — the tx is
  re-fetched and its outputs checked against the deposit address.
- **Confirmation thresholds** per chain (`CONFIRMATIONS_*` env); a 2-min cron
  sweeper re-checks pending txs so a dropped webhook is non-fatal.
- **Outbound webhooks** to the main app are HMAC-SHA256 signed and persisted
  in an `outbound_events` outbox — retried with backoff, dead-lettered after
  8 attempts, deduped consumer-side via `X-Webhook-Event-Id`
  (`X-Webhook-Signature: sha256=...`).
- Ledger debits for withdrawals are written **before** broadcast, in the same
  DB transaction — a crash mid-broadcast leaves a reconcilable pending row.

## Asset×chain matrix

Defined in `src/config/assets.ts` — this is the contractual scope boundary.
Restrict further with `ENABLED_ASSETS` env (comma-separated codes).
Token entries carry a `testnetContract` resolved automatically when
`TATUM_NETWORK=testnet` (e.g. Sepolia USDC is a different contract than
mainnet USDC).

### Verified on live testnet (updated 2026-10-03)

"Verified" = a real on-chain tx detected/confirmed/credited (deposits) or
broadcast/debited/confirmed (sends) — not just code review.

| Asset | Testnet | Deposit | Send | Notes |
|---|---|---|---|---|
| BTC | testnet3 | ✅ | ✅ **KMS-signed** | fee+change pinned after live fee-burn bug |
| ETH | Sepolia | ✅ | ✅ env-key + **KMS-signed** | full custody loop proven |
| SOL | devnet | ✅ | ✅ **KMS-signed** | single-address custody; confs = finalized-at-index (see caveat) |
| LTC | testnet4 | ✅ | ✅ **KMS-signed** | UTXO change/fee verified on-chain |
| POL | Amoy | ✅ | ✅ **KMS-signed** | Tatum enum is `MATIC` — mapped in provider |
| TRX | Shasta | ✅ | ✅ **KMS-signed** | Tatum v3 testnet-TRON is Shasta, NOT Nile |
| USDC_ETH | Sepolia | ✅ | ✅ | official Circle testnet USDC |
| USDT_ETH | Sepolia | ✅ | ✅ | self-deployed mock — no canonical Sepolia USDT |
| USDT_TRON | Shasta | ✅ | ✅ **KMS-signed** | Shasta test contract `TG3XXy...` |
| USDC_MATIC | Amoy | ✅ | ✅ **KMS-signed** | real Circle Amoy USDC `0x41E9...7582` |
| USDT_MATIC | Amoy | — | ⚠️ by-analogy | no Tether testnet deployment exists; same code path as USDC_MATIC |

Sweep engine (deposit → treasury consolidation) is **live-proven** on LTC:
index-1 custody key signed via KMS, four-eye verified, change/fee correct.

**Known provider gaps (Tatum v3 surface limits):**
- `USDC_SOL` — Tatum exposes no SPL-token balance endpoint, so SPL
  deposits/withdrawals are **not monitorable** through this provider.
  `getAddressBalance` throws loudly rather than silently returning 0.
  Resolution requires a Solana-RPC-capable provider behind
  `BlockchainProvider` before that asset can be enabled honestly.
- SOL confirmations — Tatum has no SOL block-height endpoint; indexed
  txs are reported as finalized (32 confs). Deep-reorg detection on
  Solana is not implemented.

### Custody status

KMS signing is **proven end-to-end** on testnet: withdrawal → Tatum KMS
pending request → daemon four-eye check → local sign → broadcast → sweeper
resolves txid → ledger settles. Six chains enrolled (BTC/ETH/LTC/MATIC/TRON
xpub-managed wallets + SOL single-address wallet) via `/admin/custody`.
What remains is per-chain live sends (faucet-blocked) and the client's own
KMS host — see `docs/KMS_SETUP.md`.

## Running

```bash
cp .env.example .env          # fill TATUM_API_KEY, SERVICE_API_KEYS, etc.
docker compose up --build     # api on :3100, swagger at /docs
```

Local dev: `npm install && npm run start:dev` (Postgres from compose).
Migrations run automatically on boot (`migrationsRun`).

## Production checklist

- [ ] Tatum PayGo+ plan — who owns this recurring cost?
- [x] `TATUM_USE_KMS=true` + self-hosted Tatum KMS for signing — proven on testnet; prod needs the client's host + `generatemanagedwallet` per chain (see `docs/KMS_SETUP.md`)
- [ ] `ADMIN_API_KEYS` + `KMS_VERIFY_TOKEN` set (admin endpoints fail-closed without them in prod)
- [ ] `WITHDRAWAL_LIMITS` + `WITHDRAWAL_APPROVAL_ABOVE` signed off per asset
- [ ] IP-allowlist webhook ingress at LB (Tatum egress ranges)
- [ ] Per-environment `SERVICE_API_KEYS`, rotate on schedule
- [ ] Confirm the signed-off asset×chain matrix matches `assets.ts`
- [ ] Main app verifies `X-Webhook-Signature` on inbound events
- [ ] `wallet.dat` backup + restore drill on the KMS host
- [ ] Testnet end-to-end pass on every enabled asset before mainnet key
