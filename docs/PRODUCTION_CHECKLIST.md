# Production Go-Live Checklist

Ordered by what must happen first. Items are gated — don't enable
mainnet traffic until the "Blocking" section is done.

## Blocking (before any real funds)

- [ ] **1. Client's own KMS host.** Deploy `tatumio/tatum-kms` on client
      infrastructure, `generatemanagedwallet` per chain, enroll the six
      signatureIds via `POST /api/v1/admin/custody`. Delete the test
      `wallet.dat` host — never carry testnet keys into prod.
- [ ] **2. `wallet.dat` backups.** Copy + `TATUM_KMS_PASSWORD` stored
      separately, encrypted, off-host. Restore drill procedure is in
      `docs/RUNBOOK.md` §4 — it was verified on testnet 2026-10-04.
- [ ] **3. `TATUM_WEBHOOK_HMAC_SECRET`** (prod value)
      - `openssl rand -hex 32` → secrets manager → env var
      - Restart; confirm `Webhook HMAC enrolled` log line
      - Probe: unsigned POST to `/api/v1/webhooks/tatum` → must 401
- [ ] **4. `TATUM_API_KEY` (mainnet)** + `TATUM_NETWORK=mainnet`
- [ ] **5. `WEBHOOK_INGRESS_URL`** = public HTTPS ingress of the prod
      deployment (`https://<domain>/api/v1/webhooks/tatum`)
- [ ] **6. `MAIN_APP_WEBHOOK_URL`** + `WEBHOOK_SIGNING_SECRET` (prod)
- [ ] **7. `SERVICE_API_KEYS` / `ADMIN_API_KEY_HASHES`** — production-grade
      secrets from the secrets manager, not `.env` on disk; prefer hashed
      admin keys so a config leak can't yield a usable credential
- [ ] **8. `USDT_MATIC` smoke test** — ~1 USDT deposit → credit →
      withdraw → settle on mainnet before enabling it in `ENABLED_ASSETS`
- [ ] **9. TLS + edge**: HTTPS termination in front of :3100,
      rate-limit `/api/v1/kms/verify/*` at the edge (see SECURITY_REVIEW
      limitation 5)

## Needs client sign-off (values are policy, not code)

- [ ] **10. `WITHDRAWAL_LIMITS`** — per-asset max per transaction (JSON)
- [ ] **11. `WITHDRAWAL_APPROVAL_ABOVE`** — amounts at/above this debit
      the ledger but hold broadcast for admin approval
- [ ] **12. `CONFIRMATIONS_*`** — review vs chain finality at expected
      ticket sizes (current: BTC 2, LTC 4, ETH 12, POLYGON 64, SOL 32,
      TRON 20)
- [ ] **13. `TREASURY_GAS_FLOOR`** — per-chain overrides if the defaults
      (`.env.example`) don't match treasury sizing
- [ ] **14. `TREASURY_GAS_FLOOR` alerts routed** — `treasury.gas_low`
      events must reach someone who can refill gas (outbox → main app
      webhook or pager)

## Operational (can run parallel / shortly after go-live)

- [ ] **16. External security review** — scope: repo +
      `docs/SECURITY_REVIEW.md` (threat model + verified-vs-assumed
      matrix + live-found bug list already prepared). Right reviewer is
      a web3-infra auditor, not a Solidity-only shop.
- [ ] **17. Rate-limit tuning under real load** — defaults are
      conservative; load-test before the client's projected peak
- [ ] **18. Tatum plan/rate-tier review** — polling + subscriptions burn
      credits; pick the tier for expected address count
- [ ] **19. Monitoring** — health (`/api/v1/health`), readiness
      (`/api/v1/ready`), outbox drain, KMS daemon up. `docker kill`
      restart behavior verified 2026-10-04.
- [ ] **20. Docker host egress** — recurring ETIMEDOUT/ENETUNREACH flaps
      seen on the dev host; on the prod host watch the same symptom and
      file it as infra if it recurs (RUNBOOK §6)

## Deferred / accepted

- SOL deposit finality is approximated (Tatum indexing lag — documented
  limitation)
- TRX fee estimate is a fixed 1 TRX — replace with bandwidth-aware
  estimate if TRON volume matters
- `ENABLED_ASSETS` can narrow the served set without redeploying code
