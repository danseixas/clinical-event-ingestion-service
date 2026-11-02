import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsModule {}
