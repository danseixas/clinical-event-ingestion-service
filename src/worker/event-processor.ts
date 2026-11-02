export const EVENT_PROCESSOR = Symbol('EVENT_PROCESSOR');

export interface EventProcessorInput {
  eventId: string;
  idempotencyKey: string;
  patientId: string;
  type: string;
  ts: Date;
  data: Record<string, unknown>;
}

/** The external call. Implementations must honour `signal` when they can. */
export interface EventProcessor {
  process(
    input: EventProcessorInput,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
}
