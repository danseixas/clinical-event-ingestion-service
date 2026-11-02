import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

// Every setting has a default, so the service starts with no environment at
// all. Values set in the environment are converted to numbers and validated;
// anything invalid stops startup instead of running with a bad setting.
export class EnvironmentVariables {
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsString()
  @MinLength(1)
  MONGO_URI: string = 'mongodb://localhost:27017/ingest?directConnection=true';

  // Events processed at the same time by one process.
  @IsInt()
  @Min(1)
  WORKER_CONCURRENCY: number = 100;

  // How long a claimed event belongs to a worker before others may reclaim it.
  @IsInt()
  @Min(1)
  LEASE_MS: number = 30_000;

  // How long an idle worker waits before looking for due events again.
  @IsInt()
  @Min(1)
  POLL_INTERVAL_MS: number = 500;

  // Simulated external call.
  @IsInt()
  @Min(0)
  PROCESSING_DELAY_MS: number = 5_000;

  @IsInt()
  @Min(1)
  PROCESSING_TIMEOUT_MS: number = 10_000;

  @IsNumber()
  @Min(0)
  @Max(1)
  FAILURE_RATE: number = 0.05;

  // Retry policy: exponential backoff with jitter, capped, then `failed`.
  @IsInt()
  @Min(1)
  MAX_ATTEMPTS: number = 5;

  @IsInt()
  @Min(0)
  BACKOFF_BASE_MS: number = 1_000;

  @IsInt()
  @Min(0)
  BACKOFF_MAX_MS: number = 60_000;

  // How long shutdown waits for in-flight events before exiting.
  @IsInt()
  @Min(0)
  SHUTDOWN_TIMEOUT_MS: number = 20_000;
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  // A blank variable (`FAILURE_RATE=`) means "use the default", not 0.
  const provided = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== ''),
  );
  const env = plainToInstance(EnvironmentVariables, provided, {
    enableImplicitConversion: true,
  });
  const messages = validateSync(env).flatMap((error) =>
    Object.values(error.constraints ?? {}),
  );

  // A lease that can expire while the external call may still be running
  // would let a second worker process the same event in parallel.
  if (env.LEASE_MS <= env.PROCESSING_TIMEOUT_MS) {
    messages.push('LEASE_MS must be greater than PROCESSING_TIMEOUT_MS');
  }
  if (env.BACKOFF_MAX_MS < env.BACKOFF_BASE_MS) {
    messages.push('BACKOFF_MAX_MS must not be less than BACKOFF_BASE_MS');
  }

  if (messages.length > 0) {
    throw new Error(`Invalid configuration:\n- ${messages.join('\n- ')}`);
  }
  return env;
}
