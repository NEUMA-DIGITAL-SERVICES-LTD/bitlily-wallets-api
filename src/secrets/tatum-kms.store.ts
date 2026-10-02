import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { SecretStore } from './secret-store';
import { errMsg } from '../common/errors';

/**
 * Tatum KMS daemon enrollment. The KMS holds the mnemonic/private key in its
 * own secured store and signs transactions server-side; Tatum's send APIs
 * reference the key by `signatureId` — that id (not key material) is what we
 * persist on wallet_accounts.secret_ref.
 *
 * Daemon API: POST {KMS_URL}/store with the secret body; optional x-api-key
 * auth when the daemon is started with one. Chain names use Tatum's codes.
 */
@Injectable()
export class TatumKmsStore implements SecretStore {
  readonly name = 'tatum-kms';
  private readonly logger = new Logger(TatumKmsStore.name);
  private readonly http;

  constructor(private readonly config: ConfigService) {
    this.http = axios.create({
      baseURL: this.config.get<string>('tatum.kmsUrl'),
      headers: this.config.get<string>('tatum.kmsApiKey')
        ? { 'x-api-key': this.config.get<string>('tatum.kmsApiKey') }
        : undefined,
      timeout: 15_000,
    });
  }

  async enroll(
    chain: string,
    material: { mnemonic?: string; privateKey?: string },
  ): Promise<string> {
    const signatureId = randomUUID();
    const secret = material.mnemonic ?? material.privateKey;
    if (!secret) throw new Error(`No secret material to enroll for ${chain}`);
    try {
      await this.http.post('/store', {
        signatureId,
        type: material.mnemonic ? 'MNEMONIC' : 'PRIVATE_KEY',
        chain,
        secret,
      });
    } catch (e) {
      throw new Error(`KMS enrollment failed for ${chain}: ${errMsg(e)}`);
    }
    this.logger.log(`Enrolled ${chain} wallet material in KMS as ${signatureId}`);
    return signatureId;
  }
}
