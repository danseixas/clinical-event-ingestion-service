import {
  Inject,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Collection,
  IndexOptions,
  IndexSpecification,
  MongoClient,
} from 'mongodb';
import { EnvironmentVariables } from '../config/env.validation.js';
import type { EventDocument } from '../events/event.document.js';
import {
  EVENTS_COLLECTION,
  EVENTS_COLLECTION_NAME,
  MONGO_CLIENT,
} from './database.tokens.js';

// Fixed timeouts (spec D-04): a store outage surfaces as a bounded 503.
const SERVER_SELECTION_TIMEOUT_MS = 5000;

export const IDEMPOTENCY_INDEX_NAME = 'idempotencyKey_unique';
export const CLAIM_INDEX_NAME = 'claim_status_nextAttemptAt';
export const PATIENT_READ_ORDER_INDEX_NAME = 'patient_read_order';

// Created in this order at startup (spec D-06).
export const EVENTS_INDEXES: readonly {
  key: IndexSpecification;
  options: IndexOptions;
}[] = [
  {
    key: { idempotencyKey: 1 },
    options: { unique: true, name: IDEMPOTENCY_INDEX_NAME },
  },
  {
    key: { status: 1, nextAttemptAt: 1 },
    options: { name: CLAIM_INDEX_NAME },
  },
  {
    key: { patientId: 1, ts: 1, receivedAt: 1, _id: 1 },
    options: { name: PATIENT_READ_ORDER_INDEX_NAME },
  },
];

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

  // Errors propagate so a Mongo that is unreachable or refuses an index
  // (including a name conflict) stops bootstrap (spec D-06).
  async onModuleInit(): Promise<void> {
    await this.client.connect();
    for (const index of EVENTS_INDEXES) {
      await this.events.createIndex(index.key, index.options, undefined);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.close();
  }
}
