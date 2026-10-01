import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboundEvent } from '../../database/entities/outbound-event.entity';
import { NotifierService } from './notifier.service';

@Module({
  imports: [TypeOrmModule.forFeature([OutboundEvent])],
  providers: [NotifierService],
  exports: [NotifierService],
})
export class NotificationsModule {}
