import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';
import { EstimateFeeQueryDto, SendTransactionDto } from './transactions.dto';

@ApiTags('transactions')
@ApiSecurity('x-api-key')
@Controller('api/v1')
export class TransactionsController {
  constructor(private readonly txs: TransactionsService) {}

  @Post('transactions')
  @ApiOperation({ summary: 'Send a blockchain transaction (withdrawal)' })
  send(@Body() dto: SendTransactionDto) {
    return this.txs.send(dto);
  }

  @Get('transactions/:id')
  @ApiOperation({ summary: 'Get transaction status' })
  get(@Param('id') id: string) {
    return this.txs.get(id);
  }

  @Get('fees/estimate')
  @ApiOperation({ summary: 'Estimate network fee for a send' })
  estimateFee(@Query() q: EstimateFeeQueryDto) {
    return this.txs.estimateFee(q.asset, q.toAddress, q.amount);
  }
}
