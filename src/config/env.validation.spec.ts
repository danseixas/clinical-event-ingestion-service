import { validateEnv } from './env.validation.js';

describe('validateEnv', () => {
  it('applies defaults when nothing is set', () => {
    const env = validateEnv({});

    expect(env.WORKER_CONCURRENCY).toBe(100);
    expect(env.PROCESSING_DELAY_MS).toBe(5_000);
    expect(env.FAILURE_RATE).toBe(0.05);
    expect(env.MAX_ATTEMPTS).toBe(5);
  });

  it('converts numeric strings from the environment', () => {
    const env = validateEnv({ WORKER_CONCURRENCY: '25', FAILURE_RATE: '0.5' });

    expect(env.WORKER_CONCURRENCY).toBe(25);
    expect(env.FAILURE_RATE).toBe(0.5);
  });

  it('treats blank values as unset', () => {
    const env = validateEnv({ FAILURE_RATE: '', MONGO_URI: '' });

    expect(env.FAILURE_RATE).toBe(0.05);
    expect(env.MONGO_URI).toContain('mongodb://');
  });

  it('ignores unrelated environment variables', () => {
    expect(() => validateEnv({ HOME: '/root', PATH: '/bin' })).not.toThrow();
  });

  it.each([
    [{ WORKER_CONCURRENCY: '0' }, 'WORKER_CONCURRENCY'],
    [{ WORKER_CONCURRENCY: 'many' }, 'WORKER_CONCURRENCY'],
    [{ MAX_ATTEMPTS: '2.5' }, 'MAX_ATTEMPTS'],
    [{ FAILURE_RATE: '1.5' }, 'FAILURE_RATE'],
    [{ PORT: '70000' }, 'PORT'],
  ])('rejects %o', (input, name) => {
    expect(() => validateEnv(input)).toThrow(name);
  });

  it('rejects a lease that is not longer than the processing timeout', () => {
    expect(() =>
      validateEnv({ LEASE_MS: '10000', PROCESSING_TIMEOUT_MS: '10000' }),
    ).toThrow('LEASE_MS must be greater than PROCESSING_TIMEOUT_MS');
  });

  it('rejects a backoff cap below the base delay', () => {
    expect(() =>
      validateEnv({ BACKOFF_BASE_MS: '5000', BACKOFF_MAX_MS: '1000' }),
    ).toThrow('BACKOFF_MAX_MS must not be less than BACKOFF_BASE_MS');
  });

  it('reports every problem at once', () => {
    expect(() =>
      validateEnv({ WORKER_CONCURRENCY: '0', MAX_ATTEMPTS: '0' }),
    ).toThrow(/WORKER_CONCURRENCY[\s\S]*MAX_ATTEMPTS/);
  });

  describe('WORKER_ENABLED', () => {
    it.each([[{}], [{ WORKER_ENABLED: '' }], [{ WORKER_ENABLED: 'true' }]])(
      'is true for %o',
      (input) => {
        expect(validateEnv(input).WORKER_ENABLED).toBe(true);
      },
    );

    it('is false for "false"', () => {
      expect(validateEnv({ WORKER_ENABLED: 'false' }).WORKER_ENABLED).toBe(
        false,
      );
    });

    it.each(['FALSE', 'yes', '1', ' true'])('rejects %j', (value) => {
      expect(() => validateEnv({ WORKER_ENABLED: value })).toThrow(
        'WORKER_ENABLED must be true or false',
      );
    });

    it('lists it together with other problems', () => {
      expect(() =>
        validateEnv({ WORKER_ENABLED: 'yes', WORKER_CONCURRENCY: '0' }),
      ).toThrow(
        /WORKER_ENABLED must be true or false[\s\S]*WORKER_CONCURRENCY|WORKER_CONCURRENCY[\s\S]*WORKER_ENABLED must be true or false/,
      );
    });
  });
});
