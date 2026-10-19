import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/api-key.guard';

const DOC = `# Webhooks — How Bitlily Crypto Service Talks Back To You

You don't poll us for payment status. When something happens on-chain, we POST
to an endpoint you give us. This doc is everything you need to build that
endpoint.

## Where events go

Routing is **per-tenant**: each API client's \`webhookUrl\` + \`webhookSecret\`
(set at registration, rotatable via \`PATCH /admin/clients/{slug}\`) receives
that tenant's events — your deposits never reach another app's server.
Events with no wallet context (ops alerts) fall back to the global
\`MAIN_APP_WEBHOOK_URL\` / \`WEBHOOK_SIGNING_SECRET\` env channel.

Any path, any framework — the endpoint just needs to accept JSON and return a
2xx within 10 seconds.

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
    "fee": "1",
    "usdPrice": "0.335483",
    "usdValue": "1.677415",
    "priceSource": "tatum",
    "pricedAt": "2026-10-16T08:34:41.053Z",
    "status": "confirmed",
    "confirmations": 20,
    "reference": "order-123"
  }
}
\`\`\`

- \`reference\` is your dedupe key from the original send. It comes back
  untouched — this is how you match "which payment was this."
- \`transactionId\` is our internal ID for this deposit/withdrawal. Store it.
- \`amount\` is in crypto units (TRX, USDT, etc.) — we never send fiat. Your app
  owns the FX conversion for accounting.
- \`fee\` is the best-known network fee: the request-time estimate until the
  first on-chain sighting replaces it with the actual fee (native units).
- \`usdPrice\` / \`usdValue\` / \`priceSource\` / \`pricedAt\` are informational
  USD metadata stamped once at event time (\`tatum\` | \`coingecko\` | \`peg\`).
  They are explicit \`null\` when pricing is unavailable — never a blocker.
  **Informational only** — ledger truth is the token \`amount\`.

## The events you'll receive

| Event | Meaning |
|---|---|
| \`deposit.confirmed\` | Hit the required confirmations. **The only "safe to credit" signal.** |
| \`deposit.reorged\` | A confirmed deposit got dropped by a chain reorg. Reverse any credit you applied. |
| \`deposit.unattributed\` | Real funds on a shared address whose memo matched no wallet — ops queue, never auto-credited. |
| \`withdrawal.requires_approval\` | Over your approval threshold — held until admin approve/reject. |
| \`withdrawal.pending_signature\` | Queued on the KMS signer. |
| \`withdrawal.broadcast\` | On-chain now, \`txid\` attached. |
| \`withdrawal.confirmed\` | Fully settled. |
| \`withdrawal.failed\` | Failed — the amount was returned to the ledger automatically. |
| \`withdrawal.rejected\` | An admin rejected it — debit reversed. |
| \`withdrawal.reconcile_required\` | On-chain and ledger disagree — ops alert. |
| \`treasury.insufficient\` | Chain treasury can't cover a requested send — ops alert. |
| \`treasury.gas_low\` | The treasury can't cover gas — ops alert. |
| \`sweep.failed\` | Consolidating a deposit failed repeatedly — ops alert. |
| \`reconciliation.divergence\` | Ledger and chain disagree — ops alert. |

The two events that matter for your users: \`deposit.confirmed\` (money in,
credit them) and \`withdrawal.confirmed\` (money out, mark settled). Everything
else is either intermediate or an ops alert. Deposits do NOT emit a "seen,
unconfirmed" event — the poller/webhook only reports once attribution and
confirmation thresholds are met, so first sight for a deposit is
\`deposit.confirmed\` (or \`deposit.unattributed\` for ops).

## Verify it's really us — required, not optional

Every POST carries \`X-Webhook-Signature: sha256=<hmac>\`. Compute an
HMAC-SHA256 of the **raw request body** with YOUR client's \`webhookSecret\`
(rotate it via \`PATCH /admin/clients/{slug} {"rotate": true}\`; ops-channel
events use \`WEBHOOK_SIGNING_SECRET\`) and compare. If it doesn't match, drop
it — a forged deposit event is free money to an attacker.

\`\`\`
const crypto = require('crypto');
const expected = 'sha256=' +
  crypto.createHmac('sha256', YOUR_WEBHOOK_SECRET)
        .update(rawBody).digest('hex');
if (req.headers['x-webhook-signature'] !== expected) return res.sendStatus(401);
\`\`\`

Use the raw body, not a re-serialized object — JSON field order matters.

## Make it idempotent — also required

- The same event can arrive more than once. Dedupe on
  \`X-Webhook-Event-Id\` (unique per event) or \`transactionId\`.
- Return 2xx fast, process async. If your handler is slow and times out, we
  retry — and you'll see the event again.
- Events can arrive out of order. Check the \`status\` and \`confirmations\`
  fields instead of trusting arrival order.

## What happens if your endpoint is down

We retry up to **8 attempts** with exponential backoff (2ⁿ minutes: 2, 4, 8 …
128 min ≈ 4h). After that the event dead-letters and we get an alert — but your
endpoint never gets it. So: answer fast, dedupe aggressively, and monitor for
gaps. If you're unsure you missed events, \`GET /api/v1/transactions\` (filter
by \`status\`, \`direction\`, \`reference\`, \`txid\`) is the source of truth to
backfill from.

## The full flow, one line per step

1. You call \`POST /wallets\` once per user → get their permanent deposit
   addresses (one per chain — shared addresses carry \`memo\` +
   \`memoRequired: true\`, which the sender MUST attach).
2. Show the user the chain's deposit address (and memo when required).
3. User sends crypto to that address.
4. Confirmations hit → we POST \`deposit.confirmed\` → you credit the user.
   A memo-less send to a shared address lands in \`deposit.unattributed\`
   for ops — never auto-credited.
5. For payouts you call \`POST /withdrawals\` → we POST
   \`withdrawal.broadcast\` then \`withdrawal.confirmed\` (or
   \`withdrawal.failed\` with the debit reversed).
6. Addresses are permanent — reuse is the design; \`GET /wallets/{externalUserId}\`
   returns the same set on every call.
`;

@ApiTags('webhooks')
@Controller()
export class WebhookDocsController {
  @Public()
  @Get('webhook')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  @ApiProduces('text/markdown')
  @ApiOperation({
    summary:
      'Outbound webhook integration guide — event names, payload shape ' +
      '(incl. fee + USD fields), HMAC signature verification, retry ' +
      'semantics. Markdown document, not a JSON API.',
  })
  @ApiResponse({ status: 200, description: 'Markdown integration guide' })
  doc(): string {
    return DOC;
  }
}
