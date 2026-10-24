import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { WalletsService } from './wallets.service';
import { CreateWalletDto, WalletQueryDto, WalletViewDto } from './wallets.dto';
import { RequireScope } from '../../common/api-key.guard';

/**
 * The wallet surface is deliberately small — the exchange-model lifecycle
 * in one write and one read:
 *
 *   POST /wallets   get-or-create by externalUserId AND provision permanent
 *                   deposit addresses: every HD chain when `ensure` is
 *                   omitted, just the listed chains when given. Always
 *                   returns the wallet's full permanent address set.
 *
 *   GET  /wallets/{externalUserId}?include=balances,addresses,transactions
 *                   aggregate read by YOUR user id — include folds in
 *                   ledger balances, permanent addresses, and/or a
 *                   paginated tx page. `chain` scopes the whole view;
 *                   asset=/reference= filter the tx page only.
 *                   Pure read — never creates (GET is a safe method).
 *
 * Address recovery (re-watch after expiry / wrong-asset sends) is ops
 * tooling, not client API — it lives at POST /admin/wallets/:id/watch.
 */
@ApiTags('wallets')
@ApiSecurity('x-api-key')
@RequireScope('wallet')
@Controller('api/v1/wallets')
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Post()
  @ApiOperation({
    summary:
      'Get-or-create a wallet for an app user (idempotent) and provision ' +
      'permanent deposit addresses. Omit `ensure` → addresses on every ' +
      'supported chain at once (first call mints, later calls reuse). ' +
      'Pass `ensure: ["TRX"]` to provision just those chains. Response ' +
      '`addresses` is always the wallet\'s full permanent set, one entry ' +
      'per address — same-chain assets list together under `assets`. ' +
      'Shared-custody rows carry `memo` + `memoRequired: true` — deposits ' +
      'must include that memo or they cannot be attributed. With ' +
      'SOL_UNIQUE_DEPOSITS enabled, SOL rows are unique per wallet and ' +
      'carry no memo fields.',
  })
  @ApiOkResponse({ type: WalletViewDto })
  create(@Body() dto: CreateWalletDto, @Req() req: any) {
    return this.wallets.upsertWalletWithAddresses(dto.externalUserId, req.appId, dto.ensure);
  }

  @Get(':externalUserId')
  @ApiOperation({
    summary:
      'Aggregate wallet read by YOUR user id — ?include=balances,' +
      'addresses,transactions folds sections in (default: ' +
      'balances,addresses). `chain` scopes addresses, balances, and ' +
      'transactions to one chain. Transactions paginate via ' +
      'txLimit/txPage and filter via asset/reference. ' +
      'Read-only — never creates.',
  })
  @ApiOkResponse({ type: WalletViewDto })
  async get(
    @Param('externalUserId') externalUserId: string,
    @Query() q: WalletQueryDto,
    @Req() req: any,
  ) {
    const wallet = await this.wallets.findByExternalId(externalUserId, req.appId);
    return this.wallets.getWalletView(wallet.id, req.appId, q);
  }
}
