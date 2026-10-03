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
| Fake/malformed webhook credits | `X-Webhook-Signature` HMAC + per-minute rate limit | code; signature verification is a main-app checklist item |
| KMS host compromise | keys never leave `wallet.dat`; external URL can't be re-aimed without redeploy | — |
| Insider with admin key sweeps treasury | sweep endpoint is admin-only; KMS still requires its own signing | code |

## Honest limitations (review these first)

1. **Deposit TTL**: watch rows expire after
   `DEPOSIT_ADDRESS_TTL_MINUTES` (default 60). Customer deposit
   addresses are intentionally ephemeral — long-lived reuse is
   unsupported. Treasury rows run `expires_at=NULL`.
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
   catastrophic-loss point if `wallet.dat` is lost. Backup drill is a
   checklist item, not yet performed.
7. **USDT_MATIC** — verified by-analogy only (see below).

## Live-verified coverage (testnet, as of 2026-10-03)

"Verified" = real on-chain tx completed the full loop: ledger debit →
KMS request → four-eye verify → daemon sign → broadcast → txid resolve
→ required confirmations → ledger settle → outbox event.

- **Natives (6/6)**: BTC, LTC, ETH, POL, SOL, TRX — all KMS-signed
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

## What still needs external validation

- [ ] Production `WITHDRAWAL_LIMITS`/`APPROVAL_ABOVE` values (config,
      currently test-tuned)
- [ ] Webhook signature verification on the main-app side
- [ ] KMS `wallet.dat` backup/restore drill
- [ ] Rate-limit tuning under real load (defaults are conservative)
- [ ] Tatum plan/rate-tier — credits burn under polling load at scale
- [ ] A second reviewer on `deposit-poller` delta/reorg accounting —
      it is the most safety-critical code in the service
