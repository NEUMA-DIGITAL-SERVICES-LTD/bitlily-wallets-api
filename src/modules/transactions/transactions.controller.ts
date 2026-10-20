import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';
import {
  EstimateFeeQueryDto,
  FeeEstimateViewDto,
  ListTransactionsDto,
  SendTransactionDto,
  TransactionListViewDto,
  TransactionViewDto,
  ValidateAddressViewDto,
} from './transactions.dto';
import { RequireScope } from '../../common/api-key.guard';
import { ErrorResponseDto } from '../../common/error-response.dto';

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
  @ApiCreatedResponse({
    type: TransactionViewDto,
    description:
      'Send created — check `status`: `pending`/`pending_signature` means ' +
      'broadcasting; `requires_approval` means the amount crossed the ' +
      'configured approval threshold — the debit already posted but nothing ' +
      'broadcasts until an admin approves or rejects it.',
  })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'Malformed address/amount, over-limit, or insufficient balance (enforce tenants)',
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Unknown externalUserId' })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'reference already used — fetch the original via GET /transactions?reference=' })
  @ApiResponse({ status: 502, type: ErrorResponseDto, description: 'Broadcast failed — debit reversed' })
  @ApiResponse({ status: 503, type: ErrorResponseDto, description: 'Chain treasury cannot cover amount+fee' })
  send(@Body() dto: SendTransactionDto, @Req() req: any) {
    return this.txs.send(dto, req.appId, req.enforceBalance !== false)
      .then((tx) => this.txs.toView(tx));
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
  @ApiOkResponse({ type: TransactionListViewDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto, description: 'Unknown chain/asset filter' })
  list(@Query() q: ListTransactionsDto, @Req() req: any) {
    return this.txs.listForApp(req.appId, q);
  }

  @RequireScope('wallet')
  @Get('transactions/:id')
  @ApiOperation({ summary: 'Get transaction status (deposits and withdrawals)' })
  @ApiOkResponse({ type: TransactionViewDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id') id: string, @Req() req: any) {
    return this.txs.get(id, req.appId).then((tx) => this.txs.toView(tx));
  }

  @Get('fees/estimate')
  @ApiOperation({
    summary:
      'Estimate network fee for a send. `toAddress` is optional — pass it ' +
      'for a destination-priced quote, omit it for a typical-transfer ' +
      'estimate.',
  })
  @ApiOkResponse({ type: FeeEstimateViewDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto, description: 'Unknown asset or malformed toAddress' })
  estimateFee(@Query() q: EstimateFeeQueryDto) {
    return this.txs.estimateFee(q.asset, q.toAddress, q.amount);
  }

  @Get('addresses/validate')
  @ApiOperation({
    summary:
      'Check an address format before submitting a send — same gate POST ' +
      '/withdrawals applies. Pass `asset` (USDT_TRON → TRON) or `chain` — ' +
      'one of the two required, asset preferred. Returns {chain, address, ' +
      'valid}. Charset/length/prefix only — checksum-valid-but-wrong ' +
      'destinations are the sender\'s responsibility.',
  })
  @ApiQuery({ name: 'address', required: true, description: 'The address to check' })
  @ApiQuery({
    name: 'asset',
    required: false,
    description: 'Asset code — resolves its chain (USDT_TRON → TRON). One of asset/chain required.',
  })
  @ApiQuery({
    name: 'chain',
    required: false,
    description: 'Raw chain code (BTC, LTC, ETH, POLYGON, SOL, TRON). One of asset/chain required.',
  })
  @ApiOkResponse({ type: ValidateAddressViewDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto, description: 'Missing address, or neither asset nor chain passed / unknown' })
  validateAddress(
    @Query('address') address: string,
    @Query('asset') asset?: string,
    @Query('chain') chain?: string,
  ) {
    if (!address) throw new BadRequestException('address is required');
    return this.txs.validateAddress(address, { asset, chain });
  }
}
