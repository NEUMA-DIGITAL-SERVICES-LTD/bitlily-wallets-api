# KMS for Integrators — what actually signs your withdrawals

If you only integrate the API, read this page. If you operate the custody
host, read `KMS_SETUP.md` instead.

## The 30-second mental model

The API **never holds private keys**. Signing happens on a separate box
running **Tatum KMS** — a daemon that owns an encrypted `wallet.dat`,
polls Tatum's pending-request queue, signs locally, and broadcasts.

```
Your app → API → Tatum creates a signature request → returns signatureId
                                                        ↓
                         KMS daemon polls queue → signs locally → broadcasts
```

Consequences that matter to you:

- The API response `signatureId` is a *reference to* a key, not a key.
- A withdrawal can succeed at `POST` and still wait for the KMS daemon —
  `status: pending_signature` means "queued for the signer," not an error.
- If the daemon is down, sends **queue, they don't fail** — they resolve
  when it comes back. That's the designed behavior, not a stuck bug.
- Nothing you call exposes keys, mnemonics, or `wallet.dat`. You will never
  see them in a payload, and that's the point.

## The four-eye check (why a leaked API key can't sign)

Before signing, KMS asks *this* service: "did you really create request X?"
(`--externalUrl` → `GET /api/v1/kms/verify/...`). A forged request is
refused — so the Tatum API key alone is not signing power. Keep that
endpoint reachable or signing stops (fail-closed, by design).

## When a withdrawal stalls at `pending_signature`

In order:

1. **Is the KMS daemon running?** — its own logs; signing is the only thing
   it does.
2. **Ask the service about the request:**
   `GET /api/v1/kms/verify/{requestId}` (admin) — inspects the pending
   KMS request. The service also logs an error itself after ~10 minutes.
3. **Dashboard:** Tatum dashboard → API logs. Rejected or expired requests
   show there; our service marks a rejected request `failed` and posts a
   `withdrawal_reversal` — you'll get the `withdrawal.failed` webhook too.

## The Tatum dashboard, in three stops

You mostly won't need it — the API surfaces tx state directly — but for
ops lookups:

| Where | What for |
|---|---|
| **API logs / request history** | Every Tatum call we made — the `dashboardLog` URLs in our container errors deep-link here. First stop for provider-side failures (403/429/5xx). |
| **Wallets (custodial)** | The managed wallets behind `signatureId`s — one per chain (SOL: a private-key pool, not xpub-derived). |
| **Subscriptions / webhooks** | Address-activity subscriptions feeding `POST /api/v1/webhooks/tatum` — if deposits stop arriving, check these point at the live ingress URL, not a dead tunnel. |

## What you will NOT find in the dashboard

- **Private keys** — they're in `wallet.dat` on the KMS host, encrypted with
  `TATUM_KMS_PASSWORD`. Dashboard only ever sees `signatureId`s.
- **Your users' balances** — that's this service's ledger, not Tatum's.
  Tatum knows addresses; it doesn't know your `externalUserId`s.
- **Deposit attribution** — memos, pooled addresses, and the
  `unattributed` ops queue are all service-side concepts.

## Handover inventory (what the client actually owns)

- The **Tatum account + API key** — plan tier gates subscriptions and rate.
- The **`wallet.dat` + `TATUM_KMS_PASSWORD`** pair — together = the money.
  Stored separately, backed up, restore-tested before mainnet.
- The **KMS host** — one daemon, zero inbound ports, outbound HTTPS only.
- **This service's env** — DB, admin keys, webhook secrets, limits.

For the full host-hardening and enrollment procedure: `KMS_SETUP.md`.
