import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../../common/api-key.guard';

const DOC = `# Webhooks — How Bitlily Crypto Service Talks Back To You

You don't poll us for payment status. When something happens on-chain, we POST
to an endpoint you give us. This doc is everything you need to build that
endpoint.

## The one thing you give us

A single \`POST\` URL on your side, set as \`MAIN_APP_WEBHOOK_URL\`. Any path,
any framework — it just needs to accept JSON and return a 2xx within 10 seconds.

## What we send

Every event is a JSON POST:

\`\`\`json
{
  "event": "deposit.confirmed",
  "data": {
    "transactionId": "…",
    "walletId": "…",
    "direction": "inbound",
    "asset": "TRX",
    "chain": "TRON",
    "txid": "cfa00073…",
    "address": "T…",
    "amount": "5",
    "status": "confirmed",
    "confirmations": 20,
    "reference": "order-123"
  }
}
\`\`\`

- \`reference\` is the order/invoice ID you set when generating the deposit
  address. It comes back to you untouched — this is how you match "which payment
  was this."
- \`transactionId\` is our internal ID for this deposit/withdrawal. Store it.
- \`amount\` is in crypto units (TRX, USDT, etc.) — we never send fiat. Your app
  owns the FX conversion.

## The events you'll receive

| Event | Meaning |
|---|---|
| \`deposit.pending\` | Seen on-chain, waiting for confirmations. Informational — do NOT credit yet. |
| \`deposit.confirmed\` | Hit the required confirmations. **This is the only "safe to credit" signal.** |
| \`deposit.reorged\` | A confirmed deposit got dropped by a chain reorg. Reverse any credit you applied. |
| \`withdrawal.pending_signature\` | Queued, waiting on the signer. |
| \`withdrawal.broadcast\` | On-chain now, \`txid\` attached. |
| \`withdrawal.confirmed\` | Fully settled. |
| \`withdrawal.failed\` | Failed — the amount was returned to the ledger automatically. |
| \`withdrawal.requires_approval\` | Over your approval threshold — held for a human. |
| \`withdrawal.rejected\` | An admin rejected it. |
| \`withdrawal.reconcile_required\` | On-chain and ledger disagree — ops alert. |
| \`treasury.gas_low\` | The treasury can't cover gas — ops alert. |
| \`sweep.failed\` | Consolidating a deposit failed repeatedly — ops alert. |
| \`reconciliation.divergence\` | Ledger and chain disagree — ops alert. |

The two events that matter for your users: \`deposit.confirmed\` (money in,
credit them) and \`withdrawal.confirmed\` (money out, mark settled). Everything
else is either intermediate or an ops alert.

## Verify it's really us — required, not optional

Every POST carries \`X-Webhook-Signature: sha256=<hmac>\`. Compute an
HMAC-SHA256 of the **raw request body** with \`WEBHOOK_SIGNING_SECRET\` and
compare. If it doesn't match, drop it — a forged deposit event is free money to
an attacker.

\`\`\`
const crypto = require('crypto');
const expected = 'sha256=' +
  crypto.createHmac('sha256', WEBHOOK_SIGNING_SECRET)
        .update(rawBody).digest('hex');
if (req.headers['x-webhook-signature'] !== expected) return res.sendStatus(401);
\`\`\`

Use the raw body, not a re-serialized object — JSON field order matters.

## Make it idempotent — also required

- The same event can arrive more than once. Dedupe on
  \`X-Webhook-Event-Id\` (unique per event) or \`transactionId\`.
- Return 2xx fast, process async. If your handler is slow and times out, we
  retry — and you'll see the event again.
- Events can arrive out of order. Don't assume \`pending\` before
  \`confirmed\` — check the \`status\` and \`confirmations\` fields instead of
  trusting arrival order.

## What happens if your endpoint is down

We retry up to **8 times** with exponential backoff (2, 4, 8 … 128 minutes).
After that the event dead-letters and we get an alert — but your endpoint never
gets it. So: answer fast, dedupe aggressively, and monitor for gaps. If you're
unsure you missed events, \`GET /api/v1/wallets/{id}/transactions\` is the
source of truth to backfill from.

## The full flow, one line per step

1. You call \`POST /wallets\` once per user → get a \`walletId\` (store it).
2. For each payment, \`POST /wallets/{id}/addresses\` with your order ID as
   \`reference\` → show the returned address to the user.
3. User sends crypto to that address.
4. We POST \`deposit.pending\` to you — show "payment seen, confirming."
5. Confirmations hit → we POST \`deposit.confirmed\` → you credit the user.
6. Done. The address expires on its own; you never reuse it for another order.
`;

@Controller()
export class WebhookDocsController {
  @Public()
  @Get('webhook')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  doc(): string {
    return DOC;
  }
}
