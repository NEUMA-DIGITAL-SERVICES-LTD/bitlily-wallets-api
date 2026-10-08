import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export class CreateWalletDto {
  @ApiProperty({ description: 'The user ID in the main Bitlily application' })
  @IsString()
  @IsNotEmpty()
  externalUserId: string;

  @ApiPropertyOptional({
    description:
      'Assets to provision PERMANENT deposit addresses for, e.g. ' +
      '["TRX","BTC"]. Idempotent per chain — first call derives, later ' +
      'calls return the same address. Same-chain assets (SOL+USDC_SOL) ' +
      'share one address. Omit to create the wallet only.',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  ensure?: string[];
}

export class WalletQueryDto {
  @ApiPropertyOptional({
    description:
      'Comma-separated sections to fold into the response: ' +
      'balances, addresses, transactions. Default: balances,addresses.',
    default: 'balances,addresses',
  })
  @IsString()
  @IsOptional()
  include?: string;

  @ApiPropertyOptional({ description: 'Transactions page size (when include=transactions)', default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  txLimit?: number;

  @ApiPropertyOptional({ description: 'Transactions page number, 1-based (when include=transactions)', default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  txPage?: number;
}

export class GenerateAddressDto {
  @ApiProperty({ description: 'Asset code, e.g. BTC, USDT_TRON' })
  @IsString()
  @IsNotEmpty()
  asset: string;

  @ApiPropertyOptional({
    description:
      'Client reference (order/invoice ID) for Selly-style per-payment addresses',
  })
  @IsString()
  @IsOptional()
  reference?: string;

  @ApiPropertyOptional({
    description:
      'Minutes until this address expires (stops deposit polling). Omit → service default (DEPOSIT_ADDRESS_TTL_MINUTES).',
    default: 60,
  })
  @IsInt()
  @Min(1)
  @Max(10080)
  @IsOptional()
  expiresInMinutes?: number;

  @ApiPropertyOptional({
    description:
      'Exchange-style deposit address: get-or-create the wallet\'s single ' +
      'permanent address for this chain — first call derives it, every ' +
      'later call returns the same address. For top-up UX; for per-order ' +
      'addresses, omit and use expiresInMinutes/reference instead.',
  })
  @IsBoolean()
  @IsOptional()
  persistent?: boolean;
}

export class WatchAddressDto {
  @ApiProperty({ description: 'The deposit address to (re)watch' })
  @IsString()
  @IsNotEmpty()
  address: string;

  @ApiProperty({ description: 'Asset code to watch for, e.g. BTC, USDC_ETH' })
  @IsString()
  @IsNotEmpty()
  asset: string;

  @ApiPropertyOptional({
    description: 'Minutes until the watch expires again. Omit for default TTL.',
    default: 60,
  })
  @IsInt()
  @Min(1)
  @Max(10080)
  @IsOptional()
  expiresInMinutes?: number;
}


