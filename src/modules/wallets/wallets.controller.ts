import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { WalletsService } from './wallets.service';
import { CreateWalletDto, WalletQueryDto } from './wallets.dto';
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
 *   GET  /wallets?externalUserId=   same view, by YOUR user id — pure read,
 *                   never creates (GET is a safe method).
 *
 *   GET  /wallets/:id?include=balances,addresses,transactions
 *                   aggregate read — include folds in ledger balances,
 *                   permanent addresses, and/or a paginated tx page
 *                   (chain=/asset= filters).
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
      'HD-derivable chain at once (first call mints, later calls reuse). ' +
      'Pass `ensure: ["TRX"]` to provision just those chains. Response ' +
      '`addresses` is always the wallet\'s full permanent set, one entry ' +
      'per address — same-chain assets list together under `assets`. ' +
      'Account-model chains (SOL: shared custody address, no per-user ' +
      'attribution) are only provisioned via explicit ensure.',
  })
  create(@Body() dto: CreateWalletDto, @Req() req: any) {
    return this.wallets.upsertWalletWithAddresses(dto.externalUserId, req.appId, dto.ensure);
  }

  @Get()
  @ApiOperation({
    summary:
      'Look a wallet up by YOUR user id (read-only — never creates). ' +
      'Same aggregate view as GET /wallets/:id; 404 until the wallet has ' +
      'been POSTed. Creation is deliberately POST-only: GET is a safe ' +
      'method that caches/prefetches may retry, so it must not mint ' +
      'addresses.',
  })
  @ApiQuery({ name: 'externalUserId', required: true, description: 'The user ID in YOUR application' })
  async findByExternalId(
    @Query('externalUserId') externalUserId: string,
    @Query() q: WalletQueryDto,
    @Req() req: any,
  ) {
    if (!externalUserId) {
      throw new BadRequestException('externalUserId query param is required');
    }
    const wallet = await this.wallets.findByExternalId(externalUserId, req.appId);
    return this.wallets.getWalletView(wallet.id, req.appId, q);
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
