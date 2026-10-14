# Bitlily Crypto Service — Client Demo Script

Everything below runs against the live staging deployment. Testnet funds
only — no real value moves. The point of each step is stated so you can
verify the claim yourself, not take our word for it.

```bash
# All three values are handed out per-demo, never committed. BASE is the
# current staging/tunnel URL, KEY is a tenant X-API-Key, WALLET an
# externalUserId under that tenant.
export BASE="<staging-url>"
export KEY="<tenant-api-key>"
export WALLET="<external-user-id>"
```

## 1. Service is alive (no auth)

```bash
curl $BASE/api/v1/health
# → {"status":"ok","ts":"..."}
curl $BASE/api/v1/ready
# → 200 when DB is reachable, 503 when it isn't (kill test: ask us to
#   stop Postgres on the call — watch it flip)
```

## 2. Interactive API docs

Open `$BASE/docs` in a browser — the full OpenAPI surface, every
endpoint try-able from the page with the `X-API-Key` header.

## 3. Your wallet (empty — deliberately)

```bash
curl $BASE/api/v1/wallets/$WALLET/balance -H "X-API-Key: $KEY"
# → [] — nothing pre-seeded. Balances only ever come from real
#   on-chain deposits; the ledger cannot mint money.
```

## 4. Generate a deposit address

```bash
curl -X POST $BASE/api/v1/wallets/$WALLET/addresses \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"asset":"TRX"}'
# → a real TRON address derived from the custody HD wallet.
#   Send testnet TRX to it from any Shasta/Nile faucet, or we'll send
#   5 TRX live on the call. Within ~2 min the poller detects it.
```

## 5. Watch it credit

```bash
curl $BASE/api/v1/wallets/$WALLET/transactions -H "X-API-Key: $KEY"
# → inbound tx appears 'pending', flips to 'confirmed' at 20 confs,
#   then the balance endpoint shows it. Deposits under the required
#   confirmations are never spendable early — a double-spend control.
```

## 6. Fee estimate + withdrawal (the money path)

```bash
curl "$BASE/api/v1/fees/estimate?asset=TRX&toAddress=TJRabPrwbZy45sbavfcjinPJC18kjpRTQ8&amount=5" \
  -H "X-API-Key: $KEY"

curl -X POST $BASE/api/v1/transactions \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d "{\"walletId\":\"$WALLET\",\"asset\":\"TRX\",\"toAddress\":\"TJRabPrwbZy45sbavfcjinPJC18kjpRTQ8\",\"amount\":\"1\"}"
```

What happens behind this call — the part worth buying:

- **Idempotent**: retry the same request — you get the original
  transaction back, not a second debit (`Idempotency-Key` header also
  supported)
- **KMS-signed**: no private key exists in this service. Signing happens
  in a separate daemon which first calls our verify URL — it refuses to
  sign anything we didn't originate
- **Auto-reversal**: if broadcast fails, the debit reverses into the
  ledger automatically

## 7. Try to break it (encouraged)

```bash
# Negative amount — rejected by three layers of validation
-d '{"walletId":"'$WALLET'","asset":"TRX","toAddress":"TJRabPrwbZy45sbavfcjinPJC18kjpRTQ8","amount":"-5"}'
# Bad address format — rejected before any debit
-d '{"walletId":"'$WALLET'","asset":"TRX","toAddress":"0xdeadbeef","amount":"1"}'
# Overspend — rejected; concurrent sends are row-locked, proven under
# a real two-request race during our testing
```

## Verify on-chain

Every txid returned resolves on the public testnet explorers:

- TRON: shasta.tronscan.org / nile.tronscan.org → paste txid
- Polygon: amoy.polygonscan.com
- Solana: explorer.solana.com?cluster=devnet
- LTC: blockexplorer.one litecoin-testnet
- BTC/ETH: standard testnet/sepolia explorers

Examples already on-chain from our testing: TRX `cfa00073d240b22922bbf4437d4be0a162ce376a73eeb5df34251648dba16c1c`,
SOL USDC `GnX3JB5F5WmeadxPWhgeprGqryB5WiGLEkS56QEZrHr8RsMVCwdREZ5fxFEBrwk4YQp1Qkj2w4PRMhPvCW8NPkT`,
Polygon USDC `0xf6f33f4d06415193c312640bd60dee3bbb3e7b04d82c6e9386d65224aae305d4`.

## What this demo deliberately cannot show

- `/admin/*` endpoints (custody enrollment, sweeps, reconciliation) —
  admin key withheld; the surface exists and is exercised in our tests
- Mainnet behavior — staging is testnet-verified; `docs/PRODUCTION_CHECKLIST.md`
  lists the remaining go-live items
- This URL is a temporary tunnel for the demo. Persistent staging is
  part of the milestone-3 hosting discussion.
