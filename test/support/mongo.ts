import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { readFileSync } from 'node:fs';

// The MongoDB version is pinned once, in package.json "config".
const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { config: { mongodbMemoryServer: { version: string } } };

export interface TestMongo {
  /** Connection string for a fresh database named `dbName`. */
  uri: string;
  version: string;
  stop: () => Promise<void>;
}

export interface StartMongoOptions {
  /** Allows `configureFailPoint` (used to simulate store errors). */
  enableTestCommands?: boolean;
}

export async function startMongo(
  dbName: string,
  options: StartMongoOptions = {},
): Promise<TestMongo> {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    ...(options.enableTestCommands
      ? { instanceOpts: [{ args: ['--setParameter', 'enableTestCommands=1'] }] }
      : {}),
    binary: { version: pkg.config.mongodbMemoryServer.version },
  });
  return {
    uri: replSet.getUri(dbName),
    version: pkg.config.mongodbMemoryServer.version,
    stop: async () => {
      await replSet.stop();
    },
  };
}
