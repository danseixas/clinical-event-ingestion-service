import { LoggerService } from '@nestjs/common';

export interface CapturedLog {
  level: string;
  text: string;
}

export class CaptureLogger implements LoggerService {
  readonly lines: CapturedLog[] = [];

  private record(level: string, message: unknown, params: unknown[]): void {
    const parts = [message, ...params].map((part) =>
      typeof part === 'string' ? part : JSON.stringify(part),
    );
    this.lines.push({ level, text: parts.join(' ') });
  }

  log(message: unknown, ...params: unknown[]) {
    this.record('log', message, params);
  }
  error(message: unknown, ...params: unknown[]) {
    this.record('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]) {
    this.record('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]) {
    this.record('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]) {
    this.record('verbose', message, params);
  }

  get all(): string {
    return this.lines.map((line) => line.text).join('\n');
  }
}
