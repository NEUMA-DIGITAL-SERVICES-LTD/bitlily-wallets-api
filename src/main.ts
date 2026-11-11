import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { makeRateLimiter } from './common/rate-limit';
import { requestId } from './common/request-id';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const config = app.get(ConfigService);

  // req.ip honesty: TRUST_PROXY_HOPS must equal the number of trusted proxy
  // hops (1 behind nginx/ALB, 0 direct). With 0, req.ip is the socket peer —
  // unspoofable. Setting it too HIGH lets callers spoof X-Forwarded-For and
  // defeat per-client IP allowlists — keep it at the true hop count.
  const trustProxyHops = parseInt(process.env.TRUST_PROXY_HOPS ?? '0', 10);
  if (trustProxyHops > 0) app.set('trust proxy', trustProxyHops);

  app.use(requestId);

  // Inbound bodies are bounded: webhook payloads are small by design; a large
  // body is either abuse or a misconfigured producer.
  app.use(json({ limit: '256kb' }));
  app.use(urlencoded({ limit: '256kb', extended: true }));

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  // Uniform error contract: { code, message, requestId }. Non-HTTP throws
  // are logged internally and reported as INTERNAL_ERROR — stack traces
  // and provider internals never reach the client.
  app.useGlobalFilters(new HttpExceptionFilter());

  // Webhook ingress is the only unauthenticated write surface — cap it.
  // (Mounted on the REAL route — '/webhooks' never matched and left the
  // limiter dead.)
  app.use(
    '/api/v1/webhooks',
    makeRateLimiter({
      windowMs: 60_000,
      max: config.get<number>('service.webhookRateLimitPerMinute') ?? 120,
    }),
  );

  // Indexer↔network sanity: a testnet explorer URL on a mainnet deploy
  // returns EMPTY history for every address — deposits stay pending and
  // unattributed with NO error logged (observed live: shasta URL under
  // TATUM_NETWORK=mainnet). Scream at boot instead of degrading silently.
  {
    const network = config.get<string>('tatum.network') ?? 'testnet';
    const testnetMarker = /shasta|nile|sepolia|amoy|testnet|devnet|holesky|goerli/i;
    const urls: Record<string, string> = {
      TRONGRID_URL: config.get<string>('history.tronGridUrl') ?? '',
      SOLANA_RPC_URL: config.get<string>('tatum.solanaRpcUrl') ?? '',
      ...Object.fromEntries(
        Object.entries(
          config.get<Record<string, { url: string }>>('history.evm') ?? {},
        ).map(([chain, c]) => [`HISTORY_${chain}_URL`, c?.url ?? '']),
      ),
    };
    for (const [env, url] of Object.entries(urls)) {
      if (!url) continue;
      if (network === 'mainnet' && testnetMarker.test(url)) {
        console.error(
          `FATAL CONFIG: ${env}=${url} is a TESTNET endpoint but ` +
            `TATUM_NETWORK=mainnet — deposit attribution on that chain will ` +
            `never resolve (deltas stay pending). Unset it for the ` +
            `network-matched default.`,
        );
      } else if (network !== 'mainnet' && !testnetMarker.test(url)) {
        console.warn(
          `CONFIG WARNING: ${env}=${url} looks like a MAINNET endpoint ` +
            `but TATUM_NETWORK=${network} — deposit attribution may never resolve.`,
        );
      }
    }
  }

  // Swagger docs are gated by SWAGGER_ENABLED (default: off in production).
  // The OpenAPI doc is a full route map — every endpoint shape, for any
  // unauthenticated scanner. When off, /docs and /docs-json 404.
  if (config.get<boolean>('service.swaggerEnabled')) {
    const docs = new DocumentBuilder()
      .setTitle('Bitlily Crypto Service')
      .setDescription(
        'Multi-chain crypto infrastructure gateway: deposit addresses, ' +
          'deposit monitoring, withdrawals, fee estimation. Blockchain I/O ' +
          'abstracted behind a provider layer (currently Tatum).',
      )
      .setVersion('0.1.0')
      .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'x-api-key')
      .addApiKey({ type: 'apiKey', name: 'X-Admin-Key', in: 'header' }, 'x-admin-key')
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, docs));
  }

  const port = config.get<number>('service.port') ?? 3100;
  await app.listen(port);
}
bootstrap();
