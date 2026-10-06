import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { WalletsService } from './wallets.service';
import { CreateWalletDto, GenerateAddressDto, WatchAddressDto } from './wallets.dto';

@ApiTags('wallets')
@ApiSecurity('x-api-key')
@Controller('api/v1/wallets')
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a wallet for a main-app user (idempotent)' })
  create(@Body() dto: CreateWalletDto, @Req() req: any) {
    return this.wallets.createWallet(dto.externalUserId, req.appId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get wallet with its per-asset accounts' })
  get(@Param('id') id: string, @Req() req: any) {
    return this.wallets.getWalletOrThrow(id, req.appId);
  }

  @Post(':id/addresses')
  @ApiOperation({
    summary: 'Generate a deposit address (optionally per-order via reference)',
  })
  generateAddress(@Param('id') id: string, @Body() dto: GenerateAddressDto, @Req() req: any) {
    return this.wallets.generateDepositAddress(
      id, req.appId, dto.asset, dto.reference, dto.expiresInMinutes,
    );
  }

  @Post(':id/watch')
  @ApiOperation({
    summary:
      'Re-watch an address for an asset — recovery for late payments to expired ' +
      'addresses and wrong-asset sends. Address must belong to this wallet.',
  })
  watchAddress(@Param('id') id: string, @Body() dto: WatchAddressDto, @Req() req: any) {
    return this.wallets.watchAddress(id, req.appId, dto.address, dto.asset, dto.expiresInMinutes);
  }

  @Get(':id/addresses')
  @ApiOperation({ summary: 'List deposit addresses for a wallet' })
  listAddresses(@Param('id') id: string, @Req() req: any) {
    return this.wallets.listAddresses(id, req.appId);
  }

  @Get(':id/balance')
  @ApiOperation({ summary: 'Ledger balances for all assets' })
  balance(@Param('id') id: string, @Req() req: any) {
    return this.wallets.getBalances(id, req.appId);
  }

  @Get(':id/transactions')
  @ApiOperation({ summary: 'Transaction history for a wallet' })
  transactions(@Param('id') id: string, @Req() req: any) {
    return this.wallets.getTransactions(id, req.appId);
  }
}
