import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LedgerEntry } from '../database/entities/ledger-entry.entity';
import { LedgerService } from './ledger.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([LedgerEntry])],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
