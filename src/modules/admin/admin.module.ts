import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustodyAccount } from '../../database/entities/custody-account.entity';
import { Transaction } from '../../database/entities/transaction.entity';
import { AdminController } from './admin.controller';
import { KmsVerifyController } from './kms-verify.controller';
import { TransactionsModule } from '../transactions/transactions.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([CustodyAccount, Transaction]),
    TransactionsModule,
  ],
  controllers: [AdminController, KmsVerifyController],
})
export class AdminModule {}
