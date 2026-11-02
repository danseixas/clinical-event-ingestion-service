import { createTestApp } from './support/app.js';

describe('startup failure (e2e)', () => {
  it('CA-15 rejects init when MongoDB is unreachable', async () => {
    const started = Date.now();
    await expect(
      createTestApp({
        mongoUri: 'mongodb://127.0.0.1:1/x?directConnection=true',
      }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThanOrEqual(15_000);
  }, 30_000);
});
