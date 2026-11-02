import {
  SimulatedFailureError,
  SimulatedProcessor,
} from './simulated-processor.js';

const input = {
  eventId: 'abc',
  idempotencyKey: 'key',
  patientId: 'p-1',
  type: 'vitals',
  ts: new Date(),
  data: {},
};

describe('SimulatedProcessor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves { simulated: true } only after the delay (rate 0)', async () => {
    const p = new SimulatedProcessor({ delayMs: 1000, failureRate: 0 });
    let settled = false;
    const promise = p
      .process(input, new AbortController().signal)
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({ simulated: true });
  });

  it('rejects with the simulated failure only after the delay (rate 1)', async () => {
    const p = new SimulatedProcessor(
      { delayMs: 1000, failureRate: 1 },
      () => 0.5,
    );
    let settled = false;
    const promise = p.process(input, new AbortController().signal);
    promise.catch(() => (settled = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).rejects.toBeInstanceOf(SimulatedFailureError);
  });

  it('succeeds when random equals the rate and fails just below it', async () => {
    const equal = new SimulatedProcessor(
      { delayMs: 10, failureRate: 0.3 },
      () => 0.3,
    );
    const equalResult = equal.process(input, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(10);
    await expect(equalResult).resolves.toEqual({ simulated: true });

    const below = new SimulatedProcessor(
      { delayMs: 10, failureRate: 0.3 },
      () => 0.299,
    );
    const belowResult = below.process(input, new AbortController().signal);
    belowResult.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    await expect(belowResult).rejects.toBeInstanceOf(SimulatedFailureError);
  });

  it('rejects at once on abort', async () => {
    const p = new SimulatedProcessor({ delayMs: 1000, failureRate: 0 });
    const controller = new AbortController();
    const promise = p.process(input, controller.signal);
    promise.catch(() => undefined);
    controller.abort(new Error('stop'));
    await expect(promise).rejects.toThrow('stop');
  });

  it('rejects at once when already aborted', async () => {
    const p = new SimulatedProcessor({ delayMs: 1000, failureRate: 0 });
    const controller = new AbortController();
    controller.abort(new Error('early'));
    await expect(p.process(input, controller.signal)).rejects.toThrow('early');
  });
});
