import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DepositAddress } from '../../database/entities/deposit-address.entity';
import { CustodyAccount } from '../../database/entities/custody-account.entity';
import { Transaction } from '../../database/entities/transaction.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { DepositPollerService } from './deposit-poller.service';
import { OutboundStatusService } from './outbound-status.service';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([DepositAddress, Transaction, CustodyAccount]),
    NotificationsModule,
  ],
  providers: [DepositPollerService, OutboundStatusService, ReconciliationService],
})
export class MonitoringModule {}
