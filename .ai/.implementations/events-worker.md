# Implementation report: events-worker

## 1. Identity and result

- Result: COMPLETE
- Date: 2026-11-02
- Spec: `.ai/.specs/events-worker.md`, SHA-256 `c6afc6c45f90d24919cc36633d2b87fff7426b700ffa082277e4e5384ebd99f5` (matches the plan's recorded value, recomputed with `shasum -a 256`)
- Plan: `.ai/.plans/events-worker.md`, SHA-256 `276dba99a8a907fe92e99a2d6d6361e8e1c84d1685ecf7de5f1d149a02d6e309`
- Affected repositories: `clinical-event-ingestion-service` only.
- Environment: Node v24.21.0, MongoDB 7.0.45 (mongodb-memory-server, one-member replica set), macOS.

## 2. Starting state

- Branch `main`, HEAD `cc34e12`.
- Pre-existing uncommitted changes (not from this run): untracked `.ai/.plans/events-worker.md` and `.ai/.specs/events-worker.md`. They did not overlap any planned file. Nothing was staged or committed.

## 3. Task execution

| Task | Status | Actual changes |
| --- | --- | --- |
| T-01 | completed | `src/config/env.validation.ts` (`WORKER_ENABLED`, `@Transform` on the raw value + `@IsBoolean` with the D-08 message), `src/config/env.validation.spec.ts` (CA-02 cases) |
| T-02 | completed | `docker-compose.yml` (+1 line), `README.md` (+1 row) |
| T-03 | completed | `src/worker/event-processor.ts`, `simulated-processor.ts`, `simulated-processor.spec.ts` |
| T-04 | completed | `src/worker/backoff.ts`, `backoff.spec.ts` |
| T-05 | completed | `src/worker/worker.module.ts`, `src/worker/events-worker.ts` (lifecycle, single dispatcher, claim) |
| T-06 | completed | `events-worker.ts` `callProcessor` (timeout race, abort, classification, late result ignored) |
| T-07 | completed | `events-worker.ts` `recordOutcome` (fenced writes, backoff, final failure, 3 retries 1 s apart, lease guard, D-10 logs) |
| T-08 | completed | `events-worker.ts` `beforeApplicationShutdown` (idempotent stop, no time bound) |
| T-09 | completed | `test/support/app.ts` (`env` option + same-env guard), `test/support/mongo.ts` (`enableTestCommands`), new `test/support/worker.ts` |
| T-10 | completed | `env: { WORKER_ENABLED: 'false' }` added to every `createTestApp` call in the five existing e2e suites; no assertion changed |
| T-11 | completed | `src/app.module.ts` imports `WorkerModule` |
| T-12 | completed | `test/worker.e2e-spec.ts` (CA-03, 04, 05, 09, 10, 13 x3, 14a, 14b, 15a, 20) |
| T-13 | completed | `test/worker-max-attempts.e2e-spec.ts` (CA-11, CA-20) |
| T-14 | completed | `test/worker-timeout.e2e-spec.ts` (CA-12, CA-11 with MAX_ATTEMPTS=1) |
| T-15 | completed | `test/worker-concurrency-1.e2e-spec.ts` (CA-06, CA-16a, CA-16b) |
| T-16 | completed | `test/worker-concurrency-2.e2e-spec.ts` (CA-08), `test/worker-concurrency-3.e2e-spec.ts` (CA-07) |
| T-17 | completed | `test/worker-short-lease.e2e-spec.ts` (CA-14 no retry after lease) |
| T-18 | completed | `test/worker-store-down.e2e-spec.ts` (CA-15b) |
| T-19 | completed | `test/worker-disabled.e2e-spec.ts` (CA-17) |
| T-20 | completed | Verification below. Optional manual Docker QA not run. |

## 4. Behavior delivered

With `WORKER_ENABLED=true` (default), each process runs one dispatcher that keeps up to `WORKER_CONCURRENCY` attempts in flight. It claims the due `pending` event with the oldest `nextAttemptAt` (`findOneAndUpdate`, majority write concern), calls the simulated processor with the idempotency key under a `PROCESSING_TIMEOUT_MS` race, and records the outcome with an `updateOne` fenced on `_id`, `status: processing`, `workerId` and the claimed `attempts`. Failures go back to `pending` with equal-jitter exponential backoff, or to `failed` at `MAX_ATTEMPTS`. Outcome writes retry up to 3 times 1 s apart on store-unavailable errors and never at or after `lockedUntil`, then are abandoned with a warn. `app.close()` stops claiming and waits for in-flight attempts, then logs `Worker stopped`. No lease reclaim, signal hooks or shutdown timeout (Phase 4). `EventsService`, `EventDocument`, indexes, `main.ts`, Dockerfile and package files are untouched.

## 5. Deviations

- The plan's T-12 snippet implies a 201 on `POST /events`; the endpoint returns 202, so the test asserts 202. The spec is unaffected.
- CA-03 and CA-20 log checks are shared in a helper `expectCleanLogs` in `test/worker.e2e-spec.ts`; CA-20 coverage for CA-11 is in `worker-max-attempts.e2e-spec.ts`.
- The final-failure and timeout tests wait for the worker `warn` line (it is logged after the acknowledged write, so the test can see `failed` first). Test-only.
- Otherwise none.

## 6. Verification evidence

Environment: Node v24.21.0, MongoDB 7.0.45.

Passed:
- `npm run build`: exit 0 (CA-01).
- `npm run lint`: no warnings or errors (CA-01).
- `npx tsc --noEmit --incremental false -p tsconfig.json`: no output (exit 0).
- `npm test`: 8 files, 124 tests passed (CA-01, CA-02, CA-18, CA-19).
- `npm run test:e2e`: run twice at the end, 14 files, 75 tests passed both times (CA-03 to CA-17, CA-20, CA-22). One earlier run failed 2 tests because the tests read `failed` before the worker had logged; fixed in the tests (one repair), then both full runs passed.
- `docker compose config`: `WORKER_ENABLED: null` appears under the app environment (CA-21). `grep` shows the single README row and the single compose line (CA-21, D-16).
- Scope: `git diff --stat -- src/events src/database src/main.ts src/health Dockerfile package.json package-lock.json` produced no output.
- Existing-suite diff: only `env: { WORKER_ENABLED: 'false' }` additions (plus prettier wrapping of those call arguments).
- Privacy review: `src/worker/events-worker.ts` has 7 logger calls, all D-10 templates; `lastError` messages are the 3 D-12 texts only.

Method and counts for CA-14 and CA-15 (the failpoint worked, so the wrapper fallback was not used):
- `mongod` started with `enableTestCommands=1`. Failpoints target `appName: events-worker-test`.
- CA-14(a): `failCommand` on `update`, `closeConnection: true` (MongoNetworkError), `times: 4`. Observed 5 `update` commands (4 failed, then success). Processor called once, no warn, document `done`.
- CA-14(b): same failpoint `alwaysOn`. One `Write for event <id> abandoned: Mongo...Error` warn, document stays `processing`, a second event processed after the failpoint was turned off.
- CA-14 short lease (`LEASE_MS=1500`): every `update` started before `lockedUntil`, and the test asserted 2 worker-level writes (ceil of update commands / 2), fewer than 1 + 3. The exact update command count was not printed (console output was not shown by vitest), only the asserted value.
- CA-15(a): `failCommand` on `findAndModify`, `errorCode: 2`, `times: 3` (non-retryable). Exactly 3 `Claim failed: MongoServerError (code 2)` warns, then `done`.
- CA-15(b): `mongo.stop()`, `Claim failed: Mongo...Error` warns appeared, `GET /health` returned 200 `{ status: 'ok' }`, unhandled-rejection spy empty.
- Wire write concern (D-11): the recorded `findAndModify` and `update` commands carry `{ w: 'majority', wtimeout: 5000 }`.
- Logger context: in `CaptureLogger` the text of a worker line is `<message> EventsWorker` (verified; `workerLines` strips that suffix).

Not run:
- Optional manual QA with `docker compose up --build` (no Docker daemon use).
- Throughput at 1000/min (Phase 6).

## 7. Changed-file inventory

Created: `src/worker/{event-processor,simulated-processor,simulated-processor.spec,backoff,backoff.spec,events-worker,worker.module}.ts`, `test/support/worker.ts`, `test/worker.e2e-spec.ts`, `test/worker-max-attempts.e2e-spec.ts`, `test/worker-timeout.e2e-spec.ts`, `test/worker-concurrency-1.e2e-spec.ts`, `test/worker-concurrency-2.e2e-spec.ts`, `test/worker-concurrency-3.e2e-spec.ts`, `test/worker-short-lease.e2e-spec.ts`, `test/worker-store-down.e2e-spec.ts`, `test/worker-disabled.e2e-spec.ts`, this report.

Modified: `src/app.module.ts`, `src/config/env.validation.ts`, `src/config/env.validation.spec.ts`, `docker-compose.yml`, `README.md`, `test/support/app.ts`, `test/support/mongo.ts`, `test/app.e2e-spec.ts`, `test/events.e2e-spec.ts`, `test/events-data-model.e2e-spec.ts`, `test/events-store-down.e2e-spec.ts`, `test/startup-failure.e2e-spec.ts`.

Deleted: none.

## 8. Outstanding work and blockers

None blocking. Known limits per the spec: no lease reclaim and no signal-driven shutdown or shutdown timeout (Phase 4); no throughput measurement (Phase 6). Known risk K-02: a lost acknowledgement followed by a D-07 retry would log a misleading stale-write warn.

## 9. Assessment handoff

Artifacts are ready for `/assess-spec`. This report does not claim acceptance approval.
