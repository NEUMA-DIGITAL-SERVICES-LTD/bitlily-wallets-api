import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { WalletsService } from './wallets.service';
import { CreateWalletDto, WalletQueryDto } from './wallets.dto';
import { RequireScope } from '../../common/api-key.guard';

/**
 * The wallet surface is deliberately TWO routes — the exchange-model
 * lifecycle in one write and one aggregate read:
 *
 *   POST /wallets   get-or-create by externalUserId; `ensure` provisions
 *                   permanent per-chain deposit addresses in the same call
 *                   (first touch on a chain derives, later calls reuse).
 *
 *   GET  /wallets/:id?include=balances,addresses,transactions
 *                   aggregate read — include folds in ledger balances,
 *                   deposit addresses, and/or a paginated tx page.
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
      'Get-or-create a wallet for an app user (idempotent). Optional ' +
      '`ensure` provisions permanent per-chain deposit addresses in the ' +
      'same call — repeat calls return the same addresses.',
  })
  async create(@Body() dto: CreateWalletDto, @Req() req: any) {
    const wallet = await this.wallets.createWallet(dto.externalUserId, req.appId);
    const addresses = dto.ensure?.length
      ? await this.wallets.ensureDepositAddresses(wallet.id, req.appId, dto.ensure)
      : [];
    return { ...wallet, addresses };
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Aggregate wallet read — ?include=balances,addresses,transactions ' +
      'folds sections in (default: balances,addresses). Transactions are ' +
      'paginated via txLimit/txPage and filterable via chain/asset.',
  })
  get(@Param('id') id: string, @Query() q: WalletQueryDto, @Req() req: any) {
    return this.wallets.getWalletView(id, req.appId, q);
  }
}
