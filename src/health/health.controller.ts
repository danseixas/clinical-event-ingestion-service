import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MongoClient } from 'mongodb';
import { MONGO_CLIENT } from '../database/database.tokens.js';

// Fixed bound (spec D-03), well below the Compose healthcheck timeout (3 s).
export const HEALTH_PING_TIMEOUT_MS = 1000;

const UP_BODY = { status: 'ok', mongo: 'up' } as const;
const DOWN_BODY = { status: 'error', mongo: 'down' } as const;

@Controller('health')
export class HealthController {
  constructor(@Inject(MONGO_CLIENT) private readonly client: MongoClient) {}

  // Reports Mongo reachability only. There is no draining or readiness state
  // (spec D-02): during shutdown it answers from the ping alone.
  @Get()
  async check(): Promise<{ status: 'ok'; mongo: 'up' }> {
    let timer: NodeJS.Timeout | undefined;
    // A ping that settles after the bound is absorbed here, never unhandled.
    const ping = this.client
      .db()
      .command({ ping: 1 })
      .then(
        () => true,
        () => false,
      );
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), HEALTH_PING_TIMEOUT_MS);
    });
    const up = await Promise.race([ping, timeout]);
    clearTimeout(timer);
    if (!up) throw new ServiceUnavailableException({ ...DOWN_BODY });
    return { ...UP_BODY };
  }
}
