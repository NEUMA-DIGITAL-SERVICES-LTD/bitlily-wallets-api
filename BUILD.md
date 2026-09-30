# Build Guide — Bitlily Crypto Service

Step-by-step implementation plan, ordered so that each phase leaves the
system in a verifiable state. Every phase has a **Done when** gate — do not
move on until it passes. Time estimates assume one senior engineer.

**Status legend:** `[x]` done · `[~]` scaffolded/needs production hardening · `[ ]` not started

---

## Phase 0 — Foundations ✅ (complete)

- [x] NestJS + TypeORM/Postgres scaffold, Docker + compose, migrations
- [x] `BlockchainProvider` interface — the vendor boundary; all chain I/O
      goes through `src/providers/` (`BLOCKCHAIN_PROVIDER` token)
- [x] Tatum adapter: wallet generation, xpub→address derivation, balance,
      tx fetch, send, fee estimate, v4 address subscriptions
- [x] Own Postgres ledger (`ledger_entries`) — **source of truth**.
      Tatum Virtual Accounts are **not** used: VA is restricted to accounts
      registered before 2025-11-24 (verified — HTTP 405 on new keys).
- [x] API-key service auth (`X-API-Key`), Swagger at `/docs`
- [x] Asset×chain registry (`src/config/assets.ts`) = contractual scope boundary

**Done when:** `docker compose up --build` → `GET /api/v1/health` → `{"status":"ok"}` ✅ verified 2026-09-30

---

## Phase 1 — Secrets & signing (~0.5–1 day)

Money must move only through custody the client controls.

- [ ] Provision **Tatum KMS** (self-hosted daemon) OR Vault/infra equivalent
- [ ] Store generated mnemonics in KMS at wallet creation; persist only the
      returned `signatureId`/`secretRef` on `wallet_accounts`
      (`WalletsService.persistSecretRef` is the hook — currently discards
      material with a warning)
- [ ] Wire `sendTransaction` to KMS `signatureId` path (`TATUM_USE_KMS=true`);
      keep the `TESTNET_PK_*` env path for dev only — never mainnet
- [ ] Remove any mnemonic from memory immediately after KMS enrollment;
      assert it is never logged or written

**Done when:** a testnet withdrawal signs via KMS with zero key material in
DB, logs, or process env after boot.

**Risk:** shipping with env private keys on mainnet = client funds in
plaintext. This is the line between a demo and a product.

---

## Phase 2 — Deposits end-to-end on testnet (~1–2 days)

The money-in path; the reason the service exists.

- [ ] Set `WEBHOOK_INGRESS_URL` to a public URL (staging tunnel / deployed URL)
      so `createAddressSubscription` actually registers with Tatum
- [ ] Verify `normalizeTx` output extraction on **real testnet transactions**
      per chain — send testnet BTC/LTC/ETH/SOL/TRX to generated addresses and
      confirm the parsed `outputs[]` match reality (shapes differ per chain;
      this is the highest-value test in the system)
- [ ] Confirm the full loop: subscription → webhook → `webhook_events` dedupe
      → on-chain re-fetch → `pending` tx → confirmations → `confirmed` +
      ledger credit → outbound HMAC webhook to main app
- [ ] Verify the 2-min sweeper (`sweepPending`) recovers a deposit when the
      webhook is dropped (simulate by blocking the webhook, wait for sweep)
- [ ] Verify replay safety: POST the same webhook payload twice → second is
      `duplicate`, no double credit. Spoof test: payload for a tx that never
      paid our address → `rejected`, no credit.

**Done when:** a real testnet deposit to a generated address credits the
ledger once, exactly once, within confirmation policy — with and without
the webhook firing.

**Landmines:** per-chain confirmation thresholds; reorgs (a `confirmed` tx
can go back to `pending` — the upsert already reflects this); Tatum webhook
payloads are unsigned — verification-by-refetch is the security boundary.

---

## Phase 3 — Withdrawals end-to-end (~1 day)

- [ ] Ledger debit + `pending` transaction row in one DB transaction
      **before** broadcast (already structured — verify with a killed-process
      test: crash between debit and broadcast must leave a reconcilable row)
- [ ] Broadcast via provider (KMS path), persist txid, track confirmations
      via sweeper until `confirmed`, notify main app
- [ ] Insufficient-balance guard works; failed broadcasts → `failed` +
      `withdrawal_reversal` ledger credit
- [ ] Fee estimation endpoint returns sane values per chain on testnet

**Done when:** testnet withdrawal debits ledger, broadcasts, confirms, and
a failed broadcast cleanly reverses the debit.

---

## Phase 4 — Fund consolidation (sweeps) (~1–2 days)

Deposits land on per-user/per-order addresses; the treasury must consolidate.

- [ ] **EVM token gas-pump**: a deposit address holding only USDT/USDC cannot
      move it — it needs native gas first. Build sweep flow: send gas to
      address → sweep token to treasury. Only economically rational above a
      per-asset dust threshold — define it.
- [ ] **UTXO consolidation**: many small BTC/LTC deposits = fragmented UTXOs;
      consolidation tx costs grow with input count. Schedule periodic
      consolidation, expose it as an internal admin endpoint.
- [ ] Treasury addresses per chain (the consolidation destination) managed
      like any other secret material.

**Done when:** funds deposited on 3+ generated testnet addresses consolidate
to treasury without manual key handling.

**Note:** this is the piece clients never think to spec and every custodial
system needs. Flag it in handover docs.

---

## Phase 5 — Reliability hardening (~1 day)

- [ ] Outbound webhook retries: persisted outbox rows + exponential backoff
      (currently single-shot fire-and-log)
- [ ] Reconciliation job: daily — ledger sums vs on-chain balances per chain
      vs Tatum-reported state; alert on divergence
- [ ] Structured logging (pino) + request IDs; no secrets/PII in logs
- [ ] Rate-limit + body-size limits on the public webhook ingress;
      consider Tatum egress IP allowlist at the LB
- [ ] Health → readiness split: `/health` (process up) vs `/ready` (DB +
      provider reachable)

**Done when:** killing the API mid-webhook, mid-broadcast, and mid-sweep
all recover cleanly after restart (test each).

---

## Phase 6 — Tests, docs, staging (~1 day)

- [ ] Integration tests with a mocked `BlockchainProvider` covering:
      duplicate webhook, spoofed webhook, insufficient-balance send,
      reorg (confirmed → pending), failed-broadcast reversal
- [ ] OpenAPI polish: response schemas + examples for every endpoint;
      exported Postman collection
- [ ] Staging deploy (compose on a VM is fine for v1), `.env` documented
- [ ] `DEPLOYMENT.md` + runbook: common failures, where to look, how to replay

**Done when:** a Bitlily dev can consume the API using only `/docs` + the
Postman collection, without reading source.

---

## Phase 7 — Handover (~0.5 day)

- [ ] Walkthrough session with client dev team (record it)
- [ ] Transfer: repo, env/secret custody (KMS), Tatum dashboard ownership,
      staging infra access
- [ ] **Payment milestone 3 = after transfer** — sequence it: staging demo →
      invoice → payment → repo/keys handover. Do not hand over final
      credentials before final payment clears.

---

## Invariants — never violate, regardless of phase

1. **Webhook body is a hint, never proof.** Always re-fetch the tx on-chain.
2. **Ledger writes are idempotent** — unique constraints do the enforcement;
   handlers may be retried freely.
3. **Debit before broadcast.** Never broadcast then record.
4. **No secret material in DB, logs, or git.** xpubs yes, mnemonics/keys never.
5. **The asset matrix is the contract.** New assets enter via
   `assets.ts` + client sign-off, never ad-hoc.
6. **Tatum is replaceable.** Nothing outside `src/providers/` may know
   Tatum's API shape.

## Explicitly out of scope (say no if asked)

- Tatum Virtual Accounts (gated to pre-2025-11-24 registrations — verified 405)
- "All chains" beyond the signed-off matrix
- Fiat on/off-ramp, card issuing, KYC — those live in Bitlily's main app
- Hot-wallet seed custody in this codebase (KMS owns it)

## Open questions to resolve with the client

- [ ] Signed-off asset×chain matrix (USDT on *which* chains exactly?)
- [ ] Who owns the Tatum subscription + KMS infra? (should be client)
- [ ] Per-deposit-address monitoring costs scale with users — confirm PayGo tier
- [ ] Dust/consolidation thresholds per asset
- [ ] Who operates sweeps post-handover — them (docs) or us (retainer)?
