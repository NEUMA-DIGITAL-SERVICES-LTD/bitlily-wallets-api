import { Body, Controller, Get, Param, Post, BadRequestException, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CustodyAccount } from '../../database/entities/custody-account.entity';
import { TransactionsService } from '../transactions/transactions.service';
import { AdminKeyGuard } from '../../common/admin-key.guard';

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

  @ApiPropertyOptional({
    description:
      'REQUIRED to replace an existing signatureId — without it, a ' +
      're-enroll updates non-key fields only (protects against silent key ' +
      'rotation: a mismatched signatureId signs the wrong wallet).',
  })
  @IsBoolean()
  @IsOptional()
  rotate?: boolean;
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
@UseGuards(AdminKeyGuard)
@Controller('api/v1/admin')
export class AdminController {
  constructor(
    @InjectRepository(CustodyAccount)
    private readonly custody: Repository<CustodyAccount>,
    private readonly transactions: TransactionsService,
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
      if (existing.secretRef !== dto.signatureId && !dto.rotate) {
        throw new BadRequestException(
          `${chain} custody already enrolled with a different signatureId — ` +
          `pass rotate:true to replace it. Silent rotation would sign all ` +
          `future deposits with the WRONG wallet's keys.`,
        );
      }
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

  @Post('withdrawals/:id/approve')
  @ApiOperation({
    summary: 'Approve a parked requires_approval withdrawal — broadcasts it',
  })
  approve(@Param('id') id: string) {
    return this.transactions.approveWithdrawal(id);
  }

  @Post('withdrawals/:id/reject')
  @ApiOperation({
    summary: 'Reject a parked withdrawal — reverses the ledger debit',
  })
  reject(@Param('id') id: string) {
    return this.transactions.rejectWithdrawal(id);
  }
}
