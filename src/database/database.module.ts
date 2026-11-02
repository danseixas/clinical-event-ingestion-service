import {
  Inject,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Collection, MongoClient } from 'mongodb';
import { EnvironmentVariables } from '../config/env.validation.js';
import type { EventDocument } from '../events/event.document.js';
import {
  EVENTS_COLLECTION,
  EVENTS_COLLECTION_NAME,
  MONGO_CLIENT,
} from './database.tokens.js';

// Fixed timeouts (spec D-04): a store outage surfaces as a bounded 503.
const SERVER_SELECTION_TIMEOUT_MS = 5000;

@Module({
  providers: [
    {
      provide: MONGO_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
        new MongoClient(config.get('MONGO_URI', { infer: true }), {
          serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
        }),
    },
    {
      provide: EVENTS_COLLECTION,
      inject: [MONGO_CLIENT],
      useFactory: (client: MongoClient) =>
        client.db().collection<EventDocument>(EVENTS_COLLECTION_NAME),
    },
  ],
  exports: [MONGO_CLIENT, EVENTS_COLLECTION],
})
export class DatabaseModule implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(MONGO_CLIENT) private readonly client: MongoClient,
    @Inject(EVENTS_COLLECTION)
    private readonly events: Collection<EventDocument>,
  ) {}

  // Errors propagate so a Mongo that is unreachable or refuses the index
  // stops bootstrap (spec D-07).
  async onModuleInit(): Promise<void> {
    await this.client.connect();
    await this.events.createIndex(
      { idempotencyKey: 1 },
      { unique: true, name: 'idempotencyKey_unique' },
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.close();
  }
}
