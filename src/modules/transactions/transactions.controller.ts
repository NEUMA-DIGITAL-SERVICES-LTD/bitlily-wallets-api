import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';
import { EstimateFeeQueryDto, SendTransactionDto } from './transactions.dto';
import { RequireScope } from '../../common/api-key.guard';

@ApiTags('withdrawals')
@ApiSecurity('x-api-key')
@Controller('api/v1')
export class TransactionsController {
  constructor(private readonly txs: TransactionsService) {}

  @RequireScope('wallet')
  @Post('withdrawals')
  @ApiOperation({
    summary:
      'Withdraw funds to an external address. `reference` (your payout/' +
      'order id) is the idempotency key — same reference + same payload ' +
      'returns the original transaction; same reference + different ' +
      'payload is rejected 409.',
  })
  send(@Body() dto: SendTransactionDto, @Req() req: any) {
    return this.txs.send(dto, req.appId);
  }

  @RequireScope('wallet')
  @Get('transactions/:id')
  @ApiTags('transactions')
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
