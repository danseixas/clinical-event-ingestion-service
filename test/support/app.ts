import { LoggerService } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { appOptions, configureApp } from '../../src/app.setup.js';

export interface TestAppOptions {
  mongoUri: string;
  logger?: LoggerService;
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

/**
 * Builds the app the way main.ts does. AppModule is imported dynamically
 * because ConfigModule.forRoot snapshots process.env when it is first loaded.
 */
export async function createTestApp(
  options: TestAppOptions,
): Promise<NestExpressApplication> {
  process.env.MONGO_URI = options.mongoUri;
  const { AppModule } = await import('../../src/app.module.js');
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.configure) builder = options.configure(builder);
  const moduleRef = await builder.compile();
  const app =
    moduleRef.createNestApplication<NestExpressApplication>(appOptions);
  if (options.logger) app.useLogger(options.logger);
  configureApp(app);
  await app.init();
  return app;
}
