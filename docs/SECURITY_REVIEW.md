# Security & Reliability Review — Pre-Audit Brief

Written for external reviewers. States what the system claims, what is
proven, what is assumed, and where the known sharp edges are. Nothing in
here is aspirational — every claim cites code or a live testnet result.

## Architecture & trust boundaries

```
Bitlily app ──REST──▶ crypto-service ──REST──▶ Tatum v3 ──▶ chains
                (x-api-key)        (x-api-key)
                                    │
                                    ├── Postgres = ledger source of truth
                                    └── Tatum KMS daemon (separate host)
                                        └─ signs via wallet.dat;
                                           four-eye verify callback
                                           before every signature
```

- **Tatum is a gateway, not the ledger.** The Postgres `ledger_entries`
  table is the application-level source of truth; chain state is
  reconciled against it hourly.
- **KMS holds all private keys.** `TATUM_USE_KMS=true` makes
  `TESTNET_PK_*` envs dead code — the provider refuses non-KMS sends
  (pinned by test). `wallet.dat` lives only on the KMS host.
- **Four-eye signing.** The KMS daemon calls
  `GET /api/v1/kms/verify/{token}/{requestId}` before signing; the
  endpoint returns 200 iff `requestId` matches a `pending` outbound row
  this service created. A forged or replayed KMS request cannot get
  signed — proven live (manual probe refused every cycle).

## Threat model (what we defend against)

| Threat | Control | Verified how |
|---|---|---|
| Compromised service key moves funds | `WITHDRAWAL_LIMITS` hard cap + `APPROVAL_ABOVE` soft cap + admin approval endpoints | code + config |
| Compromised Tatum API key drains via direct KMS requests | Four-eye verify — no matching tx row → no signature | live-refused request `6ac06d6c` |
| Process crash between debit & broadcast | `pending:<uuid>` placeholder txids; reconciler alerts "crash suspected"; broadcast failures auto-reverse | live: 7 outage-window failures all reversed |
| Reorg un-credits a deposit | poller tracks confirmations; reversal entries on drop below threshold | unit-tested + reorg logic |
| Sweep commingles customer & custody funds | derivation index 0 reserved for treasury; deposits start at 1 | live LTC sweep used index-1 key |
| UTXO send burns unspent input as fee | `fee` + `changeAddress` pinned in body (Tatum does NOT auto-change) | live burn caught: 105k sats lost on testnet; fix verified on-chain |
| Fake/malformed webhook credits | `x-payload-hash` HMAC-SHA512 verified at ingress + verify-by-refetch + per-minute rate limit | live: unsigned/invalid → 401, signed → processed |
| KMS host compromise | keys never leave `wallet.dat`; external URL can't be re-aimed without redeploy | — |
| Insider with admin key sweeps treasury | sweep endpoint is admin-only; KMS still requires its own signing | code |

## Audit findings → fixes (2026-10-04 hardening pass)

A full-codebase audit found 22 issues. Status after the fix pass:

| # | Finding | Status |
|---|---|---|
| 1 | No withdrawal idempotency — client retry = double send | **FIXED** — `idempotency_key` (body or `Idempotency-Key` header), partial unique index `(wallet_id, key)`, dupe returns original row, 23505 race handled |
| 2 | Balance-check TOCTOU — concurrent sends both pass | **FIXED** — wallet row `pessimistic_write` lock inside the DB tx; balance re-read under lock |
| 3 | Negative amounts passed `@IsNumberString` (proven live: `-5` debited as a credit) | **FIXED** — `^\d+(\.\d{1,18})?$` DTO regex + `>0` service guard + `LedgerService` invariant; live-verified rejected |
| 4 | UTXO deltas without tx attribution credited at 0-conf | **FIXED** — unattributed UTXO deltas record `pending` only; real txid adoption + confirmation required; spec regression-pinned |
| 5 | Provider outage treated as reorg → real deposits reversed | **FIXED** — `reverifyRecent` distinguishes transport errors (defer) from positive absence (reverse) |
| 6 | Reconciler counted pending sweeps as liabilities → false divergence | **FIXED** — sweep-tagged outbound rows excluded |
| 7 | `/api/v1/ready` returned HTTP 200 with DB down | **FIXED** — 503; live-verified against a stopped DB |
| 8 | Webhook verify: wrong-asset row match, no TRC20 output decode, SPL outputs keyed to token-account not owner | **FIXED** — multi-asset resolution tries every watched row; TRC20 `TriggerSmartContract` calldata decoded; SPL outputs keyed by `owner` |
| 9 | `deferred`/`failed` webhook events never retried | **FIXED** — `attempts` column; sweeper reprocesses up to 10× |
| 10 | Webhook rate limiter mounted on `/webhooks` — never matched | **FIXED** — mounted on `/api/v1/webhooks` |
| 11 | Custody re-enroll silently rotated signatureId | **FIXED** — `rotate:true` required to replace; refusal message explains the wrong-wallet risk |
| 12 | API-key compare short-circuited (timing oracle) | **FIXED** — `crypto.timingSafeEqual` |
| 13 | SOL deposit address 500s forever after TTL retire | **FIXED** — base address reactivates/reuses the retired row |
| 14 | `.toFixed(8)` hardcoded — dust-truncates 9+ decimal assets | **FIXED** — `asset.decimals` everywhere amounts are formatted |
| 15 | No global exception filter — raw internals/axios errors leaked | **FIXED** — `HttpExceptionFilter`: uniform `{code,message,requestId}`; non-HTTP throws → `INTERNAL_ERROR` |
| 16 | `createWallet` all-or-nothing across chains | accepted risk — partial wallets would confuse custody enrollment |
| 17 | `toAddress` had zero format validation | **FIXED** — per-chain charset/length/prefix gate before debit (live-verified) |
| 18 | Inconsistent event names (`deposit.confirmed` vs `transaction.broadcast`) | **FIXED** — normalized to `withdrawal.broadcast` before consumers integrate |
| 19 | `estimateFee` returned `'0'` on total failure — read as "free" | **FIXED** — throws; fallback endpoint also fixed to use chain code |
| 20 | Concurrent sweeps on one address could double-send | **FIXED** — pending `sweep:{depId}` row blocks a second sweep |
| 21 | SOL native sweep: `estimateFee`→`'0'` → full-balance send → on-chain fee failure | **FIXED** — covered by #19 (unknown fee now refuses) |
| 22 | `AssetParamDto` dead code | **FIXED** — removed |
| 23 | Inbound webhook had no origin authentication | **FIXED** — `TATUM_WEBHOOK_HMAC_SECRET` + `x-payload-hash` (HMAC-SHA512/Base64, `timingSafeEqual`); service self-enrolls the API key via `PUT /v3/subscription` at boot. **Live-verified: unsigned/invalid → 401, valid → processed** |
| 24 | `webhook_events.externalEventKey` entity↔migration column mismatch (`external_event_key`) — every webhook insert crashed | **FIXED** — found by the HMAC live test; entity name pinned; full-entity camelCase sweep found no others |
| 25 | `orIgnore()` dedupe check tested `identifiers.length` — conflicts return `[null]`, so 'duplicate' never reported and replays reprocessed | **FIXED** — checks `raw.length`; live-verified replay → `duplicate` |

## Honest limitations (review these first)

1. **Address reuse**: deposit addresses are PERMANENT per
   (wallet, chain) — `expires_at` is always NULL on new rows.
   Long-lived reuse is the design; the trade-off is that an address
   leak/doxxing can't be rotated away without a new wallet.
2. **SOL confirmations are approximated.** Tatum indexes only settled
   SOL txs; the service reports `err:null + slot` as finalized
   (confs=32). Deep-reorg detection on Solana does not exist — on
   mainnet, SOL deposit finality inherits Tatum's indexing lag.
3. **Reconciler is report-only.** It never mutates rows — divergence
   pages a human. Correct by design, but response time is operational.
4. **Docker egress flaps** observed on this host (Cloudflare timeouts).
   Failure paths handled (queue/reverse/retry), but root cause is
   unresolved infra, not app code.
5. **`kms/verify` is public by necessity** (KMS has no API key).
   `KMS_VERIFY_TOKEN` path segment is the only gate — a leaked URL
   leaks "does request X exist" (existence oracle only, no signing
   influence). Rate-limit at the edge in prod.
6. **Single-point signing**: KMS host is a SPOF for withdrawals and a
   catastrophic-loss point if `wallet.dat` is lost. **Backup/restore
   drill performed 2026-10-04** — fresh container + copied file +
   `TATUM_KMS_PASSWORD` loaded all six signatureIds identical to prod
   (procedure in RUNBOOK §4). Both the file AND the password must be
   backed up; either alone is useless, together is total custody.
7. **USDT_MATIC** — verified by-analogy only (see below).
8. **Treasury gas starvation is possible.** Observed live: POL treasury
   at 0.0073 while ledger showed 0.05 — gas spend isn't a ledger event.
   A gas-starved treasury wedges all EVM sends at broadcast (KMS signs,
   chain refuses). Needs a gas-floor alert on mainnet; see RUNBOOK §4.

## Live-verified coverage (testnet, as of 2026-10-03)

"Verified" = real on-chain tx completed the full loop: ledger debit →
KMS request → four-eye verify → daemon sign → broadcast → txid resolve
→ required confirmations → ledger settle → outbox event.

- **Natives (6/6)**: BTC, LTC, ETH, POL, SOL, TRX — all KMS-signed
- **BSC + DOGE**: code-complete and custody-enrolled (KMS daemon polls
  both), but NOT yet loop-verified end-to-end on testnet — treat as
  unproven until a real deposit→credit→sweep/withdraw cycle passes
- **Tokens (5/6)**: USDT_ETH, USDC_ETH, USDT_TRON, USDC_MATIC,
  USDC_SOL — all KMS-signed against real issuer testnet contracts
  (except USDT_ETH: self-deployed mock; no Tether testnet exists)
- **USDT_MATIC**: registered, code path identical to USDC_MATIC, but
  no canonical testnet contract exists → gated behind a mainnet
  smoke-test checklist item. Not claimed as verified.
- **Sweeps**: live-proven on LTC (index-1 custody key, correct
  change/fee accounting, four-eye verified, tracked as outbound tx)

## Bugs found exclusively by live testing

These would not exist in a mocked suite. Listed so reviewers can judge
residual blind spots:

1. UTXO fee-burn (105k sats lost) — Tatum sends all unspent input to
   miners without `changeAddress`
2. `raw_data.contract` crash on TRON refresh (always-truthy `?? {}`)
3. Wallets created before KMS enrollment unable to withdraw
   (signatureId source was per-account copy, not chain custody row)
4. `POL`/`POLYGON` vs Tatum's `MATIC` enum — 3 separate endpoints
5. Index-0 custody collision (first deposit = treasury address)
6. Sweep controller missing admin guard (privilege hole)
7. TRON balance path 404; Shasta≠Nile testnet confusion
8. KMS txid returned as stringified JSON (stored literally as txid)
9. TRON tx payload is `rawData` (camelCase) not `raw_data` — every TRON
   normalize produced zero outputs → real webhook deposits rejected as
   spoofed (found by first live Tatum delivery)
10. TRON token-scoped normalize fell back to native outputs — a
    USDT_TRON watch row "verified" a plain TRX send and created a
    phantom token deposit (misattribution caught before it credited;
    row rejected, event replayed correctly)
11. `/v3/tron/current/block` 404s — chain height comes from
    `/v3/tron/info` (`blockNumber`)

## Mainnet contract audit — done 2026-10-04

All six token `contract`+`decimals` entries verified against issuer
registries, not explorers: Circle (developers.circle.com) for
USDC_ETH/MATIC/SOL, tether.to supported-protocols for USDT_TRON/ETH,
polygon.technology mapped-tokens for USDT_MATIC. USDC_MATIC is the
**native** issuance (`0x3c49…3359`), not bridged USDC.e. All six
correct; decimals all 6.

## What still needs external validation

- [ ] Production `WITHDRAWAL_LIMITS`/`APPROVAL_ABOVE` values (config,
      currently test-tuned)
- [x] ~~one live Tatum delivery~~ — done 2026-10-04 via ngrok tunnel:
      two real `ADDRESS_EVENT` deliveries verified `x-payload-hash`,
      output-matched, credited; also surfaced bugs #9–11 above
- [x] ~~KMS `wallet.dat` backup/restore drill~~ — done 2026-10-04
      (RUNBOOK §4); production secret storage still ops-owned
- [ ] `TATUM_WEBHOOK_HMAC_SECRET` production value (test value in use)
- [ ] Treasury gas-floor alerting (see limitation #8)
- [ ] Rate-limit tuning under real load (defaults are conservative)
- [ ] Tatum plan/rate-tier — credits burn under polling load at scale
- [ ] A second reviewer on `deposit-poller` delta/reorg accounting —
      it is the most safety-critical code in the service
