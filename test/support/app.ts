import { LoggerService } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { appOptions, configureApp } from '../../src/app.setup.js';

export interface TestAppOptions {
  mongoUri: string;
  logger?: LoggerService;
  /** Extra environment values, applied before AppModule is first imported. */
  env?: Record<string, string>;
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

// ConfigModule snapshots process.env once per test file, so every app built
// in a file must use the same env. Remember the first and reject a different one.
let appliedEnv: string | undefined;

/**
 * Builds the app the way main.ts does. AppModule is imported dynamically
 * because ConfigModule.forRoot snapshots process.env when it is first loaded.
 */
export async function createTestApp(
  options: TestAppOptions,
): Promise<NestExpressApplication> {
  if (options.env) {
    const serialized = JSON.stringify(options.env);
    if (appliedEnv !== undefined && appliedEnv !== serialized) {
      throw new Error(
        'createTestApp: env differs from the first call in this file',
      );
    }
    appliedEnv = serialized;
    Object.assign(process.env, options.env);
  }
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
