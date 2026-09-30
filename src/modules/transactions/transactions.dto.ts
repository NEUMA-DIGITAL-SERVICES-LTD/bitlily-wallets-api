import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumberString, IsOptional, IsString, IsUUID } from 'class-validator';

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
  @IsNumberString()
  amount: string;

  @ApiPropertyOptional({ description: 'Client reference echoed on the record' })
  @IsString()
  @IsOptional()
  reference?: string;
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
  @IsNumberString()
  amount: string;
}
