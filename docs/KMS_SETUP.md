# Tatum KMS — Custody Host Setup & Operations

Tatum KMS is a self-hosted signing daemon. It holds mnemonics/private keys in
an AES-GCM-256-encrypted `wallet.dat`, polls Tatum's API for pending signature
requests, signs **locally**, and broadcasts. Keys never leave the host; this
service only ever sees `signatureId`s.

**Topology: KMS needs zero inbound ports.** Outbound HTTPS to `api.tatum.io`
and to this service's four-eye verify endpoint only.

## Architecture rule

- `generatemanagedwallet {chain}` → `{signatureId, xpub}` — one managed wallet
  per chain; all deposit addresses derive from that xpub by index.
- Chain-model exception — **SOL has no xpub**: enroll a pool of private-key
  signatureIds via `generatemanagedprivatekeybatch SOL {count}` instead.
- Tatum hard limit: **25,000 signatureIds per chain per API key.**

## 1. Host hardening

VM or dedicated container host owned by Bitlily. Minimal OS, SSH key-only with
IP allowlist, encrypted disk, nothing else co-resident. This box is the money.

## 2. `.env` for KMS

```
TATUM_API_KEY=<client's Tatum API key>
TATUM_KMS_PASSWORD=<strong random — client-generated, client-custodied>
```

Better: store the password in AWS Secrets Manager / Azure Key Vault / VGS and
use the corresponding `TATUM_KMS_*` vault env vars instead of plaintext.

## 3. Enroll managed wallets

```bash
docker run -it --env-file .env -v $HOME/.tatumrc:/home/node/.tatumrc \
  tatumio/tatum-kms generatemanagedwallet BTC
# repeat: LTC ETH MATIC TRON
docker run -it --env-file .env -v $HOME/.tatumrc:/home/node/.tatumrc \
  tatumio/tatum-kms generatemanagedprivatekeybatch SOL 100
```

Each `generatemanagedwallet` prints `{signatureId, xpub}` — register via
`POST /api/v1/admin/custody` (admin key required):

```json
{ "chain": "BTC", "xpub": "xpub...", "signatureId": "…", "treasuryAddress": "…" }
```

## 4. Run the daemon (four-eye is mandatory on mainnet)

```bash
docker run -d --env-file .env -v $HOME/.tatumrc:/home/node/.tatumrc \
  tatumio/tatum-kms daemon \
    --externalUrl=https://<service-host>/api/v1/kms/verify/<KMS_VERIFY_TOKEN> \
    --chain=BTC,LTC,ETH,MATIC,TRON,SOL --period=15
```

KMS GETs `{externalUrl}/{requestId}` before signing; the service returns 200
only when the request matches a withdrawal this service created. A forged
signing request is refused — this is what keeps a leaked Tatum API key from
becoming arbitrary signing power.

Note: KMS concatenates `{externalUrl}/{txId}` — the token must be a **path**
segment (as shown), not a query param.

## 5. Backup — the custody-critical step

`wallet.dat` + `TATUM_KMS_PASSWORD` **together** are the keys.

- Back up `wallet.dat` (`$HOME/.tatumrc/`) on a schedule.
- Store the password in a separate vault/location.
- Losing either alone destroys all funds; storing them together defeats the
  encryption. Document who holds what, and test restoration before mainnet.

## 6. Failure modes and responses

| Event | Effect | Response |
|---|---|---|
| KMS daemon down | Withdrawals accumulate as `pending` KMS requests | Restart daemon; requests resolve on next poll |
| Four-eye check unreachable | KMS skips signing (fail-closed) | Restore network/service; txs auto-retry each poll |
| KMS rejects a request | Service marks tx `failed` + posts `withdrawal_reversal` | Investigate — rejection means four-eye mismatch or missing signatureId |
| API key rate-limited | Signing stalls | Raise Tatum plan; increase `--period` |
| `wallet.dat` lost | Funds unrecoverable if no backup | Restore from backup; if none — keys are gone |

## Operator checklist for handover

- [ ] Host provisioned + hardened
- [ ] `wallet.dat` volume persisted + backup job verified by restore test
- [ ] Password in vault, NOT in repo/chat/env files on the service host
- [ ] Daemon running with `--externalUrl` pointed at this service
- [ ] Each chain enrolled via `/admin/custody` (SOL as key pool)
- [ ] One KMS-signed testnet withdrawal confirmed per chain before mainnet
