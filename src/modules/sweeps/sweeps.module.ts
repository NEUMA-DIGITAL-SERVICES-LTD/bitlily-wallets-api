import { Body, Controller, Module, Post, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IsNotEmpty, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DepositAddress } from '../../database/entities/deposit-address.entity';
import { CustodyAccount } from '../../database/entities/custody-account.entity';
import { Transaction } from '../../database/entities/transaction.entity';
import { AddressPool } from '../../database/entities/address-pool.entity';
import { AdminKeyGuard } from '../../common/admin-key.guard';
import { SweepService } from './sweep.service';
import { SweepSchedulerService } from './sweep-scheduler.service';
import { NotificationsModule } from '../notifications/notifications.module';

class SweepDto {
  @ApiProperty({ description: 'Deposit-address row id to sweep' })
  @IsUUID()
  @IsNotEmpty()
  depositAddressId: string;
}

class GasTopUpDto {
  @ApiProperty({ description: 'Deposit address that lacked native gas' })
  toAddress: string;

  @ApiProperty({ description: 'Native asset sent, e.g. SOL, ETH' })
  asset: string;

  @ApiProperty({ description: 'Amount sent, decimal string' })
  amount: string;

  @ApiProperty({ description: 'Why the sweep deferred — the token cannot move until this top-up confirms' })
  reason: string;
}

export class SweepResultDto {
  @ApiProperty({ type: [String], description: 'Broadcast txids — gas top-up (if any) plus the sweep itself' })
  txids: string[];

  @ApiProperty({ type: [String], description: 'KMS request ids pending daemon signature' })
  pendingKms: string[];

  @ApiPropertyOptional({ description: 'Amount moved, decimal string' })
  amount?: string;

  @ApiPropertyOptional({
    type: GasTopUpDto,
    description:
      'Set when the sweep deferred for a gas top-up — the token did NOT ' +
      'move yet. Call again once the top-up confirms on-chain.',
  })
  gasTopUp?: GasTopUpDto;
}

@ApiTags('admin')
@ApiSecurity({ 'x-api-key': [], 'x-admin-key': [] })
@UseGuards(AdminKeyGuard)
@Controller('api/v1/admin')
export class SweepController {
  constructor(private readonly sweeps: SweepService) {}

  @Post('sweep')
  @ApiOperation({
    summary:
      'Sweep a deposit address to treasury — KMS-signed. Token sweeps on ' +
      'gas-hungry chains (EVM ERC-20, SOL SPL) pump native gas from ' +
      'treasury first; call again after the top-up confirms to complete ' +
      'the sweep.',
  })
  @ApiOkResponse({ type: SweepResultDto })
  sweep(@Body() dto: SweepDto) {
    return this.sweeps.sweepAddress(dto.depositAddressId);
  }
}

@Module({
  imports: [
    TypeOrmModule.forFeature([DepositAddress, CustodyAccount, Transaction, AddressPool]),
    NotificationsModule,
  ],
  controllers: [SweepController],
  providers: [SweepService, SweepSchedulerService],
})
export class SweepsModule {}
