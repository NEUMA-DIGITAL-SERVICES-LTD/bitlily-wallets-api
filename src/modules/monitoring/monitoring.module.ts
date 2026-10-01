import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DepositAddress } from '../../database/entities/deposit-address.entity';
import { Transaction } from '../../database/entities/transaction.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { DepositPollerService } from './deposit-poller.service';
import { OutboundStatusService } from './outbound-status.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([DepositAddress, Transaction]),
    NotificationsModule,
  ],
  providers: [DepositPollerService, OutboundStatusService],
})
export class MonitoringModule {}
