import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboundEvent } from '../../database/entities/outbound-event.entity';
import { Wallet } from '../../database/entities/wallet.entity';
import { NotifierService } from './notifier.service';

@Module({
  imports: [TypeOrmModule.forFeature([OutboundEvent, Wallet])],
  providers: [NotifierService],
  exports: [NotifierService],
})
export class NotificationsModule {}
