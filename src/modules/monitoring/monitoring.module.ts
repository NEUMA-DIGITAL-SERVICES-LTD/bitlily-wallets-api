import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DepositAddress } from '../../database/entities/deposit-address.entity';
import { Transaction } from '../../database/entities/transaction.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { DepositPollerService } from './deposit-poller.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([DepositAddress, Transaction]),
    NotificationsModule,
  ],
  providers: [DepositPollerService],
})
export class MonitoringModule {}
