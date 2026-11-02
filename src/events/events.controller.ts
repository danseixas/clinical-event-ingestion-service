import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { CreateEventDto } from './create-event.dto.js';
import { EventBodyPipe } from './event-body.pipe.js';
import { EventsService, IngestResult } from './events.service.js';

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post()
  @HttpCode(202)
  create(@Body(EventBodyPipe) body: CreateEventDto): Promise<IngestResult> {
    return this.events.ingest(body);
  }
}
