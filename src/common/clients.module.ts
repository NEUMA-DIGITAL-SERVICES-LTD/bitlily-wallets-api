import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiClient } from '../database/entities/api-client.entity';
import { ClientsService } from './clients.service';

/** Global — the guard (AppModule scope) and the notifier both resolve
 *  through ClientsService without importing each other's modules. */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ApiClient])],
  providers: [ClientsService],
  exports: [ClientsService],
})
export class ClientsModule {}
