import { ChildProcess, execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { MongoClient } from 'mongodb';
import type { EventDocument } from '../src/events/event.document.js';
import { startMongo, TestMongo } from './support/mongo.js';
import { D10_PATTERNS, waitFor, workerEnv } from './support/worker.js';

const ROOT = new URL('..', import.meta.url).pathname;

interface Child {
  proc: ChildProcess;
  port: number;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

const POSTED = [
  { patientId: 'p-sig-1', type: 'vitals', ts: '2026-11-02T10:00:00Z' },
];

describe('process signals (e2e)', () => {
  let mongo: TestMongo;
  let testClient: MongoClient;
  let children: Child[] = [];
  const events = () => testClient.db().collection<EventDocument>('events');

  async function spawnChild(overrides: Record<string, string>): Promise<Child> {
    const port = await freePort();
    const proc = spawn(process.execPath, ['dist/main.js'], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        MONGO_URI: mongo.uri,
        PORT: String(port),
        NO_COLOR: '1',
        ...workerEnv({ POLL_INTERVAL_MS: '50', ...overrides }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    proc.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    proc.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) =>
      proc.once('close', (code, signal) => resolve({ code, signal })),
    );
    const child: Child = {
      proc,
      port,
      stdout: () => out,
      stderr: () => err,
      exited,
    };
    children.push(child);
    await waitFor(
      async () => {
        try {
          return (
            (await fetch(`http://127.0.0.1:${port}/health`)).status === 200
          );
        } catch {
          return false;
        }
      },
      30_000,
      100,
    );
    return child;
  }

  const post = (child: Child, data: Record<string, unknown>) =>
    fetch(`http://127.0.0.1:${child.port}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...POSTED[0], data }),
    });

  const workerMessages = (text: string) =>
    text
      .split('\n')
      .filter((l) => l.includes('[EventsWorker] '))
      .map((l) =>
        l.slice(l.indexOf('[EventsWorker] ') + '[EventsWorker] '.length),
      );

  async function expectCleanOutput(child: Child) {
    for (const message of workerMessages(child.stdout() + child.stderr())) {
      expect(D10_PATTERNS.some((p) => p.test(message))).toBe(true);
    }
    const all = child.stdout() + child.stderr();
    expect(all).not.toContain('p-sig-1');
    expect(all).not.toContain('2026-11-02T10:00:00Z');
    for (const doc of await events().find().toArray()) {
      expect(all).not.toContain(doc.idempotencyKey);
    }
  }

  beforeAll(async () => {
    mongo = await startMongo('process_signals');
    testClient = await new MongoClient(mongo.uri).connect();
    await promisify(execFile)('npm', ['run', 'build'], { cwd: ROOT });
  }, 240_000);

  afterEach(async () => {
    for (const c of children) c.proc.kill('SIGKILL');
    await Promise.all(children.map((c) => c.exited));
    children = [];
    await events().deleteMany({});
  });

  afterAll(async () => {
    await testClient?.close();
    await mongo?.stop();
  }, 60_000);

  const DRAIN = {
    PROCESSING_DELAY_MS: '1500',
    PROCESSING_TIMEOUT_MS: '3000',
    LEASE_MS: '5000',
    SHUTDOWN_TIMEOUT_MS: '10000',
    FAILURE_RATE: '0',
  };

  async function postThreeAndWait(child: Child) {
    for (const i of [1, 2, 3])
      expect((await post(child, { i })).status).toBe(202);
    await waitFor(
      async () =>
        (await events().countDocuments({ status: 'processing' })) === 3,
    );
    // The last claim is stored before the worker sees its reply; give it a
    // moment so all three attempts are in flight when the signal arrives.
    await new Promise((r) => setTimeout(r, 300));
  }

  it('CA-06 SIGTERM drains in-flight attempts and exits by the signal', async () => {
    const child = await spawnChild(DRAIN);
    await postThreeAndWait(child);
    const started = Date.now();
    child.proc.kill('SIGTERM');
    const exit = await child.exited;
    console.log(
      `SIGTERM exit: ${JSON.stringify(exit)} after ${Date.now() - started} ms`,
    );
    expect(exit.signal === 'SIGTERM' || exit.code === 143).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    const out = child.stdout();
    console.log(`CA-06 stdout:\n${out}`);
    const stopping = out.indexOf('Worker stopping: 3 attempts in flight');
    expect(stopping).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('Worker stopped')).toBeGreaterThan(stopping);
    expect(out).not.toContain('Shutdown timeout');
    const docs = await events().find().toArray();
    expect(docs).toHaveLength(3);
    expect(docs.every((d) => d.status === 'done' && d.attempts === 1)).toBe(
      true,
    );
    await expectCleanOutput(child);
  }, 60_000);

  it('CA-07 POST during the drain is accepted and stays pending', async () => {
    const child = await spawnChild(DRAIN);
    await postThreeAndWait(child);
    child.proc.kill('SIGTERM');
    await waitFor(() => child.stdout().includes('Worker stopping'), 5000);
    const res = await post(child, { i: 4 });
    const body = (await res.json()) as { duplicate: boolean };
    expect(res.status).toBe(202);
    expect(body.duplicate).toBe(false);
    const exit = await child.exited;
    console.log(`SIGTERM exit (CA-07): ${JSON.stringify(exit)}`);
    const fourth = await events().findOne({ 'data.i': 4 });
    expect(fourth?.status).toBe('pending');
    expect(fourth?.attempts).toBe(0);
    await expectCleanOutput(child);
  }, 60_000);

  it('CA-10 a SIGKILLed attempt is reclaimed by another process', async () => {
    const env = {
      PROCESSING_DELAY_MS: '3000',
      PROCESSING_TIMEOUT_MS: '4000',
      LEASE_MS: '5000',
    };
    const a = await spawnChild(env);
    expect((await post(a, { i: 1 })).status).toBe(202);
    const processing = await waitFor(
      async () =>
        (await events().findOne({ status: 'processing' })) ?? undefined,
    );
    a.proc.kill('SIGKILL');
    await a.exited;
    expect(a.stdout()).not.toContain('Worker stopped');

    const b = await spawnChild(env);
    const id = processing._id.toHexString();
    const lockedUntil = processing.lockedUntil!.getTime();
    if (Date.now() < lockedUntil) {
      const doc = await events().findOne({ _id: processing._id });
      expect(doc?.status).toBe('processing');
      expect(doc?.workerId).toBe(processing.workerId);
    }
    const done = await waitFor(async () => {
      const d = await events().findOne({ _id: processing._id });
      return d?.status === 'done' && d;
    }, 30_000);
    expect(done.attempts).toBe(2);
    expect(workerMessages(b.stdout())).toContain(
      `Reclaimed event ${id} after lease expiry (attempt 2)`,
    );
    expect(
      await events().countDocuments({
        idempotencyKey: processing.idempotencyKey,
      }),
    ).toBe(1);
    b.proc.kill('SIGTERM');
    await b.exited;
    await expectCleanOutput(a);
    await expectCleanOutput(b);
  }, 90_000);
});
