import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID, Matches } from 'class-validator';

/**
 * Strict positive-decimal amount. IsNumberString allows '-5', '+5', '.5' —
 * a negative 'debit' posts to the ledger as a credit. This pattern admits
 * only unsigned decimals; the >0 check lives in the service.
 */
const POSITIVE_DECIMAL = /^\d+(\.\d{1,18})?$/;

export class SendTransactionDto {
  @ApiProperty({ description: 'Wallet the funds are drawn from' })
  @IsUUID()
  walletId: string;

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

  @ApiPropertyOptional({ description: 'Client reference echoed on the record' })
  @IsString()
  @IsOptional()
  reference?: string;

  @ApiPropertyOptional({
    description:
      'Idempotency key — retries with the same (walletId, key) return the ' +
      'original transaction instead of double-sending. REQUIRED in production.',
  })
  @IsString()
  @IsOptional()
  idempotencyKey?: string;
}

export class EstimateFeeQueryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  asset: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  toAddress: string;

  @ApiProperty()
  @Matches(POSITIVE_DECIMAL, { message: 'amount must be a positive decimal' })
  amount: string;
}
