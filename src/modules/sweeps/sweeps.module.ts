import { Body, Controller, Module, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IsNotEmpty, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { DepositAddress } from '../../database/entities/deposit-address.entity';
import { CustodyAccount } from '../../database/entities/custody-account.entity';
import { Transaction } from '../../database/entities/transaction.entity';
import { AdminKeyGuard } from '../../common/admin-key.guard';
import { SweepService } from './sweep.service';

class SweepDto {
  @ApiProperty({ description: 'Deposit-address row id to sweep' })
  @IsUUID()
  @IsNotEmpty()
  depositAddressId: string;
}

@ApiTags('admin')
@ApiSecurity('x-api-key')
@UseGuards(AdminKeyGuard)
@Controller('api/v1/admin')
export class SweepController {
  constructor(private readonly sweeps: SweepService) {}

  @Post('sweep')
  @ApiOperation({
    summary:
      'Sweep a deposit address to treasury — KMS-signed. EVM tokens gas-pump ' +
      'first; call again after the top-up confirms to complete the sweep.',
  })
  sweep(@Body() dto: SweepDto) {
    return this.sweeps.sweepAddress(dto.depositAddressId);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([DepositAddress, CustodyAccount, Transaction])],
  controllers: [SweepController],
  providers: [SweepService],
})
export class SweepsModule {}
