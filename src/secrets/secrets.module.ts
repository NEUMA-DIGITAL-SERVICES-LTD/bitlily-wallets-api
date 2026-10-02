import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SECRET_STORE, SecretStore } from './secret-store';
import { EnvSecretStore } from './env.store';
import { TatumKmsStore } from './tatum-kms.store';

/**
 * Chooses the secret store by config: TATUM_USE_KMS=true requires KMS_URL
 * and enrolls into the Tatum KMS daemon; anything else falls back to the
 * dev env-key store. Fails fast on mainnet+env to prevent shipping a
 * custodial service with discarded keys.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    EnvSecretStore,
    TatumKmsStore,
    {
      provide: SECRET_STORE,
      inject: [ConfigService, EnvSecretStore, TatumKmsStore],
      useFactory: (
        config: ConfigService,
        env: EnvSecretStore,
        kms: TatumKmsStore,
      ): SecretStore => {
        const useKms = config.get('tatum.useKms') === true;
        const network = config.get<string>('tatum.network');
        if (useKms) {
          if (!config.get<string>('tatum.kmsUrl')) {
            throw new Error('TATUM_USE_KMS=true requires KMS_URL');
          }
          return kms;
        }
        if (network === 'mainnet') {
          throw new Error(
            'Refusing to boot: env-key signing on mainnet. ' +
            'Set TATUM_USE_KMS=true with KMS_URL.',
          );
        }
        return env;
      },
    },
  ],
  exports: [SECRET_STORE],
})
export class SecretsModule {}
