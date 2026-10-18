import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Strict positive-decimal amount. IsNumberString allows '-5', '+5', '.5' —
 * a negative 'debit' posts to the ledger as a credit. This pattern admits
 * only unsigned decimals; the >0 check lives in the service.
 */
const POSITIVE_DECIMAL = /^\d+(\.\d{1,18})?$/;

export class SendTransactionDto {
  @ApiPropertyOptional({
    description:
      'The user ID in YOUR application — funds are debited from that ' +
      'user\'s wallet (ledger attribution + tenant scoping). OMIT for an ' +
      'app-level treasury draw: the debit lands on your app\'s internal ' +
      '__app_level__ wallet, auto-provisioned on first use. An explicit ' +
      'id still requires the wallet to exist (404 on unknown user).',
  })
  @IsString()
  @IsOptional()
  externalUserId?: string;

  @ApiProperty({ description: 'Asset code, e.g. BTC, USDT_TRON' })
  @IsString()
  @IsNotEmpty()
  asset: string;

  @ApiProperty({ description: 'Destination blockchain address' })
  @IsString()
  @IsNotEmpty()
  toAddress: string;

  @ApiProperty({ description: 'Amount in human units (e.g. "0.05")' })
  @Matches(POSITIVE_DECIMAL, { message: 'amount must be a positive decimal' })
  amount: string;

  @ApiPropertyOptional({
    description:
      'Your dedupe key (order/payout id) — echoed on the record AND the ' +
      'uniqueness boundary: unique per outbound send within your app, and ' +
      'CONSUMED on use. ANY repeated reference is rejected 409 — same ' +
      'payload or different; this API never returns an old send as if it ' +
      'were new. After a timeout/409, recover the original via ' +
      'GET /transactions?reference=. Omit it and every call sends fresh. ' +
      'REQUIRED in production.',
  })
  @IsString()
  @MaxLength(128)
  @IsOptional()
  reference?: string;
}

const TX_DIRECTIONS = ['inbound', 'outbound'] as const;
const TX_STATUSES = [
  'pending', 'confirmed', 'failed', 'reorged', 'requires_approval', 'rejected',
] as const;

/** Query filters for GET /transactions — the app-wide, tenant-scoped feed. */
export class ListTransactionsDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({ enum: TX_DIRECTIONS })
  @IsIn([...TX_DIRECTIONS])
  @IsOptional()
  direction?: 'inbound' | 'outbound';

  @ApiPropertyOptional({ enum: TX_STATUSES })
  @IsIn([...TX_STATUSES])
  @IsOptional()
  status?: string;

  @ApiPropertyOptional({ description: 'Chain code, e.g. TRON, ETH — native + its tokens' })
  @IsString()
  @IsOptional()
  chain?: string;

  @ApiPropertyOptional({ description: 'Exact asset code, e.g. USDT_TRON' })
  @IsString()
  @IsOptional()
  asset?: string;

  @ApiPropertyOptional({ description: 'Your user ID — narrows to one wallet' })
  @IsString()
  @IsOptional()
  externalUserId?: string;

  @ApiPropertyOptional({ description: 'Your send/lookup reference' })
  @IsString()
  @IsOptional()
  reference?: string;

  @ApiPropertyOptional({ description: 'On-chain transaction hash' })
  @IsString()
  @IsOptional()
  txid?: string;
}

export class EstimateFeeQueryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  asset: string;

  @ApiPropertyOptional({
    description:
      'Destination address — optional. With it, the estimate prices the ' +
      'real send (UTXO output count, destination-aware gas). Without it, ' +
      'a typical-transfer estimate is returned. Malformed values are ' +
      'rejected 400; use GET /addresses/validate to pre-check.',
  })
  @IsString()
  @IsOptional()
  toAddress?: string;

  @ApiProperty()
  @Matches(POSITIVE_DECIMAL, { message: 'amount must be a positive decimal' })
  amount: string;
}
