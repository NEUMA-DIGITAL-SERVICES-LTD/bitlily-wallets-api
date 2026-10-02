import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

export class CreateWalletDto {
  @ApiProperty({ description: 'The user ID in the main Bitlily application' })
  @IsString()
  @IsNotEmpty()
  externalUserId: string;
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
      'Minutes until this address expires (stops deposit polling). Omit for a reusable address.',
    default: 60,
  })
  @IsInt()
  @Min(1)
  @Max(10080)
  @IsOptional()
  expiresInMinutes?: number;
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

export class AssetParamDto {
  @IsString()
  @Matches(/^[A-Z0-9_]+$/)
  asset: string;
}
