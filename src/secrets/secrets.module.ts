import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SECRET_STORE, SecretStore } from './secret-store';
import { EnvSecretStore } from './env.store';

/**
 * Chooses the secret store by config. Under TATUM_USE_KMS, enrollment is a
 * custody_accounts concern (operator runs tatum-kms CLI on the KMS host;
 * secrets NEVER transit this service) — the store here is a trap that fails
 * loudly if any code path tries to enroll secrets under KMS mode.
 * Mainnet refuses env-key signing entirely.
 */
const kmsTrapStore: SecretStore = {
  name: 'kms-trap',
  async enroll(): Promise<string> {
    throw new Error(
      'KMS mode: secrets enroll on the KMS host via tatum-kms CLI, ' +
      'then POST /api/v1/admin/custody — SecretStore.enroll must not be reached.',
    );
  },
};

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    EnvSecretStore,
    {
      provide: SECRET_STORE,
      inject: [ConfigService, EnvSecretStore],
      useFactory: (config: ConfigService, env: EnvSecretStore): SecretStore => {
        const useKms = config.get('tatum.useKms') === true;
        const network = config.get<string>('tatum.network');
        if (useKms) return kmsTrapStore;
        if (network === 'mainnet') {
          throw new Error(
            'Refusing to boot: env-key signing on mainnet. ' +
            'Set TATUM_USE_KMS=true and enroll custody wallets.',
          );
        }
        return env;
      },
    },
  ],
  exports: [SECRET_STORE],
})
export class SecretsModule {}
