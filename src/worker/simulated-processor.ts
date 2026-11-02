import type { EventProcessor, EventProcessorInput } from './event-processor.js';

export class SimulatedFailureError extends Error {
  constructor() {
    super('Simulated external call failure');
    this.name = 'SimulatedFailureError';
  }
}

export interface SimulatedProcessorOptions {
  delayMs: number;
  failureRate: number;
}

// Stands in for the external call: waits, then fails with probability
// `failureRate`. The input is ignored and never stored or echoed.
export class SimulatedProcessor implements EventProcessor {
  constructor(
    private readonly options: SimulatedProcessorOptions,
    private readonly random: () => number = Math.random,
  ) {}

  process(
    _input: EventProcessorInput,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        if (this.random() < this.options.failureRate) {
          reject(new SimulatedFailureError());
        } else {
          resolve({ simulated: true });
        }
      }, this.options.delayMs);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
