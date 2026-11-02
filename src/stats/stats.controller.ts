import { Controller, Get } from '@nestjs/common';
import { StatsBody, StatsService } from './stats.service.js';

@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  // No @Query(): query parameters are ignored.
  @Get()
  get(): Promise<StatsBody> {
    return this.stats.snapshot();
  }
}
