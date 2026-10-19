import { Body, Controller, Module, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IsNotEmpty, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
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
