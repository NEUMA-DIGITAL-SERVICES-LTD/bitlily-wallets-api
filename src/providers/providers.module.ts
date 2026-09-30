import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BLOCKCHAIN_PROVIDER } from './provider.interface';
import { TatumProvider } from './tatum/tatum.provider';

/**
 * Binds BLOCKCHAIN_PROVIDER to the active vendor. To migrate vendors
 * (e.g. Tatum → direct RPC + KMS), add the new adapter and change
 * `useClass` here — no other file needs to know.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    TatumProvider,
    { provide: BLOCKCHAIN_PROVIDER, useExisting: TatumProvider },
  ],
  exports: [BLOCKCHAIN_PROVIDER],
})
export class ProvidersModule {}
