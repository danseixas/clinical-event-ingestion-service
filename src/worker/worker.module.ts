import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables } from '../config/env.validation.js';
import { DatabaseModule } from '../database/database.module.js';
import { EVENT_PROCESSOR } from './event-processor.js';
import { EventsWorker } from './events-worker.js';
import { SimulatedProcessor } from './simulated-processor.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    EventsWorker,
    {
      provide: EVENT_PROCESSOR,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
        new SimulatedProcessor({
          delayMs: config.get('PROCESSING_DELAY_MS', { infer: true }),
          failureRate: config.get('FAILURE_RATE', { infer: true }),
        }),
    },
  ],
})
export class WorkerModule {}
