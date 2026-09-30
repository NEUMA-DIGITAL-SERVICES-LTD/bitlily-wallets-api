import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

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
}

export class AssetParamDto {
  @IsString()
  @Matches(/^[A-Z0-9_]+$/)
  asset: string;
}
