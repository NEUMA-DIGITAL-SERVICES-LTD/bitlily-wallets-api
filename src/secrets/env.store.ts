import { Injectable, Logger } from '@nestjs/common';
import { SecretStore } from './secret-store';

/**
 * Dev/testnet secret store — discards generated material and relies on
 * TESTNET_PK_{chain} env vars for signing. NEVER wire this on mainnet:
 * enrollment returning null with TATUM_USE_KMS=true means sends have no
 * signatureId and will fail loudly rather than silently leak keys.
 */
@Injectable()
export class EnvSecretStore implements SecretStore {
  readonly name = 'env';
  private readonly logger = new Logger(EnvSecretStore.name);

  async enroll(chain: string): Promise<null> {
    this.logger.warn(
      `${chain} wallet material discarded — dev env-key signing only. ` +
      `Set TATUM_USE_KMS=true + KMS_URL for production custody.`,
    );
    return null;
  }
}
