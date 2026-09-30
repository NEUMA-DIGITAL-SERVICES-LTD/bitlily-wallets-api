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

1. `POST /api/v1/wallets` — wallet per `externalUserId` (one account per enabled asset)
2. `POST /api/v1/wallets/:id/addresses` `{asset, reference?}` — deposit address;
   `reference` ties it to an order/invoice (per-payment addresses)
3. Tatum fires `POST /api/v1/webhooks/tatum` on incoming funds
4. We **re-fetch the tx on-chain** (webhook body is a hint, never proof),
   record it `pending`, then `confirmed` at per-chain confirmation thresholds
5. On confirmation: idempotent ledger credit + HMAC-signed webhook to the main app

### Withdrawal flow

`POST /api/v1/transactions` — ledger debit + broadcast recorded atomically.
Production signing goes through Tatum KMS (`TATUM_USE_KMS=true`); private keys
never transit this service.

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
- **Outbound webhooks** to the main app are HMAC-SHA256 signed
  (`X-Webhook-Signature: sha256=...`).
- Ledger debits for withdrawals are written **before** broadcast, in the same
  DB transaction — a crash mid-broadcast leaves a reconcilable pending row.

## Asset×chain matrix

Defined in `src/config/assets.ts` — this is the contractual scope boundary.
Restrict further with `ENABLED_ASSETS` env (comma-separated codes).

## Running

```bash
cp .env.example .env          # fill TATUM_API_KEY, SERVICE_API_KEYS, etc.
docker compose up --build     # api on :3100, swagger at /docs
```

Local dev: `npm install && npm run start:dev` (Postgres from compose).
Migrations run automatically on boot (`migrationsRun`).

## Production checklist

- [ ] Tatum PayGo+ plan — who owns this recurring cost?
- [ ] `TATUM_USE_KMS=true` + self-hosted Tatum KMS (or Vault) for signing
- [ ] IP-allowlist webhook ingress at LB (Tatum egress ranges)
- [ ] Per-environment `SERVICE_API_KEYS`, rotate on schedule
- [ ] Confirm the signed-off asset×chain matrix matches `assets.ts`
- [ ] Main app verifies `X-Webhook-Signature` on inbound events
- [ ] Testnet end-to-end pass on every enabled asset before mainnet key
