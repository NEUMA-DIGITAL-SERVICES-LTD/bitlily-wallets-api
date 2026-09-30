import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKeyGuard, Public } from './common/api-key.guard';
import {
  confirmationsConfig,
  serviceConfig,
  tatumConfig,
  webhookConfig,
} from './config/configuration';
import { ALL_ENTITIES } from './database/entities';
import { LedgerModule } from './ledger/ledger.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { WalletsModule } from './modules/wallets/wallets.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { ProvidersModule } from './providers/providers.module';

@Controller('api/v1/health')
class HealthController {
  @Public()
  @Get()
  health() {
    return { status: 'ok', ts: new Date().toISOString() };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [serviceConfig, tatumConfig, webhookConfig, confirmationsConfig],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('DATABASE_URL'),
        entities: ALL_ENTITIES,
        // Schema is owned by migrations — synchronize stays off everywhere.
        synchronize: false,
        migrationsRun: true,
        migrations: [__dirname + '/../migrations/*{.ts,.js}'],
      }),
    }),
    ScheduleModule.forRoot(),
    ProvidersModule,
    LedgerModule,
    WalletsModule,
    TransactionsModule,
    WebhooksModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ApiKeyGuard }],
})
export class AppModule {}
