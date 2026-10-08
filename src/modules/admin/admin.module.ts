import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustodyAccount } from '../../database/entities/custody-account.entity';
import { Transaction } from '../../database/entities/transaction.entity';
import { Wallet } from '../../database/entities/wallet.entity';
import { AdminController } from './admin.controller';
import { KmsVerifyController } from './kms-verify.controller';
import { TransactionsModule } from '../transactions/transactions.module';
import { WalletsModule } from '../wallets/wallets.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([CustodyAccount, Transaction, Wallet]),
    TransactionsModule,
    WalletsModule,
  ],
  controllers: [AdminController, KmsVerifyController],
})
export class AdminModule {}
