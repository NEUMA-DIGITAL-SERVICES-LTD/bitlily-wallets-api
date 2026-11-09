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
