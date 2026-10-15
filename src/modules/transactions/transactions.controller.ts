import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';
import { EstimateFeeQueryDto, ListTransactionsDto, SendTransactionDto } from './transactions.dto';
import { RequireScope } from '../../common/api-key.guard';

@ApiTags('withdrawals')
@ApiSecurity('x-api-key')
@Controller('api/v1')
export class WithdrawalsController {
  constructor(private readonly txs: TransactionsService) {}

  @RequireScope('wallet')
  @Post('withdrawals')
  @ApiOperation({
    summary:
      'Withdraw funds to an external address. `reference` (your payout/' +
      'order id) must be unique per send in your app — a repeat is ' +
      'rejected 409 with the existing transaction\'s id; fetch it via ' +
      'GET /transactions/{id} or the wallet\'s transactions view. The ' +
      'ledger-balance check applies unless your client has ' +
      'enforceBalance=false (your backend then owns solvency checks — ' +
      'e.g. fiat-funded withdrawals).',
  })
  send(@Body() dto: SendTransactionDto, @Req() req: any) {
    return this.txs.send(dto, req.appId, req.enforceBalance !== false);
  }
}

@ApiTags('transactions')
@ApiSecurity('x-api-key')
@Controller('api/v1')
export class TransactionsController {
  constructor(private readonly txs: TransactionsService) {}

  @RequireScope('wallet')
  @Get('transactions')
  @ApiOperation({
    summary:
      'List your app\'s transactions — deposits and withdrawals across ' +
      'all your users, newest first. Paginated (page/limit≤100); filter ' +
      'by direction, status, chain, asset, externalUserId, reference, ' +
      'txid. Internal consolidation (sweeps) never appears here.',
  })
  list(@Query() q: ListTransactionsDto, @Req() req: any) {
    return this.txs.listForApp(req.appId, q);
  }

  @RequireScope('wallet')
  @Get('transactions/:id')
  @ApiOperation({ summary: 'Get transaction status (deposits and withdrawals)' })
  get(@Param('id') id: string, @Req() req: any) {
    return this.txs.get(id, req.appId);
  }

  @Get('fees/estimate')
  @ApiOperation({ summary: 'Estimate network fee for a send' })
  estimateFee(@Query() q: EstimateFeeQueryDto) {
    return this.txs.estimateFee(q.asset, q.toAddress, q.amount);
  }
}
