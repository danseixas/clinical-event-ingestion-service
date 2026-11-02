import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  // Liveness only for now; the Mongo connection check arrives with Phase 5.
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
