import { Body, Controller, Get, Post, BadRequestException } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CustodyAccount } from '../../database/entities/custody-account.entity';

class EnrollCustodyDto {
  @ApiProperty({ description: 'Chain code, e.g. BTC, ETH, SOL' })
  @IsString()
  @IsNotEmpty()
  chain: string;

  @ApiPropertyOptional({ description: 'xpub from tatum-kms generatemanagedwallet' })
  @IsString()
  @IsOptional()
  xpub?: string;

  @ApiPropertyOptional({ description: 'Base address for account-model chains (SOL)' })
  @IsString()
  @IsOptional()
  baseAddress?: string;

  @ApiProperty({ description: 'KMS signatureId returned by generatemanagedwallet' })
  @IsString()
  @IsNotEmpty()
  signatureId: string;

  @ApiPropertyOptional({
    description: 'Sweep destination — defaults to the custody wallet index-0 address',
  })
  @IsString()
  @IsOptional()
  treasuryAddress?: string;
}

/**
 * Custody enrollment — ops-only endpoints registering the KMS master wallet
 * per chain. Flow: operator runs `tatum-kms generatemanagedwallet {chain}`
 * on the KMS host (mnemonic never leaves KMS), then posts the returned
 * xpub + signatureId here. Wallet creation under TATUM_USE_KMS fails
 * without a row.
 */
@ApiTags('admin')
@ApiSecurity('x-api-key')
@Controller('api/v1/admin')
export class AdminController {
  constructor(
    @InjectRepository(CustodyAccount)
    private readonly custody: Repository<CustodyAccount>,
  ) {}

  @Post('custody')
  @ApiOperation({
    summary: 'Enroll a KMS-managed wallet for a chain (xpub + signatureId)',
  })
  async enroll(@Body() dto: EnrollCustodyDto) {
    if (!dto.xpub && !dto.baseAddress) {
      throw new BadRequestException('xpub or baseAddress required');
    }
    const chain = dto.chain.toUpperCase();
    const existing = await this.custody.findOne({ where: { chain } });
    if (existing) {
      existing.xpub = dto.xpub ?? existing.xpub;
      existing.baseAddress = dto.baseAddress ?? existing.baseAddress;
      existing.secretRef = dto.signatureId;
      existing.treasuryAddress = dto.treasuryAddress ?? existing.treasuryAddress;
      return this.custody.save(existing);
    }
    return this.custody.save(
      this.custody.create({
        chain,
        xpub: dto.xpub ?? null,
        baseAddress: dto.baseAddress ?? null,
        secretRef: dto.signatureId,
        treasuryAddress: dto.treasuryAddress ?? null,
      }),
    );
  }

  @Get('custody')
  @ApiOperation({ summary: 'List enrolled custody wallets per chain' })
  list() {
    return this.custody.find();
  }
}
