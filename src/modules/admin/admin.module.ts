import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustodyAccount } from '../../database/entities/custody-account.entity';
import { Transaction } from '../../database/entities/transaction.entity';
import { AdminController } from './admin.controller';
import { KmsVerifyController } from './kms-verify.controller';

@Module({
  imports: [TypeOrmModule.forFeature([CustodyAccount, Transaction])],
  controllers: [AdminController, KmsVerifyController],
})
export class AdminModule {}
