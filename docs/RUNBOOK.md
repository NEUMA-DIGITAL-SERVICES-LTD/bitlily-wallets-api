# Operations Runbook — Bitlily Crypto Service

Every procedure below was developed against observed failures on testnet.
Assume any of them will be needed at 3 AM. Commands assume the repo root
and Docker Compose layout (`docker exec bitlily-crypto-service-db-1 psql
-U postgres -d bitlily_crypto -c "..."`).

## Service map

| Component | Where | Failure blast radius |
|---|---|---|
| API (`bitlily-crypto-service-api-1`) | `:3100`, swagger `/docs` | All money movement halts; ledger intact |
| Postgres (`bitlily-crypto-service-db-1`) | internal | Source of truth — DO NOT lose volume |
| KMS daemon (`bitlily-kms`) | separate container, holds `wallet.dat` | Withdrawals queue unsigned; deposits still credit |
| Tatum API | external | Everything that touches chain stops |
| Deposit poller | cron `*/2 min` | Deposits undetected |
| Outbound sweeper | cron `*/2 min` | Pending txs never confirm/resolve |
| Reconciler | cron hourly `:17` | Divergence undetected for 1h |
| Notifier | cron `* * * * *` | Alerts/webhook delivery delayed |
| Expiry job | cron `*/10 min` | — (maintenance) |

Health probes: `GET /api/v1/health` (liveness), `GET /api/v1/ready`
(readiness — DB + provider reachable). LB should route on `/ready` only.

---

## 1. Deposit not credited

Symptom: customer sent funds, no `deposit_confirmed` ledger entry.

Check, in order:

1. **Watch row state** — deposits only credit on `status='active'` rows:
   ```sql
   SELECT address,asset,status,expires_at,credited_amount
   FROM deposit_addresses WHERE address='<addr>';
   ```
   If `retired`: check `expires_at`. Watch rows are PERMANENT — a row
   with `expires_at` set is legacy TTL-era data or was retired by ops.
   Reactivate (also promotes to permanent):
   ```sql
   UPDATE deposit_addresses SET status='active',expires_at=NULL
   WHERE address='<addr>';
   ```
   (There is also `POST /api/v1/wallets/:id/watch` for reactivation via API.)

2. **Poller errors**: `docker logs <api> | grep "Poll failed"` —
   ETIMEDOUT/ENETUNREACH = provider connectivity (§6); 4xx = provider
   schema drift — check `TatumProvider` logs for the response body.

3. **Confirmations not reached**: tx row exists but `confirmations <
   required`. Per-chain thresholds live in `CONFIRMATIONS_<CHAIN>` env
   (BTC 2, LTC 4, ETH 12, POLYGON 64, SOL 32, TRON 20). Verify the txid
   on a public explorer before assuming provider error.

4. **Token contract mismatch**: the watch credits only the registered
   `testnetContract`/`contract` — a different contract's tokens on the
   same address are invisible (by design). Check `assets.ts`.

## 2. Withdrawal stuck `pending`

Symptom: `transactions.status='pending'` and txid is `pending:<uuid>`.

This is the debit-before-broadcast placeholder. Determine which stage:

1. `raw->>'kmsRequestId'` present → request reached Tatum KMS. Check it:
   ```bash
   curl -s https://api.tatum.io/v3/kms/<requestId> -H "x-api-key: $TATUM_API_KEY"
   ```
   - No `txId` + daemon logs show verify 404 → four-eye refused (no
     matching row — should be impossible now that sweeps create rows;
     treat as a BUG signal).
   - No `txId` + no daemon activity → daemon down (§4).
   - `txId` present → broadcast done; sweeper will resolve within a cycle.

2. No `kmsRequestId` → broadcast never reached Tatum (network, API
   crash, validation 400). The service marks these `failed` and posts a
   `withdrawal_reversal` ledger entry automatically. If a row stays
   `pending` with placeholder txid >10 min, the reconciler alerts
   "crash between debit and broadcast" — investigate manually:
   verify no tx hit the chain, then mark failed + reverse per §7.

3. `requires_approval` → amount ≥ `WITHDRAWAL_APPROVAL_ABOVE[asset]`.
   Admin action: `POST /api/v1/admin/withdrawals/:id/approve|reject`
   (admin key only). Reject posts a reversal credit.

## 3. Withdrawal `failed` but customer claims debit

Check the reversal posted:
```sql
SELECT kind,amount,created_at FROM ledger_entries
WHERE transaction_id='<txid>' ORDER BY created_at;
```
Expect `withdrawal` then `withdrawal_reversal` of equal amount. If the
reversal is missing, that is a money bug — escalate, do NOT hand-edit
the ledger.

## 4. KMS daemon down / requests not signing

Symptoms: withdrawals stall with `kmsRequestId` but no txid; verify
endpoint quiet.

- `docker ps | grep kms` / `docker logs bitlily-kms --tail 50`
- Daemon polls per-chain wallets every ~10s. Look for
  `Getting pending transaction from <CHAIN>`.
- Restart: `docker restart bitlily-kms`. Pending requests resume —
  KMS requests don't expire quickly and re-verify each cycle.
- **`wallet.dat` loss is unrecoverable** — without it all custody keys
  are gone. This is THE catastrophic scenario.
- A request getting refused every cycle with "Transaction not found on
  external system" = correct four-eye behavior for requests this
  service didn't originate (or whose tx row is already terminal).

### wallet.dat backup/restore — VERIFIED DRILL (2026-10-04)

The file lives at `/home/node/.tatumrc/wallet.dat` inside the container,
bind-mounted from the host. Backup + restore was proven end-to-end:

```bash
# 1. Backup (SHA256-checksum the copy — never edit the original)
cp ~/.tatumrc/wallet.dat /backup/wallet.dat.$(date +%F)
sha256sum ~/.tatumrc/wallet.dat /backup/wallet.dat.$(date +%F)

# 2. Prove the restore WITHOUT touching prod — second container,
#    same env, dead --externalUrl so it loads wallets but can't sign:
docker run -d --name kms-restore-test \
  -e TATUM_API_KEY=... -e TATUM_KMS_PASSWORD=... \
  -v /restore-dir:/home/node/.tatumrc \
  tatumio/tatum-kms daemon \
    --externalUrl=http://127.0.0.1:9/never \
    --chain=BTC,LTC,ETH,MATIC,TRON,SOL --period=10

# 3. PASS = logs show the SAME signatureIds as prod:
docker logs kms-restore-test | grep "for wallets"
docker rm -f kms-restore-test
```

Observed: a fresh container booted the backup and polled all six
signatureIds identical to production. **Two secrets are required to
restore: the file AND TATUM_KMS_PASSWORD — back up both, separately,
encrypted.** Either alone is useless; both together are total custody.

### Treasury gas starvation — seen live 2026-10-04

KMS signed a POL send that then failed broadcast:
`insufficient funds for gas * price + value`. The wallet ledger said
POL balance 0.05 while the on-chain treasury had 0.0073 — gas spend
isn't a ledger event, so treasury native balance drifts BELOW ledger
total. On mainnet this wedges every EVM send until refilled.

- Check: `GET /v3/{chain}/address/balance/{treasury}` vs the sum of
  ledger balances + expected gas buffer.
- Production control needed: treasury gas-floor alert (reconciler
  should compare custodied-vs-onchain native balance, not just tokens).
- Testnet: refill from the Amoy/Sepolia faucets.

## 5. Sweep failures

`POST /api/v1/admin/sweep` (admin key). Known causes seen live:

- "Fee is too small / amount < balance" — fee estimation failed and the
  sweep tried to send the full UTXO. Check `/v3/blockchain/fee/<CODE>`
  is reachable; the provider falls back to 10 sats/byte if it 400s.
- Verify 404 on the KMS request — sweep tx row missing. Should be
  impossible (sweeps persist rows first); if seen, report as a bug.
- UTXO change must return to the deposit address — check the tx on an
  explorer; a missing change output means the fee-burn bug regressed.

## 6. Provider / network outages

Docker→Tatum connectivity flaps observed repeatedly on this host
(`ETIMEDOUT`/`ENETUNREACH` bursts, ~1s RTT when up).

- Blast radius: polling misses cycles (deposits delayed, not lost);
  sends fail and reverse cleanly; KMS status checks retry.
- `docker restart bitlily-crypto-service-api-1` restored egress every
  time so far. Root cause unresolved — likely Docker NAT/IPv6; track as
  an infra ticket, not app code.
- During Tatum-side outages: everything queues safely; nothing should
  require manual ledger edits. Re-run reconcile after recovery.

## 7. Manual reconciliation procedure

Only when the reconciler flags divergence or a placeholder row persists:

1. Freeze: disable withdrawals at the edge or set
   `WITHDRAWAL_LIMITS={"*":"0"}` and restart.
2. Read the three numbers from the reconciler log:
   `custodied / inflight / liabilities`.
3. For each suspect tx: verify on a PUBLIC explorer, not Tatum.
4. If funds moved on-chain without a ledger record → post the missing
   entry with a `manual_adjustment` kind + reference to the incident.
   If ledger credited without funds → `deposit_reversal` style entry.
   Both directions require second-operator sign-off.
5. File the root cause before closing the incident.

## 8. Key material & secrets

- `TATUM_API_KEY`, `SERVICE_API_KEYS`, `ADMIN_API_KEYS`,
  `WEBHOOK_SIGNING_SECRET`, `KMS_VERIFY_TOKEN` in `.env` — rotate on a
  schedule; service keys rotated via env + rolling restart.
- Private keys must never appear in the service under
  `TATUM_USE_KMS=true` — provider code refuses env-key sends when KMS
  is on (regression test pins this).
- `TESTNET_PK_*`/`TESTNET_FROM_*` envs exist for dev only — never set
  them in production compose.

## 9. Tatum chain-code quirks (institutional memory)

The provider isolates all of these; if Tatum changes an enum, grep
`TatumProvider` logs for `validation.failed`:

- Polygon chain code is `MATIC` everywhere (path `polygon`, enum `MATIC`)
- Fee endpoint accepts only `ETH|BTC|LTC|DOGE` codes
- Token balance/transaction routes are unified:
  `/v3/blockchain/token/{balance|transaction}`
- TRON: `/v3/tron/account/{addr}`; testnet is **Shasta** (not Nile)
- SOL: no block-height endpoint (confirmations = finalized-at-index);
  SPL balances return UI units, EVM returns base units
- KMS txids arrive as string/object/JSON-string — always unwrap

## 10. Solana shared-address deposits (memo attribution)

- **Tatum has no SOL address-history surface** — signature discovery and
  tx detail both go to `SOLANA_RPC_URL` (canonical RPC). Tatum is only a
  degraded fallback for tx detail during RPC outages.
- Native SOL: `getSignaturesForAddress(shared base)`. SPL: deposits land
  on the wallet's **associated token account**, not the base — the scan
  resolves the owner's ATAs via `getTokenAccountsByOwner` filtered by the
  TOKEN PROGRAM (not `{mint}` — a mint param the RPC can't unpack hard-
  errors), then scans each ATA's signatures and filters by mint locally.
- Legacy shared-base inbounds attributed by the wallet's memo
  (`bl-xxxxxxxx`); the shared model is retired — stray sends to the old
  address sit in treasury undetected. Wallet-less flagged rows surface on
  `GET /api/v1/admin/deposits/unattributed` — **no credit endpoint exists**;
  resolution is deliberate off-API accounting after verifying the depositor.
  Never re-derive ownership from amount/timing — the code doesn't, don't
  do it manually either.
- Outbound txs on the base (sweeps, ops sends) net ≤0 to the base and are
  re-checked harmlessly each cycle; they never create rows.
- Testnet quirk: `enabledAssets()` returns raw registry contracts — only
  `getAsset()` applies the `testnetContract` swap. Any new SPL scan code
  must resolve assets through `getAsset` or it filters on the mainnet mint.
- Public `api.devnet.solana.com` is rate-limited and flaky — fine for
  staging; **production needs a dedicated `SOLANA_RPC_URL`**.
