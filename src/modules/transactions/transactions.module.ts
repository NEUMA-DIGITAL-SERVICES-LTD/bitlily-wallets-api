import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Transaction } from '../../database/entities/transaction.entity';
import { Wallet } from '../../database/entities/wallet.entity';
import { WalletAccount } from '../../database/entities/wallet-account.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { TransactionsController, WithdrawalsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transaction, Wallet, WalletAccount]),
    NotificationsModule,
  ],
  controllers: [WithdrawalsController, TransactionsController],
  providers: [TransactionsService],
  exports: [TransactionsService],
})
export class TransactionsModule {}
