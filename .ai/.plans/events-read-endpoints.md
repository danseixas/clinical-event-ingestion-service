# Plan: Events read endpoints (`GET /health` with a bounded Mongo ping, new `GET /stats`)

## 1. Identity

- Plan status: PLANNED. Ready for implementation. Nothing in this plan has been executed. Every check below is planned only.
- Date: 2026-11-02.
- Spec: `.ai/.specs/events-read-endpoints.md`
- Spec SHA-256: `6bf83c6150c510b441ece99baae69cf5a37f6faa08007970966cdde654f14c39`
- Affected repositories: `clinical-event-ingestion-service` only (branch `main`, HEAD `84593be`). The spec file is untracked in the working tree.
- Planning sources read:
  - The spec, `PLAN.md` (Phase 5, Phase 6), `AGENTS.md`. There is no `CLAUDE.md` and no `.ai/docs/`.
  - Earlier artifacts: `.ai/.plans/events-crash-safety.md` (plan format, the one-env-per-file rule, the `tsc` test type-check).
  - Manifests and config: `package.json`, `tsconfig.json`, `vitest.config.ts` (unit `**/*.spec.ts`), `vitest.config.e2e.ts` (`**/*.e2e-spec.ts`), `.oxlintrc.json` (`typescript/no-floating-promises: error`), `docker-compose.yml`.
  - Source: `src/main.ts`, `src/app.module.ts`, `src/app.setup.ts`, `src/health/health.controller.ts`, `src/health/health.module.ts`, `src/database/database.module.ts`, `src/database/database.tokens.ts`, `src/events/events.module.ts`, `src/events/events.service.ts`, `src/events/events.service.spec.ts`, `src/events/store-errors.ts`, `src/events/event.document.ts`, `src/worker/worker.module.ts`.
  - Tests: `test/app.e2e-spec.ts`, `test/worker-store-down.e2e-spec.ts`, `test/events-store-down.e2e-spec.ts`, `test/process-signals.e2e-spec.ts`, `test/worker-disabled.e2e-spec.ts`, `test/worker.e2e-spec.ts` (failpoint helper), `test/worker-reclaim.e2e-spec.ts` and `test/events-data-model.e2e-spec.ts` (explain walkers), `test/support/app.ts`, `test/support/mongo.ts`, `test/support/worker.ts`, `test/support/capture-logger.ts`.
  - Installed packages: `@nestjs/common`/`@nestjs/core` 12.3.2 (`exceptions/http.exception.js` `createBody`, `exceptions/service-unavailable.exception.js`, `core/exceptions/base-exception-filter.js`), `mongodb` 7.8.0 (`lib/db.js` `command` accepts `timeoutMS` and `signal`; `lib/collection.js` `countDocuments` builds `[{ $match: filter }, { $group: { _id: 1, n: { $sum: 1 } } }]`). Local Node `v24.21.0`.

## 2. Readiness check

- Status line: "ready for implementation", updated 2026-11-02. Section 5 "Open questions": none blocking; the follow-ups belong to Phases 6 and 8.
- RF-01 to RF-03 each have a trigger, rules, output, exceptions and side effects. RNF-01 and RNF-02 are explicitly not applicable; RNF-03 and RNF-04 are concrete.
- D-01 to D-09 are concrete: exact bodies (D-01, D-04, RF-03), the 1000 ms bound and late-result handling (D-03), the exact filters, sort, projection and `maxTimeMS` (D-04, D-05), error classification and log text (D-06), module structure (D-09).
- CA-01 to CA-11 are observable with seeds, status codes, bodies, timings and log patterns. The section 13 consistency review maps every RF and decision to a CA.
- The four assumptions each have a confirmation path or a stated stop/fallback:
  - Nest object body (assumption 4) is confirmed from installed source: `HttpException.createBody(arg0, …)` returns a non-string, non-array, non-number `arg0` unchanged, and `BaseExceptionFilter.catch` replies with `getResponse()` as-is when it is an object. So `new ServiceUnavailableException({ status: 'error', mongo: 'down' })` sends exactly that body. CA-02/CA-04 still assert it.
  - Index use (assumption 1) is verified by CA-08; if it fails, implementation stops and reports (spec rule).
  - `ping` failpoint (assumption 2) has a spec-defined fallback (test-only `MONGO_CLIENT` wrapper); the method used must be recorded.
  - Stop timing (assumption 3): only the timing tolerance may be adjusted, recorded.
- Internal consistency checked:
  - `due + expiredLeases` uses exactly the Phase 4 claim branches observed in `src/worker/events-worker.ts`.
  - CA-06 arithmetic: pending 3 due + 2 future = 5; processing 4 live + 1 expired = 5; `due` 3; `expiredLeases` 1; oldest due = now − 10 s.
  - RF-03 body equals the existing `POST /events` 503 body asserted in `test/events-store-down.e2e-spec.ts`.
  - D-06 "`/health` logs nothing": Nest's `BaseExceptionFilter` logs only non-`HttpException` errors, so a thrown `ServiceUnavailableException` produces no log line.
- Repository facts that need specific handling, each resolved without changing product behaviour or acceptance meaning:
  1. One env per vitest file. `createTestApp` rejects a different `env` in the same file. The CAs need `WORKER_ENABLED=false` (most), `WORKER_ENABLED=true` (CA-04 worker variant, CA-09), and Mongo-stopping suites need their own replica set (spec section 9). Resolution: separate e2e files per configuration and per Mongo lifecycle (T-05 to T-09). The spec names test files as "suggested; may be split".
  2. CA-01 says the diff of `test/worker-store-down.e2e-spec.ts` is limited to the `/health` status/body lines, while CA-04 adds a 1500 ms timing and a no-log check to the worker-enabled variant. Resolution: in that file change only the two assertion lines (`200` → `503`, body); the timing and log checks for the worker-enabled variant live in a new file `test/health-worker-store-down.e2e-spec.ts` with the same setup (worker enabled, `mongo.stop()`, wait for `Claim failed: Mongo…Error`). Both CA-01 and CA-04 hold literally. Recorded as R-03.
  3. Failpoints are scoped by `appName` in existing suites (`TEST_APP_NAME` via `workerConfigure`). The `/health` slow-ping suite uses `workerConfigure({ uri })` (no processor) so the app client carries that `appName` and the test client is not affected.
  4. `CaptureLogger` stores `"<message> <context>"`. CA-07's anchored regex applies to the message, so tests strip the trailing ` StatsService` the same way `workerLines` strips ` EventsWorker`.
  5. `maxTimeMS` expiry (`MongoServerError` code 50) is not classified by `isStoreUnavailable()`. D-06 requires both; the extra check lives in `StatsService` (no change to `store-errors.ts`, which the spec's affected-areas list does not include).
  6. `npm run test:e2e` includes `test/process-signals.e2e-spec.ts`, which spawns `node dist/main.js`, so `npm run build` must run first. `npm run build` excludes spec files and vitest does not type-check, so tests are type-checked with `npx tsc --noEmit --incremental false -p tsconfig.json` as in earlier plans.
- Conclusion: implementation-ready. No blocking ambiguity.

## 3. Observed implementation context

Facts about the current state (HEAD `84593be`):

- Stack: NestJS 12.3.2, `mongodb` 7.8.0 (no Mongoose), TypeScript 6 `strict`, ESM with `.js` import suffixes, Node 24, vitest 4 (files run in parallel), `mongodb-memory-server` 11.3.0 pinned to MongoDB 7.0.45 via `package.json` `config`. Lint: `oxlint --type-aware src/ test/`.
- `src/health/health.controller.ts`: `@Controller('health')`, `@Get() check()` returns `{ status: 'ok' }`, comment "Liveness only for now…". `src/health/health.module.ts` declares only the controller.
- `src/app.module.ts`: imports `ConfigModule.forRoot({ isGlobal, cache, validate })`, `HealthModule`, `EventsModule`, `WorkerModule`.
- `src/database/database.module.ts`: provides and exports `MONGO_CLIENT` (`serverSelectionTimeoutMS: 5000`) and `EVENTS_COLLECTION`; connects and creates indexes in `onModuleInit`; closes in `onApplicationShutdown`. Exports `CLAIM_INDEX_NAME = 'claim_status_nextAttemptAt'` (`{ status: 1, nextAttemptAt: 1 }`). `EventsModule` and `WorkerModule` both `imports: [DatabaseModule]` (one shared module instance).
- `src/events/events.service.ts`: `mapError` logs `warn` `Event store unavailable: ${name}${code === undefined ? '' : ` (code ${code})`}` and returns `new ServiceUnavailableException('Event store unavailable, retry later')`; unexpected errors are returned unchanged. The message is a literal inside the class (not exported).
- `src/events/store-errors.ts`: exports `isStoreUnavailable(error)`.
- `src/events/event.document.ts`: `EventStatus = 'pending' | 'processing' | 'done' | 'failed'`; `nextAttemptAt: Date`; `lockedUntil?: Date`.
- `src/events/events.service.spec.ts`: unit style — construct the service with a fake collection (`as never`), replace `logger` with `{ warn: vi.fn() }`, a `rejection()` helper.
- Test support: `createTestApp({ mongoUri, logger, env, configure })` (one env per file); `startMongo(db, { enableTestCommands })`; `CaptureLogger` (`lines`, `all`); `workerEnv`, `workerConfigure({ uri, processor?, sink? })` (overrides `MONGO_CLIENT` with `appName: TEST_APP_NAME`, `monitorCommands`, optional command sink), `SpyProcessor`, `ScriptedProcessor`, `waitFor`, `seedEvent`, `workerLines`.
- Existing explain walkers: `test/events-data-model.e2e-spec.ts` `walkPlan` (recursive over all values, records `stage` and `IXSCAN` `indexName`) and `test/worker-reclaim.e2e-spec.ts` (walks `inputStage`/`inputStages`). Neither is exported.
- `/health` consumers: `test/app.e2e-spec.ts` (body `{ status: 'ok' }`), `test/worker-store-down.e2e-spec.ts` CA-15(b) (`200`, `{ status: 'ok' }` after `mongo.stop()`), `test/process-signals.e2e-spec.ts` (polls for `200` with Mongo up). No other test or source references `/health` or `/stats`.
- `docker-compose.yml` app healthcheck: `fetch('/health')`, `r.ok`, `interval 5s`, `timeout 3s`, `retries 5`. Not changed.
- `README.md`: the line "`GET /health` reports whether the app is up." under "Running"; a `## POST /events` section with the gateway/mTLS known limit; no `/stats`.
- Applicable instructions: `AGENTS.md` (optional NestJS Observe telemetry). Excluded by the spec (PLAN G12), so no task registers `ObserveModule` or touches `.env`.

## 4. Implementation strategy

- Boundaries: product changes only in `src/health/health.controller.ts`, `src/health/health.module.ts`, new `src/stats/stats.module.ts`, `src/stats/stats.controller.ts`, `src/stats/stats.service.ts`, and `src/app.module.ts`. Docs in `README.md`. Tests: two assertion lines in each of `test/app.e2e-spec.ts` and `test/worker-store-down.e2e-spec.ts`, one new unit spec, new e2e files, and an optional shared helper in `test/support/`. No change to `EventsService`, `EventsWorker`, `DatabaseModule`, `store-errors.ts`, `event.document.ts`, env validation, indexes, `docker-compose.yml`, `Dockerfile`, `package.json` or the lockfile.
- `/health` flow (RF-01, D-01, D-03): `HealthController` injects `MONGO_CLIENT`. Per request: start `client.db().command({ ping: 1 })`; race it against a 1000 ms timer (`HEALTH_PING_TIMEOUT_MS = 1000` constant). The timer is cleared when the ping settles first. A late resolve or reject of the ping is absorbed (a `.catch(() => undefined)` on the ping promise in addition to the race), so it cannot become an unhandled rejection. Resolve within the bound → return `{ status: 'ok', mongo: 'up' }` (200). Reject or timeout → `throw new ServiceUnavailableException({ status: 'error', mongo: 'down' })` (body exactly that object, verified in §2). No logger in the controller.
  - Chosen mechanism: timer race, not the driver's `timeoutMS`. Rationale: the spec allows either (D-03); the race bounds the response independently of driver CSOT semantics (which also cover server selection and connection checkout and surface as `MongoOperationTimeoutError`), and is deterministic for CA-03/CA-04. Reversible.
- `/stats` flow (RF-02, D-04, D-05): `StatsController` (`@Controller('stats')`, `@Get()`, no params) delegates to `StatsService.snapshot()`. `StatsService` injects `EVENTS_COLLECTION`. It takes `now = new Date()` once, then runs in parallel with `Promise.all`: `countDocuments({ status: s }, { maxTimeMS: 5000 })` for each of the four statuses; `countDocuments({ status: 'pending', nextAttemptAt: { $lte: now } }, …)`; `countDocuments({ status: 'processing', lockedUntil: { $lt: now } }, …)`; `findOne({ status: 'pending', nextAttemptAt: { $lte: now } }, { sort: { nextAttemptAt: 1 }, projection: { nextAttemptAt: 1 }, maxTimeMS: 5000 })`. No read concern, read preference or session options. Build `{ counts: { pending, processing, done, failed }, due, expiredLeases, oldestDueAgeMs, generatedAt: now.toISOString() }`, with `oldestDueAgeMs = due === 0 || !oldest ? 0 : Math.max(0, now.getTime() - oldest.nextAttemptAt.getTime())` (both are whole-ms `Date`s, so the result is an integer). Key order in the body follows D-04.
  - The filters are built by exported pure functions in `stats.service.ts` (for example `dueFilter(now)`, `expiredLeaseFilter(now)`, plus the `findOne` options), so the CA-08 explain test explains exactly what the service sends.
- `/stats` errors (RF-03, D-06): a single `try/catch` around the `Promise.all`. `Promise.all` subscribes to every promise, so additional parallel rejections are handled and only the first reaches the catch: exactly one warn per request. If `isStoreUnavailable(error)` or `error instanceof MongoServerError && error.code === 50`: log `warn` `Event store unavailable: <name>[ (code <code>)]` via `new Logger(StatsService.name)` and throw `new ServiceUnavailableException('Event store unavailable, retry later')`. Otherwise rethrow unchanged. Only the error name and code are logged, never the driver message (RNF-03). The message text is a module constant in `stats.service.ts` (the existing one in `EventsService` is a private literal and `EventsService` must not change).
- Module wiring (D-09): `HealthModule` `imports: [DatabaseModule]`; `StatsModule` `imports: [DatabaseModule]`, `controllers: [StatsController]`, `providers: [StatsService]`; `AppModule` adds `StatsModule`. Neither imports `WorkerModule` (D-02, D-09).
- Compatibility: `POST /events`, worker, indexes, startup failure semantics and every env var are untouched. The only externally visible change to existing behaviour is the `/health` body and the 503 when Mongo is unreachable, which the spec supersedes.
- Sequencing rationale: health product change and its two existing-assertion updates first (smallest, keeps the existing suites green), then stats service and module, then unit spec, then new e2e suites from simplest (Mongo up) to Mongo-stopping and worker-enabled suites, then README, then the full verification.
- Rejected alternatives:
  - `@nestjs/terminus` (D-09: no new dependency).
  - Setting the 503 via `@Res({ passthrough: true })`: unnecessary because the installed Nest sends the object body unchanged; it stays the documented fallback if CA-02/CA-04 deep-equality ever fails.
  - Adding the code-50 check to `isStoreUnavailable()`: would change `POST /events` classification, out of scope.
  - An aggregation `$facet` for all counts in one round trip: the spec fixes the D-05 query set.

## 5. Ordered tasks

### T-01 — `/health` with the bounded Mongo ping

- Outcome: `GET /health` answers per D-01 within the D-03 bound.
- IDs: RF-01, D-01, D-02, D-03, D-06, D-07, D-09, RNF-03, RNF-04.
- Dependencies: none.
- Files: `src/health/health.controller.ts`, `src/health/health.module.ts`.
- Changes: `HealthModule` imports `DatabaseModule`. `HealthController` constructor `@Inject(MONGO_CLIENT) private readonly client: MongoClient`. Constants `HEALTH_PING_TIMEOUT_MS = 1000`, the up body and the down body. `check()` implements the timer race from §4 and returns `{ status: 'ok', mongo: 'up' }` or throws `ServiceUnavailableException({ status: 'error', mongo: 'down' })`. Replace the "Liveness only for now" comment with a short comment on the bound and the absence of a draining state.
- Invariants: ping only through `MONGO_CLIENT`; no query on `events`; no logs; timer always cleared when the ping settles first; no floating promise (lint rule).
- Edge cases: ping rejects immediately (closed client, network error) → 503 at once; ping hangs → 503 at 1000 ms; ping settles after the bound → ignored; app closed while a ping is pending → the absorbed rejection does not leak.
- Completion evidence: `npm run build`, `npm run lint`; T-03 passes `test/app.e2e-spec.ts`.

### T-02 — Update the superseded `/health` assertions

- Outcome: the two existing suites expect the D-01 bodies.
- IDs: CA-01, CA-02, CA-04, Preserve.
- Dependencies: T-01.
- Files: `test/app.e2e-spec.ts` (`.expect({ status: 'ok' })` → `.expect({ status: 'ok', mongo: 'up' })`), `test/worker-store-down.e2e-spec.ts` (`expect(res.status).toBe(200)` → `503`; `expect(res.body).toEqual({ status: 'ok' })` → `{ status: 'error', mongo: 'down' }`).
- Invariants: no other line in either file changes (test titles, waits, the unhandled-rejection check stay). `test/process-signals.e2e-spec.ts` unchanged.
- Completion evidence: `git diff -- test/app.e2e-spec.ts test/worker-store-down.e2e-spec.ts` shows only those three lines.

### T-03 — `StatsService`, `StatsController`, `StatsModule`, registration

- Outcome: `GET /stats` returns the D-04 body or the D-06 errors.
- IDs: RF-02, RF-03, D-04, D-05, D-06, D-07, D-09, RNF-03, RNF-04.
- Dependencies: none (independent of T-01; ordered after it for review size).
- Files: new `src/stats/stats.service.ts`, `src/stats/stats.controller.ts`, `src/stats/stats.module.ts`; `src/app.module.ts` (import `StatsModule`).
- Changes: as in §4. Exported `StatsBody` type, `STATS_MAX_TIME_MS = 5000`, `STORE_UNAVAILABLE_MESSAGE`, the status list (typed `readonly EventStatus[]`), and pure filter/option builders for the due, expired-lease and oldest-due queries. Controller method with no `@Query()` so query parameters are ignored.
- Invariants: one `now` per request used by every filter and `generatedAt`; all four `counts` keys always present; no field from any event document returned (only the projected `nextAttemptAt`, converted to an age); no log on success; exactly one warn per failed request; context `StatsService`; non-store errors rethrown unchanged (Nest 500 and its `ExceptionsHandler` error log).
- Edge cases: empty collection (all zeros); only future pending (`due 0`, `oldestDueAgeMs 0`); `findOne` returns `null` while `due > 0` under concurrent change → `oldestDueAgeMs 0`; `due 0` but `findOne` non-null under concurrent change → follow D-04 "`0` when `due` is 0"; `MaxTimeMSExpired` → 503; several queries fail → one warn.
- Completion evidence: `npm run build`, `npm run lint`, T-04 unit spec, T-06/T-07 e2e.

### T-04 — Unit spec for `StatsService`

- Outcome: body construction and D-06 mapping verified without Mongo, including the `maxTimeMS` branch no e2e CA reproduces.
- IDs: RF-02, RF-03, D-04, D-06, RNF-03 (supplementary evidence for CA-06/CA-07).
- Dependencies: T-03.
- Files: new `src/stats/stats.service.spec.ts`, following the `events.service.spec.ts` pattern (fake collection `as never`, logger replaced with `{ warn: vi.fn() }`).
- Cases: body keys/order and `generatedAt` from a fixed `now` (fake timers or `vi.setSystemTime`); filters passed with `maxTimeMS: 5000` and the same `now`; `oldestDueAgeMs` 0 when `due` 0; `MongoServerSelectionError` → `ServiceUnavailableException` with the fixed message and one warn `Event store unavailable: MongoServerSelectionError`; `new MongoServerError({ code: 50, codeName: 'MaxTimeMSExpired', errmsg: … })` → 503 and one warn with ` (code 50)`; three parallel rejections → one warn; plain `Error('boom')` → rethrown same instance, no warn; warn text never contains the driver `errmsg`.
- Completion evidence: `npm test` passes.

### T-05 — e2e: `/health` up, slow, recovery

- Outcome: CA-02, CA-03, CA-05 automated; CA-10 checked for `/health`.
- IDs: CA-02, CA-03, CA-05, CA-10, RF-01, D-01, D-03, D-06.
- Dependencies: T-01.
- Files: new `test/health.e2e-spec.ts`.
- Setup: `startMongo('health_ping', { enableTestCommands: true })`, a test `MongoClient`, `createTestApp({ env: workerEnv({ WORKER_ENABLED: 'false' }), logger: CaptureLogger, configure: workerConfigure({ uri }) })` so the app client has `appName: TEST_APP_NAME`; `process.on('unhandledRejection', spy)` in `beforeAll`, removed in `afterAll`; failpoint turned `off` in `afterEach`.
- CA-02: `GET /health` → 200, `Content-Type` matches `/application\/json/`, body deep-equals `{ status: 'ok', mongo: 'up' }`.
- CA-03: `configureFailPoint: 'failCommand', mode: 'alwaysOn', data: { appName: TEST_APP_NAME, failCommands: ['ping'], blockConnection: true, blockTimeMS: 3000 }`; time `GET /health` → 503, body `{ status: 'error', mongo: 'down' }`, elapsed ≤ 1500 ms; then wait 3500 ms and assert the spy is empty. Confirm the failpoint actually delayed the ping (for example a direct `ping` from a second client with the same `appName` takes ≥ 2500 ms, or the command sink shows a `ping` started and the response came first). If `ping` cannot be targeted, use the spec fallback: a `configure` override of `MONGO_CLIENT` whose `db()` returns a `Db` with `command` wrapped to delay 3000 ms (or reject) while a test toggle is on, leaving `EVENTS_COLLECTION` working. Print `health ping slow method: <failCommand|wrapper>` in `afterAll`.
- CA-05: after CA-03, failpoint `off` (or toggle off) → `GET /health` → 200 `{ status: 'ok', mongo: 'up' }`.
- CA-10: across the file, `logger.lines` gains no entry during any `/health` request (snapshot length before, compare after), and no line contains `p-test-1`, `vitals`, `72` or an idempotency key.
- Edge cases: a still-blocked connection from CA-03 must not break CA-05 (the pool has other connections); `afterAll` closes the app before stopping Mongo.
- Completion evidence: file passes in `npm run test:e2e`; printed method.

### T-06 — e2e: `/stats` values, D-05 queries, index use

- Outcome: CA-06 and CA-08 automated; D-05 query shape and CA-10 checked for `/stats` success.
- IDs: CA-06, CA-08, CA-10, RF-02, D-04, D-05, D-07, RNF-03, RNF-04.
- Dependencies: T-03.
- Files: new `test/stats.e2e-spec.ts`; optionally a shared plan walker in `test/support/` (new file, for example `test/support/explain.ts`) if the implementer prefers not to inline it.
- Setup: `startMongo('stats')`, test client, `createTestApp({ env: workerEnv({ WORKER_ENABLED: 'false' }), logger, configure: workerConfigure({ uri, sink }) })`; `deleteMany({})` and clear sink/logger in `beforeEach`.
- CA-06 main seed with `T0 = Date.now()` via `seedEvent`: 3 `pending` with `nextAttemptAt` T0 − 10 s, − 5 s, − 1 s; 2 `pending` at T0 + 60 s; 4 `processing` (`attempts: 1`, `workerId`, `lockedUntil` T0 + 30 s); 1 `processing` with `lockedUntil` T0 − 1 s; 5 `done`; 2 `failed`. Record `start`/`end` around `GET /stats`. Assert `Object.keys(body)` equals `['counts','due','expiredLeases','oldestDueAgeMs','generatedAt']` and `Object.keys(body.counts)` the four statuses; exact counts `{ pending: 5, processing: 5, done: 5, failed: 2 }`, `due 3`, `expiredLeases 1`; `oldestDueAgeMs` integer in `[10000, 10000 + (end − T0)]`; `generatedAt` equals `new Date(generatedAt).toISOString()` and lies in `[start, end]`. Empty collection: all zeros. Future-only (2 future pending): `counts.pending 2`, `due 0`, `oldestDueAgeMs 0`. A request with `?foo=1` returns the same shape (query ignored).
- D-05 via the sink (app's `appName`): one `GET /stats` sends exactly 6 `aggregate` and 1 `find` on `events`, each with `maxTimeMS: 5000`, none with `readConcern`, `startTransaction` or `txnNumber`; the `find` has `sort { nextAttemptAt: 1 }`, `projection { nextAttemptAt: 1 }`, `limit 1`; all date bounds equal `generatedAt`.
- CA-08 over the CA-06 seed: for each query, build it with the exported builders and run `col.aggregate([{ $match: f }, { $group: { _id: 1, n: { $sum: 1 } } }]).explain('executionStats')` (the exact `countDocuments` pipeline) for the six counts, and `col.find(dueFilter(now), { sort, projection }).limit(1).explain('executionStats')` for the `findOne`. Collect every `winningPlan` object anywhere in the explain output (classic `$cursor` stage or SBE `queryPlan` shapes), walk them, and assert: at least one `IXSCAN` or `COUNT_SCAN` with `indexName === 'claim_status_nextAttemptAt'`, every index scan uses that index, no `COLLSCAN`, no `SORT` stage. Do not inspect `rejectedPlans`. Print each winning plan (`console.log('CA-08 <query>:', JSON.stringify(plan))`).
- CA-10: no `/stats` success logs (logger lines unchanged); response bodies contain none of `p-test-1`, `vitals`, `72`, `2026-11-02T10:00:00`, any seeded `_id` or `idempotencyKey`.
- Stop condition: if any CA-08 assertion fails, stop and report (spec assumption 1); do not add a hint or index.
- Completion evidence: file passes; printed winning plans.

### T-07 — e2e: Mongo stopped, worker disabled (`/health` and `/stats`)

- Outcome: CA-04 worker-disabled variant and CA-07 automated.
- IDs: CA-04, CA-07, CA-10, RF-01, RF-03, D-01, D-06, RNF-03, RNF-04.
- Dependencies: T-01, T-03.
- Files: new `test/read-endpoints-store-down.e2e-spec.ts`.
- Setup: `startMongo('read_store_down')`, `createTestApp({ env: workerEnv({ WORKER_ENABLED: 'false' }), logger })`, unhandled-rejection spy; one `it` (or ordered `it`s in one `describe`) because Mongo is stopped once: `await mongo.stop()`, clear logger lines.
- CA-04 (disabled): time `GET /health` → 503 `{ status: 'error', mongo: 'down' }` within 1500 ms; logger lines unchanged across the request.
- CA-07: time `GET /stats` → 503, body deep-equals `{ statusCode: 503, message: 'Event store unavailable, retry later', error: 'Service Unavailable' }`, within 10 s; exactly one `warn` whose text ends with ` StatsService` and whose message (context stripped) matches `^Event store unavailable: Mongo\w*Error( \(code \S+\))?$`; no other new lines. Wait about 1 s after the response, then assert the unhandled spy is empty.
- CA-10: no line contains seed or payload values (none seeded beyond an optional POST before the stop).
- `afterAll`: `app.close()`, `mongo.stop().catch(() => undefined)`, remove the spy. Print observed response times.
- Completion evidence: file passes; printed timings.

### T-08 — e2e: Mongo stopped, worker enabled (`/health` timing and silence)

- Outcome: CA-04 worker-enabled variant with the timing and log checks, without widening the CA-01 diff of `test/worker-store-down.e2e-spec.ts` (§2 item 2).
- IDs: CA-04, CA-10, RF-01, D-06.
- Dependencies: T-01.
- Files: new `test/health-worker-store-down.e2e-spec.ts`.
- Setup: mirrors `test/worker-store-down.e2e-spec.ts` (`startMongo('health_worker_store_down')`, `workerEnv({ POLL_INTERVAL_MS: '50' })`, `CaptureLogger`, unhandled spy, `app.listen(0)`). `mongo.stop()`, `waitFor` a `Claim failed: Mongo\w*Error` worker line (20 s). Snapshot `logger.lines.length`, time `GET /health`.
- Assertions: 503 `{ status: 'error', mongo: 'down' }` within 1500 ms; lines added between request and response all end with ` EventsWorker`; unhandled spy empty. Print the response time.
- Completion evidence: file passes.

### T-09 — e2e: `/stats` with the worker, two instances

- Outcome: CA-09 automated; CA-10 checked for posted events.
- IDs: CA-09, CA-10, RF-02, D-04, D-09.
- Dependencies: T-03.
- Files: new `test/stats-worker.e2e-spec.ts`.
- Setup: `startMongo('stats_worker')`, `workerEnv({ POLL_INTERVAL_MS: '50', PROCESSING_DELAY_MS: '50', FAILURE_RATE: '0' })`, processor `new SpyProcessor(new ScriptedProcessor(() => 'success'))`, two apps via `createTestApp` with `configure: workerConfigure({ uri, processor })` (same env, same database), shared `CaptureLogger`.
- Procedure: POST 20 events with distinct fictional `data` to app A; `waitFor` `GET /stats` on A until `counts.done === 20` (e.g. 30 s). Assert A's final body: `counts { pending: 0, processing: 0, done: 20, failed: 0 }`, `due 0`, `expiredLeases 0`, `oldestDueAgeMs 0`. Then `GET /stats` on B: `counts` deep-equal A's.
- CA-10: no log line or `/stats` body contains any posted `patientId`, `type`, `ts`, `data` value or any `idempotencyKey` read back from the collection; logger has no line from contexts other than `EventsWorker` (worker start lines are pre-existing D-10 lines, not new ones).
- Completion evidence: file passes.

### T-10 — README

- Outcome: CA-11.
- IDs: D-08, CA-11, RNF-03.
- Dependencies: T-01, T-03 (documents final behaviour).
- Files: `README.md`.
- Changes: remove the sentence "`GET /health` reports whether the app is up."; add `## GET /health` (200 `{"status":"ok","mongo":"up"}`, 503 `{"status":"error","mongo":"down"}`, the 1 s ping bound, no draining or readiness state, used by the Compose healthcheck) and `## GET /stats` (example body; definitions of `counts.*`, `due`, `expiredLeases` as a subset of `processing`, `oldestDueAgeMs` as the wait of the oldest due pending event, `generatedAt`; the 503 `Event store unavailable, retry later`; counts are separate queries and not a consistent snapshot; counting `done` grows with the collection; values come from the shared collection so all replicas agree; no authentication, same gateway/mTLS note). Placed next to the `POST /events` section.
- Completion evidence: `grep` checks in §6.

### T-11 — Full verification and report data

- Outcome: CA-01 and the spec's section 11 records.
- IDs: CA-01 to CA-11, RNF-04, Preserve.
- Dependencies: T-01 to T-10.
- Changes: none; runs the §6 commands in order and collects the records the spec asks for (Node and MongoDB versions, failpoint or wrapper method, CA-03/CA-04/CA-07 response times, CA-08 winning plans, pass/fail/blocked per CA).
- Completion evidence: command outputs; `git status`/`git diff --stat` show only the files listed in §4.

## 6. Verification plan

All checks are planned. None has been executed.

| Check | Command or procedure | Expected evidence | Criteria |
| --- | --- | --- | --- |
| Build | `npm run build` (must precede e2e: `process-signals` runs `dist/main.js`) | exit 0 | CA-01 |
| Lint | `npm run lint` | exit 0, no `no-floating-promises` finding | CA-01, RNF-04 |
| Type-check tests | `npx tsc --noEmit --incremental false -p tsconfig.json` | exit 0 | CA-01 (supplementary) |
| Unit | `npm test` | all pass, including `src/stats/stats.service.spec.ts` | CA-01, RF-02, RF-03, D-06 (supplementary) |
| e2e | `npm run test:e2e` | all pass: every Phase 1–4 suite, `test/app.e2e-spec.ts`, `test/worker-store-down.e2e-spec.ts`, unchanged `test/process-signals.e2e-spec.ts`, and the new `health`, `stats`, `read-endpoints-store-down`, `health-worker-store-down`, `stats-worker` files | CA-01 to CA-10 |
| Targeted reruns | `npx vitest run --config ./vitest.config.e2e.ts test/health.e2e-spec.ts` (and each new file) | per-file pass with printed timings, method and plans | CA-02 to CA-09 |
| Diff scope | `git diff --stat`; `git diff -- test/app.e2e-spec.ts test/worker-store-down.e2e-spec.ts`; `git status --short` | existing-test diff limited to the `/health` status/body lines; no change to `package.json`, lockfile, `docker-compose.yml`, `Dockerfile`, `src/events/*`, `src/worker/*`, `src/database/*`, `src/config/*` | CA-01, Preserve |
| README | `grep -n "GET /health\|GET /stats\|expiredLeases\|oldestDueAgeMs\|snapshot" README.md`; `grep -c "reports whether the app is up" README.md` → 0 | sections and definitions present; old sentence gone | CA-11 |
| Manual (optional) | spec section 11 Compose procedure (`docker compose up --build`, `curl -i localhost:3000/health`, POST, `curl localhost:3000/stats`, `docker compose stop mongo`, `docker compose ps`, `docker compose start mongo`) | 200/503 bodies, `unhealthy` then `healthy` | CA-02, CA-04, CA-05, CA-09 (supplementary) |

Limitations: `/stats` recovery after a Mongo restart is not automated (spec section 11). Failover cannot be reproduced on a one-member set. The D-02 shutdown-window 503 is not tested (negative scope). Timing assertions (1500 ms) run while vitest executes files in parallel; see R-01.

## 7. Risk and recovery

- R-01 Timing flakiness: CA-03/CA-04 assert ≤ 1500 ms under parallel e2e load. The bound is enforced by a local timer, so overhead is small; if a run exceeds it, record the observed time and rerun the file alone before concluding. Only the tolerance may be revisited, through the spec (assumption 3).
- R-02 `failCommand` on `ping` may be unsupported; fallback is the spec's test-only wrapper, and the method is recorded.
- R-03 CA-04's worker-enabled variant is split between the minimally edited `test/worker-store-down.e2e-spec.ts` (status/body) and the new `test/health-worker-store-down.e2e-spec.ts` (timing and log silence). This is an interpretation to satisfy both CA-01 and CA-04 literally; report it.
- R-04 CA-08 explain shape differs between the classic and SBE engines on 7.0.45 for `$group` pipelines; the walker collects every `winningPlan` and accepts `COUNT_SCAN`. If the claim index is not used, stop and report (spec rule).
- R-05 Behaviour change for operators: the Compose app turns `unhealthy` while Mongo is down (intended, D-01). `restart: unless-stopped` does not restart on unhealthy, so no restart loop.
- R-06 Cost of `counts.done` grows with collection size (accepted, documented in README).
- R-07 D-02 shutdown window: the observed Nest 12.3.2 order (crash-safety plan R-06) closes the HTTP server before `DatabaseModule` closes the client, so the "503 after client close" window may not occur in practice. No task depends on it and no CA tests it.
- Migrations, destructive actions, external actions: none. No index, data or config change. Rollback: revert the commit(s); no data cleanup needed because both routes are read-only.

## 8. Coverage matrix

| ID | Tasks | Checks |
| --- | --- | --- |
| RF-01 | T-01, T-02 | T-05 (CA-02, CA-03, CA-05), T-07, T-08 (CA-04), `test/app.e2e-spec.ts` |
| RF-02 | T-03, T-04 | T-06 (CA-06), T-09 (CA-09), unit spec |
| RF-03 | T-03, T-04 | T-07 (CA-07), unit spec |
| RNF-01 | Not applicable — backend only, no UI (spec) | — |
| RNF-02 | Not applicable — no UI (spec) | — |
| RNF-03 | T-01, T-03, T-04, T-10 | CA-10 checks in T-05 to T-09; unit spec warn text |
| RNF-04 | T-01, T-03, T-11 | CA-01 commands, CA-03/CA-04 timings, CA-08 plans, lint |
| D-01 | T-01, T-02 | CA-02, CA-03, CA-04, CA-05 |
| D-02 | T-01 (no worker dependency, no drain state), T-10 | Negative scope; CA-02/CA-04; code review that `HealthModule` imports only `DatabaseModule` |
| D-03 | T-01 | CA-03 (≤ 1500 ms, no unhandled rejection after 3500 ms) |
| D-04 | T-03, T-04 | CA-06, CA-09, unit spec |
| D-05 | T-03 | CA-08, T-06 sink assertions (6 aggregates + 1 find, `maxTimeMS: 5000`, no read concern/transaction) |
| D-06 | T-01, T-03, T-04 | CA-04, CA-07, CA-10, unit spec (code 50, non-store rethrow, one warn) |
| D-07 | T-03, T-10 | CA-10 |
| D-08 | T-10 | CA-11 |
| D-09 | T-01, T-03 | CA-01, CA-09 (worker enabled), T-05/T-06/T-07 (worker disabled) |
| CA-01 | T-02, T-11 | build, lint, `npm test`, `npm run test:e2e`, diff scope |
| CA-02 | T-01, T-02, T-05 | `test/health.e2e-spec.ts`, `test/app.e2e-spec.ts` |
| CA-03 | T-01, T-05 | `test/health.e2e-spec.ts` |
| CA-04 | T-01, T-02, T-07, T-08 | `test/read-endpoints-store-down.e2e-spec.ts`, `test/health-worker-store-down.e2e-spec.ts`, `test/worker-store-down.e2e-spec.ts` |
| CA-05 | T-01, T-05 | `test/health.e2e-spec.ts` |
| CA-06 | T-03, T-06 | `test/stats.e2e-spec.ts` |
| CA-07 | T-03, T-07 | `test/read-endpoints-store-down.e2e-spec.ts` |
| CA-08 | T-03, T-06 | `test/stats.e2e-spec.ts` explain |
| CA-09 | T-03, T-09 | `test/stats-worker.e2e-spec.ts` |
| CA-10 | T-05, T-06, T-07, T-08, T-09 | log and body checks in each file |
| CA-11 | T-10 | README grep |
| Preserve | T-02, T-11 | CA-01 full regression and diff scope |

## 9. Implementation handoff

- Prerequisites: `npm install` already satisfied (no new dependency); network access for `mongodb-memory-server` 7.0.45 on first e2e run; `npm run build` before `npm run test:e2e`.
- Permitted scope: the files in §4 "Boundaries" and the new test files in T-04 to T-09 (plus an optional `test/support/` helper). Commits only when the user asks.
- Not permitted: changes to `EventsService`, `EventsWorker`, `DatabaseModule`, `store-errors.ts`, `event.document.ts`, env validation, indexes, `docker-compose.yml`, `Dockerfile`, `package.json`, the lockfile, `PLAN.md`, the spec; registering `ObserveModule`.
- Report requirements: environment versions, `ping` slow method (failpoint or wrapper), CA-03/CA-04/CA-07 response times, CA-08 winning plans, R-03 interpretation, pass/fail/blocked per CA.
- Known non-blocking risks: R-01 to R-07.
- Stop conditions: CA-08 shows `COLLSCAN`, a blocking `SORT` or another index; CA-02/CA-04 body deep-equality fails with the exception approach and the `@Res({ passthrough: true })` fallback also fails.
- Confirmation: no blocking ambiguity remains. Every mandatory RF, RNF, D and CA identifier is mapped to tasks and checks.
