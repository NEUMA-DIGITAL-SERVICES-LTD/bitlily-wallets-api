import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  const docs = new DocumentBuilder()
    .setTitle('Bitlily Crypto Service')
    .setDescription(
      'Multi-chain crypto infrastructure gateway: deposit addresses, ' +
        'deposit monitoring, withdrawals, fee estimation. Blockchain I/O ' +
        'abstracted behind a provider layer (currently Tatum).',
    )
    .setVersion('0.1.0')
    .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'x-api-key')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, docs));

  const port = config.get<number>('service.port') ?? 3100;
  await app.listen(port);
}
bootstrap();
