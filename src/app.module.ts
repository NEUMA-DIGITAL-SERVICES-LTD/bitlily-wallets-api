import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ApiKeyGuard, Public } from './common/api-key.guard';
import {
  confirmationsConfig,
  detectionConfig,
  limitsConfig,
  reconcileConfig,
  serviceConfig,
  sweepConfig,
  tatumConfig,
  webhookConfig,
} from './config/configuration';
import { ALL_ENTITIES } from './database/entities';
import { LedgerModule } from './ledger/ledger.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { WalletsModule } from './modules/wallets/wallets.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { ProvidersModule } from './providers/providers.module';
import { SecretsModule } from './secrets/secrets.module';
import { AdminModule } from './modules/admin/admin.module';
import { SweepsModule } from './modules/sweeps/sweeps.module';

@Controller('api/v1')
class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  /** Liveness — process is up. Never checks dependencies. */
  @Public()
  @Get('health')
  health() {
    return { status: 'ok', ts: new Date().toISOString() };
  }

  /**
   * Readiness — DB reachable + provider configured. Deliberately does NOT make
   * a live provider call: LB polls are frequent, provider calls cost credits,
   * and a transient Tatum blip shouldn't drain a healthy node. Provider health
   * is surfaced by poller/reconciliation errors, not this endpoint.
   */
  @Public()
  @Get('ready')
  async ready() {
    const providerConfigured = !!this.config.get<string>('tatum.apiKey');
    try {
      await this.dataSource.query('SELECT 1');
      return {
        status: 'ready',
        db: 'up',
        provider: providerConfigured ? 'configured' : 'missing_key',
        ts: new Date().toISOString(),
      };
    } catch {
      return {
        status: 'not_ready',
        db: 'down',
        provider: providerConfigured ? 'configured' : 'missing_key',
        ts: new Date().toISOString(),
      };
    }
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [serviceConfig, tatumConfig, webhookConfig, confirmationsConfig, detectionConfig, sweepConfig, limitsConfig, reconcileConfig],
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
        migrations: [__dirname + '/migrations/*{.ts,.js}'],
      }),
    }),
    ScheduleModule.forRoot(),
    ProvidersModule,
    LedgerModule,
    WalletsModule,
    TransactionsModule,
    WebhooksModule,
    MonitoringModule,
    SecretsModule,
    AdminModule,
    SweepsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ApiKeyGuard }],
})
export class AppModule {}
