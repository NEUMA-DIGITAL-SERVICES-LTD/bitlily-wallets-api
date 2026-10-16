import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboundEvent } from '../../database/entities/outbound-event.entity';
import { Wallet } from '../../database/entities/wallet.entity';
import { NotifierService } from './notifier.service';
import { PriceService } from '../../common/price.service';

@Module({
  imports: [TypeOrmModule.forFeature([OutboundEvent, Wallet])],
  providers: [NotifierService, PriceService],
  exports: [NotifierService],
})
export class NotificationsModule {}
