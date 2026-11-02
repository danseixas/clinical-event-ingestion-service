import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { appOptions, configureApp } from './app.setup.js';
import { AppModule } from './app.module.js';
import { EnvironmentVariables } from './config/env.validation.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    appOptions,
  );
  configureApp(app);
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  const config = app.get(ConfigService<EnvironmentVariables, true>);
  await app.listen(config.get('PORT', { infer: true }));
}
await bootstrap();
