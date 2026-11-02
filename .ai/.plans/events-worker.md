# Plan: Events worker (claim, simulated external call, fenced outcome writes, bounded retries)

## 1. Identity

- Plan status: PLANNED. Ready for implementation. Nothing in this plan has been executed, and every check below is planned only.
- Date: 2026-11-02.
- Spec: `.ai/.specs/events-worker.md`
- Spec SHA-256: `c6afc6c45f90d24919cc36633d2b87fff7426b700ffa082277e4e5384ebd99f5`
- Affected repositories: `clinical-event-ingestion-service` only (branch `main`, HEAD `cc34e12`). The spec file is untracked in the working tree.
- Planning sources read:
  - The spec, `PLAN.md` (section 3 claim query, Phase 3, Phase 4), `AGENTS.md`. There is no `CLAUDE.md` and no `.ai/docs/`.
  - Earlier artifacts: `.ai/.plans/events-data-model.md` (its R-01 config-snapshot finding and its R-04 `tsc` type-check command), `.ai/.implementations/events-data-model.md` (recorded environment: Node v24.21.0, MongoDB 7.0.45).
  - Manifests and config: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `vitest.config.e2e.ts`, `.oxlintrc.json`, `docker-compose.yml`, `README.md` (Configuration table, lines 72 to 90).
  - Source: `src/app.module.ts`, `src/app.setup.ts`, `src/main.ts`, `src/config/env.validation.ts`, `src/config/env.validation.spec.ts`, `src/database/database.module.ts`, `src/database/database.tokens.ts`, `src/events/event.document.ts`, `src/events/store-errors.ts`, `src/events/events.service.ts`, `src/events/events.module.ts`.
  - Tests: `test/app.e2e-spec.ts`, `test/events.e2e-spec.ts`, `test/events-data-model.e2e-spec.ts`, `test/events-store-down.e2e-spec.ts`, `test/startup-failure.e2e-spec.ts`, `test/support/app.ts`, `test/support/mongo.ts`, `test/support/capture-logger.ts`.
  - Installed packages: `@nestjs/config` (`dist/config.module.js` `forRoot` and `assignVariablesToProcess`, `dist/config.service.js` `get`), `@nestjs/core` (`nest-application-context.js` `runShutdownSequence`), `mongodb` 7.8.0 (`lib/error.js`, `mongodb.d.ts` `appName`), `mongodb-memory-server-core` 11.3.0 (`lib/util/MongoInstance.js` `prepareCommandArgs`, `MongoInstance.d.ts` `args?: string[]`), `vitest` 4.1.12 (`isolate: true` default), `class-transformer` 0.5.1. Local Node `v24.21.0`. A `docker` CLI is on the PATH.

## 2. Readiness check

- Status line: "ready for implementation", updated 2026-11-02. Section 5 "Open questions": none blocking. The non-blocking follow-ups belong to Phases 4 and 6.
- RF-01 to RF-08 each have a trigger, rules, output, exceptions and side effects. RNF-01 and RNF-02 are explicitly not applicable. RNF-03 and RNF-04 are concrete.
- D-01 to D-16 are concrete. Exact log texts (D-10), stored error texts (D-12), the backoff formula (D-04), the fencing filter (D-03), the write concern (D-11), the retry policy (D-07) and the README row (D-16) are all fixed.
- CA-01 to CA-22 are observable. The section 13 consistency review maps every RF and every behaviour-affecting decision to at least one CA.
- The four section 5 assumptions each have a stated confirmation or fallback. The failpoint assumption has a spec-defined fallback (an `EVENTS_COLLECTION` wrapper), and the throughput and clock-skew assumptions are deferred to Phase 6 and Phase 4.
- Consistency checked across sections:
  - RF-06 ("`now < lockedUntil`") and D-07 ("no retry starts at or after `lockedUntil`") agree. R-07 places the check right before each resend.
  - CA-10's closed bound `[cap/2, cap]` is looser than D-04's `[cap/2, cap)`, so the two don't conflict.
  - Section 2 lists three suites to switch to `WORKER_ENABLED=false`. Section 9 lists five (it adds `test/app.e2e-spec.ts` and `test/startup-failure.e2e-spec.ts`). The longer list is a superset, and CA-22 ("the existing suites") covers both, so all five are switched.
- Repository facts that need specific handling. None is a spec contradiction, and each is resolved below without changing behaviour or acceptance meaning:
  1. `ConfigModule.forRoot` runs `validate` synchronously when `src/app.module.ts` is evaluated, and `createTestApp` imports it dynamically once per module graph. Every `createTestApp` call in one vitest file therefore shares the first call's configuration. Several CAs need different worker settings (concurrency 1, 2, 3 and 10; `MAX_ATTEMPTS` 3 and 1; a timeout variant; a short-lease variant; disabled). Resolution: one e2e file per distinct configuration. The spec's section 9 allows this ("may be split per config"). See R-01 and R-02.
  2. `forRoot` also writes validated values back into `process.env` for keys that aren't already set (`assignVariablesToProcess`). Resolution: each new worker e2e file passes the full set of worker variables explicitly, so no value can leak in from another file (R-02).
  3. `mongodb-memory-server` 11.3.0 doesn't pass `--setParameter enableTestCommands=1` (it isn't set in `prepareCommandArgs`), so `configureFailPoint` is probably refused by default. `MongoInstanceOpts.args` exists. Resolution: R-09.
  4. `ConfigService.get` returns the validated value first (`getFromInternalConfig`, then `getFromValidatedEnv`), so a `boolean` `WORKER_ENABLED` arrives typed. With `enableImplicitConversion`, class-transformer would turn `'false'` into `true`. Resolution: R-03.
  5. `npm run build` excludes `**/*spec.ts`, and vitest doesn't type-check. Test files are type-checked with `npx tsc --noEmit --incremental false -p tsconfig.json`, as in the data-model plan.
  6. Nest's close order is `onModuleDestroy`, then `beforeApplicationShutdown` for every module, then dispose, then `onApplicationShutdown`. This was confirmed in `runShutdownSequence`. `DatabaseModule.onApplicationShutdown` therefore closes the client only after the worker's `beforeApplicationShutdown` resolves, as D-02 requires.
- Conclusion: implementation-ready. No blocking ambiguity.

## 3. Observed implementation context

Facts about the current state:

- Stack: NestJS 12, `mongodb` 7.8.0 (no Mongoose), TypeScript 6 with `strict: true`, ESM (`"type": "module"`, `module: nodenext`, `.js` import suffixes), Node 24, vitest 4.1.12 (`globals: true`, unit `**/*.spec.ts`, e2e `**/*.e2e-spec.ts`), `mongodb-memory-server` 11.3.0 pinned to MongoDB `7.0.45` in `package.json` `config`.
- Lint: `oxlint --type-aware src/ test/` with `typescript/no-floating-promises: error`. A background loop start must use `void` or an explicit `.catch`.
- `src/app.module.ts` imports `ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv })`, `HealthModule` and `EventsModule`.
- `src/config/env.validation.ts`: `EnvironmentVariables` holds 12 settings with initializer defaults and class-validator decorators. `validateEnv` drops `''` values, runs `plainToInstance(..., { enableImplicitConversion: true })`, collects constraint messages, adds the two cross-field rules and throws `Invalid configuration:\n- …`. Its spec file covers defaults, conversion, blanks, rejection and "every problem at once".
- `src/database/database.module.ts` provides and exports `MONGO_CLIENT` and `EVENTS_COLLECTION` (`Collection<EventDocument>` on `events`). `onModuleInit` connects and creates three indexes, including `claim_status_nextAttemptAt` on `{ status: 1, nextAttemptAt: 1 }`. `onApplicationShutdown` closes the client. `serverSelectionTimeoutMS: 5000`.
- `src/events/event.document.ts`: `EventStatus`, `EventError { code, message, at }` and `EventDocument`, whose processing fields are optional and documented with presence rules. Not changed by this phase.
- `src/events/store-errors.ts`: `isStoreUnavailable(error)` returns true for server-selection, network, not-connected, topology-closed, client-closed and write-concern errors, and for any `MongoError` labelled `RetryableWriteError` or `TransientTransactionError`.
- `src/events/events.service.ts`: `WRITE_TIMEOUT_MS = 5000` with `writeConcern: { w: 'majority', wtimeoutMS }`. Its log format is `${name}${code === undefined ? '' : ` (code ${code})`}`. It uses `setTimeout as sleep` from `node:timers/promises`. Not changed by this phase.
- `src/main.ts` doesn't call `enableShutdownHooks`, so this phase stops only on `app.close()`.
- `docker-compose.yml`: the app `environment` list passes through `WORKER_CONCURRENCY` … `SHUTDOWN_TIMEOUT_MS`. `init: true` and `stop_grace_period: 30s` are set.
- `README.md` Configuration table: 13 rows, from `PORT` to `APP_PORT` (Compose only, last row).
- Test support:
  - `createTestApp({ mongoUri, logger, configure })` sets `process.env.MONGO_URI`, dynamically imports `AppModule`, applies `configure(builder)` (used for `overrideProvider`), sets the logger, calls `configureApp` and `app.init()`. `app.init()` runs `onApplicationBootstrap`, so a worker would start inside `createTestApp`.
  - `startMongo(dbName)` starts a one-member `MongoMemoryReplSet` (7.0.45) and returns `{ uri, version, stop }`.
  - `CaptureLogger` records `{ level, text }`, where `text` joins the message and all params, with non-strings JSON-stringified. Nest's `Logger` with a context passes the context as a trailing param, so a worker line's `text` is expected to be `<message> EventsWorker`. T-09 verifies this.
  - Existing suites override `MONGO_CLIENT` with a `monitorCommands: true` client to record `commandStarted` events.
- Existing assertions a running worker would break: `test/events.e2e-spec.ts` (stored documents stay `pending`/`attempts: 0`, lines 79 to 105 and 137 to 158), `test/events-data-model.e2e-spec.ts` (seeds `processing`/`done` documents directly) and `test/events-store-down.e2e-spec.ts` (exactly one `warn` after Mongo stops).
- Applicable instructions: `AGENTS.md` describes optional NestJS Observe telemetry. The spec excludes it (PLAN G12), so no task registers `ObserveModule`.

Proposed changes are described in sections 4 and 5 only.

## 4. Implementation strategy

### Boundaries

- New: `src/worker/` holds `worker.module.ts`, `events-worker.ts`, `event-processor.ts`, `simulated-processor.ts` and `backoff.ts`, plus colocated unit specs `backoff.spec.ts` and `simulated-processor.spec.ts`. These are the spec's suggested names. They fit the existing one-folder-per-module layout (`src/events/`, `src/health/`, `src/database/`).
- Changed: `src/app.module.ts` (import `WorkerModule`), `src/config/env.validation.ts` and its spec (`WORKER_ENABLED`), `docker-compose.yml` (one line), `README.md` (one row), `test/support/app.ts`, `test/support/mongo.ts` (backward-compatible options), the five existing e2e suites (`WORKER_ENABLED=false` only), new `test/support/worker.ts` and new `test/worker*.e2e-spec.ts` files.
- Unchanged: `src/events/**` (including `EventsService` and `EventDocument`), `src/database/**` (indexes and client lifecycle), `src/main.ts`, `src/health/**`, `Dockerfile`, `package.json`, `package-lock.json`, and all `tsconfig*`/`vitest*` configs.

### Control and data flow

1. `onApplicationBootstrap` (D-14): read the settings from `ConfigService<EnvironmentVariables, true>`. If `WORKER_ENABLED` is false, log `Worker disabled (WORKER_ENABLED=false)` and return. Otherwise build `workerId` (D-09), log `Worker started: concurrency <n>, workerId <id>`, and start the dispatcher with `void this.loop = this.run()`. `run` never rejects (R-05).
2. The dispatcher (D-13) is one `async` loop:
   - While not stopping: if in-flight == `WORKER_CONCURRENCY`, await a slot-freed or stop signal.
   - Otherwise claim (RF-02). If the claim throws, log `Claim failed: …` and wait idle. If it returns `null`, wait idle. If it returns an event, start an attempt (tracked in a `Set<Promise<void>>` that removes itself and wakes the loop on settle), then loop at once.
   - An event returned by a claim that was in flight when stop began is still started (RF-07).
3. An attempt (RF-03 to RF-06): call the processor under an `AbortController` with a `PROCESSING_TIMEOUT_MS` timer. Classify the result as success, `simulated_failure`, `timeout` or `processor_error`. Read `now` once and build one fenced `updateOne` (success, retry or final failure). Send it with the D-07 retry policy. Log only per D-10.
4. `beforeApplicationShutdown` (D-02, RF-07): set stopping, cancel the idle wait and wake the slot wait, await the loop promise, await every in-flight attempt until the set is empty, then log `Worker stopped`. If the worker is disabled or was never started, resolve at once without logging.

### Integration approach

- The processor is behind the `EVENT_PROCESSOR` symbol token. `WorkerModule` provides it with a factory that builds `SimulatedProcessor` from `ConfigService`. Tests replace it with `builder.overrideProvider(EVENT_PROCESSOR).useValue(...)` or `.useFactory(...)` through `createTestApp`'s `configure` hook (D-05).
- The worker injects `EVENTS_COLLECTION` from `DatabaseModule`, which is a singleton shared with `EventsModule`. It reuses `isStoreUnavailable` and the `EventDocument` and `EventError` types. It doesn't import `EventsService`.

### Sequencing rationale

- Pure units first: config, processor contract and simulator, backoff (T-01 to T-04). Then the worker class (T-05 to T-08), while it is not yet imported by `AppModule`, so the existing e2e suites stay green.
- Test support and the `WORKER_ENABLED=false` switch for existing suites (T-09, T-10) land before `AppModule` imports `WorkerModule` (T-11). Otherwise a running worker would break the Phase 1 and Phase 2 assertions.
- New e2e files (T-12 to T-19) come after wiring. Final verification is T-20.

### Resolved low-risk technical details

- R-01 (one config per file): the env config is fixed per vitest file (section 2, fact 1). The new e2e coverage is split into eight files, one per configuration. Within a file each scenario boots its own app in `beforeEach` (same config, fresh worker and processor double) and closes it in `afterEach`. Before boot, the file clears documents with `deleteMany({})`, not `dropDatabase()`, so the app-created indexes stay in place and claims keep using `claim_status_nextAttemptAt`. Each file starts one replica set.
- R-02 (explicit env): `createTestApp` gains an optional `env?: Record<string, string>`. Each entry is assigned to `process.env` before the dynamic `AppModule` import, as `MONGO_URI` already is. `createTestApp` remembers the first `env` it applied in the file and throws `createTestApp: env differs from the first call in this file` if a later call passes a different one. This stops a test from silently running under the wrong config. `test/support/worker.ts` exports `workerEnv(overrides)`, which returns all 11 worker variables (`WORKER_ENABLED`, `WORKER_CONCURRENCY`, `LEASE_MS`, `POLL_INTERVAL_MS`, `PROCESSING_DELAY_MS`, `PROCESSING_TIMEOUT_MS`, `FAILURE_RATE`, `MAX_ATTEMPTS`, `BACKOFF_BASE_MS`, `BACKOFF_MAX_MS`, `SHUTDOWN_TIMEOUT_MS`) with the spec's small test defaults plus the overrides. That makes each file independent of leaked `process.env` values.
- R-03 (`WORKER_ENABLED` parsing): the property is `WORKER_ENABLED: boolean = true`, decorated with `@Transform(({ obj, key }) => obj[key] === 'true' ? true : obj[key] === 'false' ? false : obj[key])` and `@IsBoolean({ message: 'WORKER_ENABLED must be true or false' })`. The transform reads the raw source value (`obj[key]`), so implicit conversion can't turn `'false'` into `true`. `''` is already dropped by `validateEnv`, so blank keeps the initializer default. Any other string (`'FALSE'`, `'yes'`, `'1'`) stays a string and fails `IsBoolean` with the exact D-08 message. The message is collected with the others into `Invalid configuration:\n- …`.
- R-04 (simulator timing): the simulator's delay uses global `setTimeout` and `clearTimeout` with an abort listener, not `node:timers/promises`. vitest fake timers then control it without any assumption about `timers/promises` support (CA-19). The simulator exports `SimulatedFailureError` (`name = 'SimulatedFailureError'`), and the worker classifies with `instanceof`. Fail iff `random() < FAILURE_RATE` (CA-19 equality case). On abort, or if the signal is already aborted at call time, it clears the timer and rejects at once with `signal.reason`.
- R-05 (no unhandled rejection): `run()` wraps each iteration so no error escapes. Each attempt wraps its whole body in `try/catch`. When the timeout wins, the worker attaches a no-op `.catch` to the processor promise it abandons, so a late rejection is handled and its value ignored (D-06, CA-15). The loop and attempt promises are only awaited in stop.
- R-06 (single `now` per outcome): one `new Date()` is read when the outcome is built. It is used for `processedAt`, `lastError.at` and the base of `nextAttemptAt`, and the same update document is resent on every D-07 retry ("identical update"). As a result `nextAttemptAt − lastError.at` equals the backoff delay exactly (CA-10). A separate `new Date()` is read for each claim (D-11).
- R-07 (retry guard): after a write throws, the worker checks `isStoreUnavailable(error)` and the remaining retries (3 total). If both allow a retry, it waits 1 s, then checks `Date.now() < lockedUntil` (the `lockedUntil` returned by this claim) right before resending. If any check fails, it logs the abandoned-write `warn` with the last error's name and code. This satisfies both RF-06 and D-07 ("no retry starts at or after `lockedUntil`"). The 1 s wait isn't cancelled by stop: D-02 waits for retries to settle.
- R-08 (error description helper): a private worker helper formats `<name>[ (code <code>)]` the same way `EventsService.mapError` does. `name` comes from `error.name` when it is a string, otherwise `'Error'`. It is duplicated rather than shared, because the spec forbids changing `EventsService`.
- R-09 (failpoint availability): `startMongo(dbName, options?)` gains an optional `{ enableTestCommands?: boolean }`. When it is true, it passes `instanceOpts: [{ args: ['--setParameter', 'enableTestCommands=1'] }]` to `MongoMemoryReplSet.create`. The default is unchanged, so existing suites start the same way. CA-14 and CA-15(a) first issue `configureFailPoint` (`mode: 'off'`) as a probe. If it is refused, they use the spec's fallback: override `EVENTS_COLLECTION` with a factory (injecting `MONGO_CLIENT`) that returns a `Proxy` over the real collection, whose `updateOne` or `findOneAndUpdate` throws `new MongoNetworkError('simulated')` a set number of times. The implementation report records which method was used and the counts.
- R-10 (failpoint targeting): apps under test set `appName: 'events-worker-test'` on their overridden `MONGO_CLIENT`. Failpoints use `data.appName` with that value and `failCommands: ['update']` (CA-14) or `['findAndModify']` (CA-15(a)), so the raw test client is never affected.
- R-11 (workerId): `` `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}` `` from `node:os` and `node:crypto`, built once in `onApplicationBootstrap` (D-09).
- R-12 (backoff overflow): `computeBackoffMs` returns 0 when `baseMs === 0`, before computing `2^(n−1)`. This avoids `0 × Infinity = NaN` at very large attempt numbers. `Math.min(maxMs, baseMs * 2 ** (n - 1))` handles `Infinity` otherwise. The result is `Math.floor(cap / 2 + random() * cap / 2)` (D-04).
- R-13 (log placement): `README.md` gets the D-16 row directly after `SHUTDOWN_TIMEOUT_MS` and before the Compose-only `APP_PORT`. `docker-compose.yml` gets `- WORKER_ENABLED` after `- SHUTDOWN_TIMEOUT_MS`. `EnvironmentVariables` gets the property after `SHUTDOWN_TIMEOUT_MS`, with a one-line comment matching the file's density.
- R-14 (fixed constants): `WRITE_TIMEOUT_MS = 5000`, `OUTCOME_WRITE_RETRIES = 3` and `OUTCOME_WRITE_RETRY_DELAY_MS = 1000` are module-level constants in `events-worker.ts`. The three D-12 codes and messages are constants too (RNF-04).

### Rejected alternatives

- Overriding a settings provider instead of using real env per file: it would bypass `validateEnv`, so CA-17 and the config-driven CAs would no longer exercise the real path. Rejected in favour of R-01 and R-02.
- `vi.resetModules()` to re-evaluate `AppModule` per scenario: it would re-create the token symbols (`MONGO_CLIENT`, `EVENTS_COLLECTION`, `EVENT_PROCESSOR`), and the test files' static imports would no longer match. Rejected.
- `dropDatabase()` between scenarios (the data-model plan's choice): it would drop the indexes the running app created. Rejected for `deleteMany({})` (R-01).
- One claim loop per slot: the spec chose a single dispatcher (D-13).
- Sharing a log-format helper with `EventsService`: it would require changing `EventsService`, which the spec forbids (R-08).

## 5. Ordered tasks

### T-01 — `WORKER_ENABLED` setting and unit tests

- Outcome: `validateEnv` returns a boolean `WORKER_ENABLED`, default `true`, accepting exactly `'true'` and `'false'`.
- Traces: RF-08, D-08, CA-02, RNF-04.
- Dependencies: none.
- Areas: `src/config/env.validation.ts`, `src/config/env.validation.spec.ts`.
- Changes: add the property per R-03 and R-13, importing `IsBoolean` from `class-validator` and `Transform` from `class-transformer`, which is already a dependency. Add spec cases: unset, `''` and `'true'` give `true`; `'false'` gives `false`; `'FALSE'`, `'yes'` and `'1'` each throw an error containing `WORKER_ENABLED must be true or false`; `{ WORKER_ENABLED: 'yes', WORKER_CONCURRENCY: '0' }` lists both messages.
- Invariants: existing defaults, messages and cross-field rules are unchanged. Existing spec cases pass unchanged.
- Edge cases: no trimming or case folding (`' true'` is rejected). Blank still means the default.
- Completion evidence: `npm test` passes `env.validation.spec.ts`.

### T-02 — Compose pass-through and README row

- Outcome: Compose forwards `WORKER_ENABLED` and the README documents it.
- Traces: RF-08, D-08, D-16, CA-21.
- Dependencies: none.
- Areas: `docker-compose.yml`, `README.md`.
- Changes: add `      - WORKER_ENABLED` after `- SHUTDOWN_TIMEOUT_MS`. Add the row `` | `WORKER_ENABLED` | `true` | Run the background worker in this process (`true` or `false`) | `` after the `SHUTDOWN_TIMEOUT_MS` row (R-13).
- Invariants: no other Compose or README change (D-16; Preserve: Dockerfile and Compose).
- Completion evidence: `docker compose config` lists `WORKER_ENABLED` under `app.environment`, and `git diff README.md docker-compose.yml` shows exactly one added line in each file.

### T-03 — Processor contract and simulator, with unit tests

- Outcome: the `EVENT_PROCESSOR` token and contract exist, and `SimulatedProcessor` implements D-06.
- Traces: RF-03, D-05, D-06, CA-19, RNF-03, RNF-04.
- Dependencies: none.
- Areas: new `src/worker/event-processor.ts`, `src/worker/simulated-processor.ts`, `src/worker/simulated-processor.spec.ts`.
- Changes:
  - `event-processor.ts` exports `EVENT_PROCESSOR = Symbol('EVENT_PROCESSOR')`, `interface EventProcessorInput { eventId: string; idempotencyKey: string; patientId: string; type: string; ts: Date; data: Record<string, unknown> }` and `interface EventProcessor { process(input: EventProcessorInput, signal: AbortSignal): Promise<Record<string, unknown>> }`.
  - `simulated-processor.ts` exports `SimulatedFailureError` and `SimulatedProcessor` (constructor `{ delayMs, failureRate }` and an optional `random: () => number = Math.random`), per R-04. It ignores the input content and resolves `{ simulated: true }`.
  - The spec uses fake timers: rate 0 resolves only after `delayMs`; rate 1 rejects with `SimulatedFailureError` only after `delayMs`; random equal to the rate succeeds; random just below the rate fails; abort mid-delay rejects at once (before the timers advance); an already-aborted signal rejects at once.
- Invariants: no logging. The input is never stored or echoed.
- Completion evidence: `npm test` passes `simulated-processor.spec.ts`.

### T-04 — Backoff function, with unit tests

- Outcome: `computeBackoffMs(attempt, { baseMs, maxMs }, random = Math.random): number` implements D-04.
- Traces: D-04, RF-05, CA-18.
- Dependencies: none.
- Areas: new `src/worker/backoff.ts`, `src/worker/backoff.spec.ts`.
- Changes: per R-12. The spec runs n = 1..8 with base 1000 and max 60000 and random 0 and 0.999999. It asserts `Number.isInteger`, `delay >= cap/2` and `delay < cap` for `cap = min(60000, 1000·2^(n−1))`, and that cap = 60000 from n = 7. It also checks base 0 (always 0) and base = max (cap constant).
- Edge cases: base 0 with large n (no `NaN`). With `random` = 0 the result is exactly `cap/2` for even caps.
- Completion evidence: `npm test` passes `backoff.spec.ts`.

### T-05 — `WorkerModule`, lifecycle and dispatcher with claim

- Outcome: an `EventsWorker` provider that starts on bootstrap, logs per D-10, and claims with bounded concurrency. The module is not yet imported by `AppModule`.
- Traces: RF-01, RF-02, D-01, D-09, D-10, D-11, D-13, D-14, RNF-03, RNF-04.
- Dependencies: T-01, T-03.
- Areas: new `src/worker/worker.module.ts`, `src/worker/events-worker.ts`.
- Changes:
  - `WorkerModule`: `imports: [DatabaseModule]`, `providers: [EventsWorker, { provide: EVENT_PROCESSOR, inject: [ConfigService], useFactory: (config) => new SimulatedProcessor({ delayMs: PROCESSING_DELAY_MS, failureRate: FAILURE_RATE }) }]`.
  - `EventsWorker implements OnApplicationBootstrap, BeforeApplicationShutdown`, with `private readonly logger = new Logger(EventsWorker.name)` (context `EventsWorker`). It injects `EVENTS_COLLECTION`, `EVENT_PROCESSOR` and `ConfigService<EnvironmentVariables, true>`.
  - `onApplicationBootstrap` follows section 4, step 1 (R-11).
  - The claim is exactly `findOneAndUpdate({ status: 'pending', nextAttemptAt: { $lte: now } }, { $set: { status: 'processing', workerId, lockedUntil: new Date(now + LEASE_MS) }, $inc: { attempts: 1 } }, { sort: { nextAttemptAt: 1 }, returnDocument: 'after', writeConcern: { w: 'majority', wtimeoutMS: WRITE_TIMEOUT_MS } })`. `now` is a fresh `new Date()` per claim.
  - The dispatcher follows section 4, step 2. The idle wait is a cancellable timer of `POLL_INTERVAL_MS`. The slot wait is a promise resolved by an attempt settling or by stop.
  - Claim errors log `Claim failed: <name>[ (code <code>)]` (R-08) and then wait idle.
- Invariants: bootstrap returns without awaiting the loop. Nothing is sent when disabled. No patient grouping. No `processing`/expired-lease branch in the filter (D-01).
- Edge cases: concurrency 1. A claim that is in flight at stop. A claim error when Mongo is unreachable (each one takes up to `serverSelectionTimeoutMS`, 5 s).
- Completion evidence: `npm run build` and `npm run lint` pass. Behaviour is verified by T-12 to T-19.

### T-06 — Attempt: processor call, timeout and classification

- Outcome: each claimed event is processed under a timeout and classified.
- Traces: RF-03, D-05, D-06, D-12, RNF-03.
- Dependencies: T-05.
- Areas: `src/worker/events-worker.ts`.
- Changes:
  - Build the input `{ eventId: doc._id.toHexString(), idempotencyKey, patientId, type, ts, data }`.
  - Create an `AbortController` and a `setTimeout(PROCESSING_TIMEOUT_MS)` that aborts and settles as `timeout`. Call `processor.process(input, signal)` inside `try`, so a synchronous throw becomes `processor_error`.
  - Race the call against the timer and clear the timer if the call settles first. When the timer wins, ignore any late result (R-05).
  - Classify: resolved means success with `result`; `SimulatedFailureError` means `simulated_failure`; anything else means `processor_error`.
  - Build `lastError` with the fixed D-12 texts (R-14). The timeout text is `` `External call timed out after ${PROCESSING_TIMEOUT_MS} ms` ``.
- Invariants: the processor is called exactly once per attempt. No logging of input, result or error messages. The original error text is never stored.
- Edge cases: a processor that ignores abort (the attempt still settles at the timeout). A processor that rejects after the timeout (handled, ignored).
- Completion evidence: build and lint pass. Verified by CA-03, CA-10, CA-11, CA-12.

### T-07 — Fenced outcome writes, backoff, final failure and write retry

- Outcome: the success, retry and final-failure writes follow D-03, D-04, D-11, D-15, with the D-07 retry.
- Traces: RF-04, RF-05, RF-06, D-03, D-04, D-07, D-10, D-11, D-12, D-15, RNF-03, RNF-04.
- Dependencies: T-04, T-06.
- Areas: `src/worker/events-worker.ts`.
- Changes:
  - Filter: `{ _id, status: 'processing', workerId: this.workerId, attempts: claimed.attempts }`.
  - Success: `{ $set: { status: 'done', result, processedAt: now }, $unset: { workerId: '', lockedUntil: '' } }`.
  - Failure with `attempts < MAX_ATTEMPTS`: `{ $set: { status: 'pending', nextAttemptAt: new Date(now.getTime() + computeBackoffMs(attempts, { baseMs: BACKOFF_BASE_MS, maxMs: BACKOFF_MAX_MS })), lastError }, $unset: { workerId: '', lockedUntil: '' } }`.
  - Failure with `attempts >= MAX_ATTEMPTS`: `{ $set: { status: 'failed', processedAt: now, lastError }, $unset: { workerId: '', lockedUntil: '' } }`.
  - Every write is `updateOne(filter, update, { writeConcern: { w: 'majority', wtimeoutMS: WRITE_TIMEOUT_MS } })`.
  - `matchedCount === 0` logs `Stale write discarded for event <_id hex> (attempt <attempts>)`. A final failure with `matchedCount === 1` logs `Event <_id hex> failed after <attempts> attempts (<code>)`. Success and non-final retry log nothing.
  - On a thrown error, apply R-07. On abandon, log `Write for event <_id hex> abandoned: <name>[ (code <code>)]` and release the slot.
- Invariants: `attempts` is never written by outcome writes. `lastError` is never touched on success. Payload fields and `idempotencyKey` are never written (RNF-03). One `now` per outcome (R-06).
- Edge cases: `MAX_ATTEMPTS=1`. `MAX_ATTEMPTS` lowered below the stored `attempts` (`>=`). A worker-level retry after a lost acknowledgement matches 0 and logs a stale `warn` (see section 7, K-02).
- Completion evidence: build and lint pass. Verified by CA-10, CA-11, CA-13, CA-14.

### T-08 — Stop on close

- Outcome: `beforeApplicationShutdown` implements D-02 and RF-07.
- Traces: RF-07, D-02, D-10, D-13.
- Dependencies: T-05, T-07.
- Areas: `src/worker/events-worker.ts`.
- Changes: section 4, step 4. Make it idempotent: a second call awaits the same promise. After it resolves, no timer remains scheduled and no further Mongo command is sent by the worker.
- Invariants: no time bound (Phase 4). The D-07 retry waits are not cancelled. `DatabaseModule` closes the client afterwards (section 2, fact 6).
- Edge cases: stop while a claim is in flight (its event is processed). Stop while the pool is full. Stop when disabled or never started (no log). Stop with Mongo down (an in-flight claim may take up to 5 s to fail).
- Completion evidence: build and lint pass. Verified by CA-16.

### T-09 — Test support for worker scenarios

- Outcome: shared helpers for config-per-file, failpoints and controllable processors.
- Traces: CA-03 to CA-17, CA-20, CA-22 (support only), D-05.
- Dependencies: T-03.
- Areas: `test/support/app.ts`, `test/support/mongo.ts`, new `test/support/worker.ts`.
- Changes:
  - `createTestApp` gains `env` and the guard (R-02). The `env` field is optional, so existing callers compile.
  - `startMongo` gains `{ enableTestCommands }` (R-09). The default is unchanged.
  - `test/support/worker.ts` exports:
    - `workerEnv(overrides)` (R-02).
    - `monitoredClientOverride(uri, sink)`, which returns a `configure` function overriding `MONGO_CLIENT` with `{ serverSelectionTimeoutMS: 5000, monitorCommands: true, appName: 'events-worker-test' }` and pushing `{ name, command, at }` into `sink` (R-10).
    - `BlockingProcessor`, which records calls (input, signal, start time), tracks current and maximum in-flight counts, and settles each call through `release(i, outcome)` or `releaseAll(outcome)`.
    - `ScriptedProcessor`, which maps a per-event call number to an outcome: resolve, `SimulatedFailureError`, or a plain `Error`.
    - `SpyProcessor`, which wraps another processor and records inputs and settle kinds.
    - `waitFor(predicate, timeoutMs)` polling, and `seedEvent(overrides)`, which builds a Phase 1 shaped document with a unique `idempotencyKey` and fictional values.
    - `workerLines(logger)`, which keeps captured lines ending in ` EventsWorker`, strips that suffix, and returns `{ level, message }`. It must first verify how the context appears in `CaptureLogger.text` and adapt the stripping if it differs.
    - `D10_PATTERNS`, the seven anchored regexes from D-10.
- Invariants: existing suites' behaviour is unchanged by these additions.
- Completion evidence: `npx tsc --noEmit --incremental false -p tsconfig.json` passes. `npm run test:e2e` still passes before T-11.

### T-10 — Existing suites run with the worker disabled

- Outcome: the five existing e2e suites pass `env: { WORKER_ENABLED: 'false' }` to every `createTestApp` call, and nothing else changes.
- Traces: CA-22, D-08, Preserve.
- Dependencies: T-01, T-09.
- Areas: `test/app.e2e-spec.ts`, `test/events.e2e-spec.ts`, `test/events-data-model.e2e-spec.ts` (every call, including the in-file second boot near line 86), `test/events-store-down.e2e-spec.ts`, `test/startup-failure.e2e-spec.ts`.
- Invariants: no assertion is added, removed or edited. The `Worker disabled (WORKER_ENABLED=false)` line contains none of the strings those suites forbid in logs (`p-test-1`, `vitals`, `2026-11-02`, `72`, `"hr"`, the idempotency key or the index names). `events-store-down` counts only `warn` lines, and the disabled worker emits a `log` line.
- Completion evidence: `git diff test/*.e2e-spec.ts` shows only the `env` argument. `npm run test:e2e` passes.

### T-11 — Wire `WorkerModule` into `AppModule`

- Outcome: the worker runs in every app (D-14).
- Traces: D-14, RF-01.
- Dependencies: T-05 to T-08, T-10.
- Areas: `src/app.module.ts`.
- Changes: add `WorkerModule` to `imports` after `EventsModule`.
- Invariants: `HealthModule` and `EventsModule` are unchanged. No change to `main.ts` (`enableShutdownHooks` belongs to Phase 4).
- Completion evidence: `npm run build` passes. The existing suites still pass (CA-22).

### T-12 — Main worker e2e file (concurrency 10, small timings)

- Outcome: covers CA-03, CA-04, CA-05, CA-09, CA-10, CA-13, CA-14(a)(b), CA-15(a) and the CA-20 log checks for those scenarios.
- Traces: RF-02 to RF-06, D-01, D-03 to D-07, D-09 to D-12, RNF-03, CA-03, CA-04, CA-05, CA-09, CA-10, CA-13, CA-14, CA-15, CA-20.
- Dependencies: T-09, T-11.
- Areas: new `test/worker.e2e-spec.ts`.
- Setup: `startMongo('worker', { enableTestCommands: true })`. Env: `workerEnv({ WORKER_CONCURRENCY: '10', POLL_INTERVAL_MS: '50', PROCESSING_DELAY_MS: '50', FAILURE_RATE: '0', BACKOFF_BASE_MS: '200', BACKOFF_MAX_MS: '10000' })`. The other variables keep their app defaults (`LEASE_MS` 30000, `PROCESSING_TIMEOUT_MS` 10000, `MAX_ATTEMPTS` 5). Each test gets a fresh app per R-01, a raw test client, a `CaptureLogger` and a command sink.
- Scenarios:
  - CA-03: `SpyProcessor` over `new SimulatedProcessor({ delayMs: 50, failureRate: 0 })`. `POST /events` with a fictional body, then poll for up to 10 s until the document isn't `pending`/`processing`. Assert the exact field set and values from CA-03 and compare the payload fields and `idempotencyKey` with the stored values. The spy's `idempotencyKey` and `eventId` must match the document.
  - CA-04: `BlockingProcessor`. Seed one due event. While blocked, assert `processing`, `attempts: 1`, the `workerId` regex, and `lockedUntil` within ±1000 ms of call start + 30000. Release with success and assert `done` with the lock fields absent.
  - CA-05: seed the six documents. Wait 500 ms (10 × poll) and then until the due event is `done`. Deep-equal the other five against their seeded state.
  - CA-09: two apps in the same test, built with the same env so the guard passes, each with its own `SpyProcessor` (always succeeds). Insert 200 distinct due events after both have booted. Wait until all are `done`. Assert `attempts: 1` for all, 200 total spy calls, every key seen once, and both spies with at least one call.
  - CA-10: `ScriptedProcessor`: `SimulatedFailureError` on calls 1 and 2, success on call 3. Poll snapshots every 10 ms. For each `pending` snapshot with `attempts` 1 and 2, assert no lock fields, the exact `lastError` code and message, and `nextAttemptAt − lastError.at ∈ [cap/2, cap]` for caps 200 and 400. Final state: `done`, `attempts: 3`, `lastError` from attempt 2. Zero `warn` lines.
  - CA-13: three runs with `BlockingProcessor`: `$inc: { attempts: 1 }` then success release; `$inc` then failure release; `$set: { workerId: 'other' }` then success release. After each, wait for the worker `warn` and assert it equals `Stale write discarded for event <id> (attempt 1)`. Assert the document deep-equals a snapshot taken right after the manual change.
  - CA-14(a): `failCommand` on `update` for `appName` with `mode: { times: N }`. N is chosen so that the first write and the first worker retry fail and the second retry succeeds. The planned starting value is N = 4 (2 worker-level failures × [1 + 1 driver retry]); adjust it from the observed `update` command count and record it. Use either `closeConnection: true` or `errorCode: 91` with `errorLabels: ['RetryableWriteError']` (either satisfies `isStoreUnavailable`; record which). Assert `done`, processor calls = 1, no `warn`.
  - CA-14(b): `mode: 'alwaysOn'`. Wait for the abandoned `warn` (about 3 s plus processing). Assert it matches `^Write for event <id> abandoned: Mongo\w*Error`, exactly one such line, and the document `processing`, `attempts: 1`, lock fields present. Set the failpoint `off`, seed a second event and assert it reaches `done`. Fallback: the R-09 wrapper.
  - CA-15(a): `failCommand` on `findAndModify` with `times: 3` and a non-retryable `errorCode: 2`, so the driver doesn't retry and the worker sees exactly 3 errors. Record the counts. Assert exactly 3 `Claim failed: MongoServerError (code 2)` warns, then seed a due event and assert `done`. Fallback: the wrapper throwing on `findOneAndUpdate` 3 times.
  - CA-20 (per scenario above, CA-03, CA-10, CA-13 and CA-14): every `workerLines` entry matches one `D10_PATTERNS` regex in full. `logger.all` contains no posted or seeded `patientId`, `type`, ISO `ts` or `data` values, no `idempotencyKey`, and no `{"simulated":true}`. Every stored `lastError.message` is one of the three D-12 strings.
- Invariants: always release blocked processors before `afterEach` closes the app. Disable failpoints in `afterEach`.
- Completion evidence: `npx vitest run --config ./vitest.config.e2e.ts test/worker.e2e-spec.ts` passes.

### T-13 — Final-failure e2e file (`MAX_ATTEMPTS=3`)

- Outcome: covers the first part of CA-11 and its CA-20 checks.
- Traces: RF-05, D-12, D-15, D-10, CA-11, CA-20.
- Dependencies: T-09, T-11.
- Areas: new `test/worker-max-attempts.e2e-spec.ts`.
- Setup: `workerEnv({ MAX_ATTEMPTS: '3', POLL_INTERVAL_MS: '50', BACKOFF_BASE_MS: '100', BACKOFF_MAX_MS: '1000' })`. The processor always rejects with a plain `Error('boom <patientId>')`, which also proves the processor's text is never stored or logged.
- Assertions: `failed`, `attempts: 3`, `processedAt`, `lastError.code` `processor_error`, message `External call failed`, and no `result`/`workerId`/`lockedUntil`. Exactly one `warn` equal to `Event <id> failed after 3 attempts (processor_error)`. After 500 more ms, the call count is still 3. CA-20 pattern and payload checks. No line contains `boom`.
- Completion evidence: the file passes.

### T-14 — Timeout and single-attempt e2e file (`MAX_ATTEMPTS=1`)

- Outcome: covers CA-12 and the `MAX_ATTEMPTS=1` part of CA-11.
- Traces: RF-03, RF-05, D-06, D-12, D-15, CA-11, CA-12.
- Dependencies: T-09, T-11.
- Areas: new `test/worker-timeout.e2e-spec.ts`.
- Setup: `workerEnv({ MAX_ATTEMPTS: '1', PROCESSING_DELAY_MS: '2000', PROCESSING_TIMEOUT_MS: '200', LEASE_MS: '5000', POLL_INTERVAL_MS: '50' })`.
- Scenarios:
  - CA-12: `SpyProcessor` over `new SimulatedProcessor({ delayMs: 2000, failureRate: 0 })`. Assert `failed` with `lastError` `{ code: 'timeout', message: 'External call timed out after 200 ms' }` within about 1 s of the spy's call start (assert ≤ 1500 ms to absorb scheduling). The captured signal is `aborted`, the spy records a rejection, and polling for 2.5 s never sees `done`.
  - CA-11 (`MAX_ATTEMPTS=1`): a processor that rejects at once with a plain `Error`. Assert `failed`, `attempts: 1`, and one final-failure `warn` `(processor_error)`.
- Completion evidence: the file passes.

### T-15 — Concurrency 1 e2e file (order and stop)

- Outcome: covers CA-06 and CA-16(a)(b).
- Traces: RF-02, RF-07, D-02, D-13, D-10, CA-06, CA-16.
- Dependencies: T-09, T-11.
- Areas: new `test/worker-concurrency-1.e2e-spec.ts`.
- Setup: `workerEnv({ WORKER_CONCURRENCY: '1', POLL_INTERVAL_MS: '50', PROCESSING_DELAY_MS: '50' })`, `monitoredClientOverride`.
- Scenarios:
  - CA-06: seed 5 due events with distinct past `nextAttemptAt` values, inserted in shuffled order, then boot the app. Assert the processor saw them in ascending `nextAttemptAt` order.
  - CA-16(a): `BlockingProcessor`. Seed 4 due events and wait for the first call. Call `close()` without awaiting it and record whether it resolves. Release after 300 ms and assert `close()` had not resolved before the release. After it resolves, assert the in-flight event is `done`, the other 3 are `pending` with `attempts: 0`, and `Worker stopped` is logged. Using a logger subclass that records the command-sink length when `Worker stopped` arrives, assert no `findAndModify` or `update` on `events` was started after that marker.
  - CA-16(b): idle app. Time `await app.close()` and assert it takes ≤ 50 + 1000 ms.
- Invariants: `afterEach` tolerates an app already closed by the test.
- Completion evidence: the file passes.

### T-16 — Concurrency 2 and 3 e2e files

- Outcome: covers CA-08 (concurrency 2) and CA-07 (concurrency 3).
- Traces: RF-02, D-13, CA-07, CA-08.
- Dependencies: T-09, T-11.
- Areas: new `test/worker-concurrency-2.e2e-spec.ts` and `test/worker-concurrency-3.e2e-spec.ts`.
- Scenarios:
  - CA-08 (`WORKER_CONCURRENCY=2`): two due events with the same `patientId` and a `BlockingProcessor`. Wait until 2 calls are in flight at once, then release.
  - CA-07 (`WORKER_CONCURRENCY=3`): 10 due events and a `BlockingProcessor`. Wait until 3 calls are in flight, hold for 300 ms, and assert the maximum in-flight count is 3 and `countDocuments({ status: 'processing' })` is 3. Release calls repeatedly until all 10 are `done`. The maximum in-flight count stays 3.
- Completion evidence: both files pass.

### T-17 — Short-lease write-retry e2e file

- Outcome: covers the CA-14 variant "no retry after expiry".
- Traces: RF-06, D-07, CA-14.
- Dependencies: T-09, T-11.
- Areas: new `test/worker-short-lease.e2e-spec.ts`.
- Setup: `startMongo(..., { enableTestCommands: true })`, `workerEnv({ LEASE_MS: '1500', PROCESSING_TIMEOUT_MS: '1000', PROCESSING_DELAY_MS: '50', POLL_INTERVAL_MS: '50' })`, `monitoredClientOverride`, and an `update` failpoint left `alwaysOn` (or the wrapper fallback).
- Assertions: one abandoned `warn`. Every `update` command for the event's `_id` started before the claimed `lockedUntil` (read from the document). The worker-level write count, derived from the command count and the driver retry factor (or the wrapper's call counter), is 2, which is fewer than 1 + 3. The document stays `processing`.
- Completion evidence: the file passes. The implementation report records the counts.

### T-18 — Claim survival with Mongo stopped

- Outcome: covers CA-15(b).
- Traces: RF-02, D-13, RNF-04, CA-15.
- Dependencies: T-09, T-11.
- Areas: new `test/worker-store-down.e2e-spec.ts`.
- Setup: `workerEnv({ POLL_INTERVAL_MS: '50' })`, `CaptureLogger`, and a `process.on('unhandledRejection', spy)` registered in `beforeAll` and removed in `afterAll`. Call `app.listen(0)`.
- Assertions: after `mongo.stop()`, wait (up to 20 s) for at least one `warn` matching `^Claim failed: Mongo\w*Error`. `GET /health` returns `200 { status: 'ok' }` and the spy is empty. `afterAll` closes the app (it may wait up to about 5 s for an in-flight claim) and stops Mongo with errors ignored, as `events-store-down` does.
- Completion evidence: the file passes.

### T-19 — Disabled worker e2e file

- Outcome: covers CA-17.
- Traces: RF-01, RF-08, D-08, D-10, CA-17.
- Dependencies: T-09, T-11.
- Areas: new `test/worker-disabled.e2e-spec.ts`.
- Setup: `workerEnv({ WORKER_ENABLED: 'false', POLL_INTERVAL_MS: '50' })`, `monitoredClientOverride`, `CaptureLogger`.
- Assertions: POST an event and wait 500 ms. The document is `pending` with `attempts: 0`. No `findAndModify` command with `findAndModify: 'events'` was recorded. The log contains `Worker disabled (WORKER_ENABLED=false)`. After `app.close()`, there is no `Worker stopped` line.
- Completion evidence: the file passes.

### T-20 — Full verification and scope review

- Outcome: all planned checks run and their results are recorded in the implementation report.
- Traces: CA-01, CA-21, CA-22, RNF-04, and every CA via the suites.
- Dependencies: T-01 to T-19.
- Changes: none to product code. Run section 6. Confirm the scope diff (no change under `src/events/`, `src/database/`, `src/main.ts`, `Dockerfile`, `package.json` or `package-lock.json`). Record the environment and the CA-14/CA-15 method and counts.
- Completion evidence: command outputs listed in section 6.

## 6. Verification plan

All checks are planned. None has been executed.

| Check | Command or procedure | Criteria | Expected evidence |
| --- | --- | --- | --- |
| Build | `npm run build` | CA-01 | exit 0 |
| Lint | `npm run lint` | CA-01, RNF-04 | exit 0, no `no-floating-promises` findings |
| Unit | `npm test` | CA-01, CA-02, CA-18, CA-19, CA-22 (unit part) | all specs pass, including the new `env.validation`, `backoff` and `simulated-processor` cases |
| Type check of tests | `npx tsc --noEmit --incremental false -p tsconfig.json` | CA-01 (support for test code), RNF-04 | exit 0 |
| E2E | `npm run test:e2e` | CA-03 to CA-17, CA-20, CA-22 | all existing and new files pass |
| Single file (while iterating) | `npx vitest run --config ./vitest.config.e2e.ts test/<file>` | as mapped in T-12 to T-19 | file passes |
| Compose | `docker compose config` (the CLI renders the file without a daemon) | CA-21 | `WORKER_ENABLED` under `services.app.environment` |
| README | `grep -n 'WORKER_ENABLED' README.md` | CA-21, D-16 | exactly the D-16 row |
| Scope | `git diff --stat -- src/events src/database src/main.ts src/health Dockerfile package.json package-lock.json` | Preserve, section 12 DoD | empty output |
| Existing-suite diff | `git diff -- test/app.e2e-spec.ts test/events.e2e-spec.ts test/events-data-model.e2e-spec.ts test/events-store-down.e2e-spec.ts test/startup-failure.e2e-spec.ts` | CA-22 | only `env: { WORKER_ENABLED: 'false' }` additions |
| Privacy review | read the diff of `src/worker/` for every `logger.` call and every `lastError` construction | RNF-03, D-10, D-12 | only the seven D-10 templates, and only the three D-12 texts |
| Manual QA (optional) | the spec section 11 procedure: `docker compose up --build`, POST the README curl example, wait about 6 s, `docker compose exec mongo mongosh ingest --quiet --eval 'db.events.find({}, {status:1, attempts:1, result:1}).toArray()'`, `docker compose logs app` | CA-03 (manual corroboration) | `done`, `attempts: 1`, `result: { simulated: true }`, the `Worker started: concurrency 100, workerId …` line |

- Setup: Node 24 and the MongoDB 7.0.45 binary cached by `mongodb-memory-server`. No network or services are needed for the automated checks. Manual QA needs a running Docker daemon.
- Record in the implementation report: Node and MongoDB versions; for CA-14 and CA-15, whether the failpoint (with `enableTestCommands`) or the wrapper was used, the error kind and the `times` counts; the pass, fail or blocked status per CA.
- Limitations: replica-set failover can't be reproduced on one member (the spec simulates it with CA-14 and CA-15). Throughput at 1000/min is not measured (Phase 6). Timing-based assertions (CA-09 "both instances", CA-10 snapshot capture, CA-12 "about 1 s", CA-16(b)) depend on scheduler latency. The planned margins are noted in each task.

## 7. Risk and recovery

- K-01 (spec-mandated floor): D-04 rounds down. For an odd `cap` (only possible with an odd `BACKOFF_BASE_MS` at n = 1, for example base 1), `floor(cap/2)` falls just below `cap/2`. CA-18's inputs all give even caps, so the CA holds. The plan follows the spec and doesn't add rounding rules. Non-blocking.
- K-02 (spurious stale warn): if a fenced write applies but its acknowledgement is lost, the D-07 worker-level retry matches 0 and logs `Stale write discarded…`. The data is correct, but the log is misleading. This is inherent to D-03 and D-07 as written. Non-blocking, and worth noting for Phase 4 and 8 docs.
- K-03 (failpoint availability): mitigated by R-09. If the failpoint fails, the spec-defined wrapper fallback is used. `MongoNetworkError`'s constructor is marked internal in the driver. If it misbehaves, throw a `MongoServerError` that carries the `RetryableWriteError` label (constructed through the driver's public error shape) or any error `isStoreUnavailable` accepts, and record it.
- K-04 (test runtime and resources): eight new e2e files, each starting a `mongod` and run in parallel by vitest. CA-14(b) adds about 3 s and CA-15(b) store-down (T-18) adds up to about 25 s. Acceptable, but watch for timeouts and set per-test timeouts like the existing suites (`180_000` for setup, `30_000` to `60_000` for tests).
- K-05 (env leakage between files): mitigated by R-02 (`workerEnv` sets every variable explicitly) and the guard in `createTestApp`.
- K-06 (regression surface): `AppModule` now starts a background loop in every app, including any future test that forgets `WORKER_ENABLED=false`. That is mitigated by T-10 and by the guard. The HTTP path is unchanged (`EventsService` untouched).
- K-07 (unbounded stop): by design (D-02), `app.close()` waits for in-flight attempts. Each is bounded by `PROCESSING_TIMEOUT_MS` plus about 3 s of retries plus the write timeouts. With Mongo down, an in-flight claim may add up to 5 s. Phase 4 adds the bound.
- Migrations: none. No index or schema change. Existing documents are processed as they are.
- Destructive or external actions: none. No commits, publication or dependency changes are part of this plan. Commits only on the user's request.
- Recovery: revert the change set. `WORKER_ENABLED=false` disables processing at runtime without a code change. Events left `processing` by an abandoned write (D-07) are a known Phase 3 limit, recovered by Phase 4 reclaim.

## 8. Coverage matrix

| ID | Tasks | Checks |
| --- | --- | --- |
| RF-01 | T-05, T-11 | CA-17 (T-19), CA-03 start log (T-12), lint |
| RF-02 | T-05 | CA-03, CA-04, CA-05, CA-06, CA-07, CA-08, CA-09, CA-15 (T-12, T-15, T-16, T-18) |
| RF-03 | T-03, T-06 | CA-03, CA-12 (T-12, T-14) |
| RF-04 | T-07 | CA-03, CA-04, CA-13 (T-12) |
| RF-05 | T-04, T-07 | CA-10, CA-11, CA-13 (T-12, T-13, T-14) |
| RF-06 | T-07 | CA-14 (T-12, T-17) |
| RF-07 | T-08 | CA-16 (T-15), CA-17 no-stop-log (T-19) |
| RF-08 | T-01, T-02 | CA-02, CA-17, CA-21 |
| RNF-01 | Not applicable: backend only, no UI (spec 8). No task. | Scope diff shows no UI files |
| RNF-02 | Not applicable: no UI (spec 8). No task. | Scope diff shows no UI files |
| RNF-03 | T-03, T-05, T-06, T-07, T-12, T-13 | CA-20, privacy review |
| RNF-04 | T-01, T-04, T-05, T-07 (R-14), T-18, T-20 | CA-01, lint, type check, CA-15, scope diff (no dependencies) |
| D-01 | T-05 | CA-05 |
| D-02 | T-08 | CA-16 |
| D-03 | T-07 | CA-13 |
| D-04 | T-04, T-07 | CA-10, CA-18 |
| D-05 | T-03, T-05, T-09 | CA-03 (spy input) |
| D-06 | T-03, T-06 | CA-12, CA-19 |
| D-07 | T-07 (R-07) | CA-14 (T-12, T-17) |
| D-08 | T-01, T-02, T-10 | CA-02, CA-17, CA-21, CA-22 |
| D-09 | T-05 (R-11) | CA-04 |
| D-10 | T-05, T-07, T-08 | CA-20, CA-11, CA-13, CA-14, CA-15, CA-16, CA-17 |
| D-11 | T-05, T-07 | Command-sink assertion in T-12 (CA-03): the `findAndModify` and `update` commands carry `writeConcern.w: 'majority'`; code review |
| D-12 | T-06, T-07 | CA-10, CA-11, CA-12, CA-20 |
| D-13 | T-05 | CA-07, CA-15, CA-16(b) |
| D-14 | T-05, T-11 | CA-03 (worker runs after init, indexes exist), build |
| D-15 | T-07 | CA-11 |
| D-16 | T-02 | CA-21 |
| CA-01 | T-20 | build, lint, `npm test` |
| CA-02 | T-01 | `npm test` |
| CA-03 | T-12 | e2e |
| CA-04 | T-12 | e2e |
| CA-05 | T-12 | e2e |
| CA-06 | T-15 | e2e |
| CA-07 | T-16 | e2e |
| CA-08 | T-16 | e2e |
| CA-09 | T-12 | e2e |
| CA-10 | T-12 | e2e |
| CA-11 | T-13, T-14 | e2e |
| CA-12 | T-14 | e2e |
| CA-13 | T-12 | e2e |
| CA-14 | T-12, T-17 | e2e, recorded method and counts |
| CA-15 | T-12, T-18 | e2e, recorded method and counts |
| CA-16 | T-15 | e2e |
| CA-17 | T-19 | e2e |
| CA-18 | T-04 | `npm test` |
| CA-19 | T-03 | `npm test` |
| CA-20 | T-12, T-13 | e2e, privacy review |
| CA-21 | T-02 | `docker compose config`, README grep |
| CA-22 | T-10, T-11 | `npm test`, `npm run test:e2e`, existing-suite diff |

The D-11 check is added to T-12's CA-03 scenario: with `monitoredClientOverride`, assert that the recorded `findAndModify` and `update` commands carry `writeConcern: { w: 'majority', wtimeout: 5000 }`. The wire field is `wtimeout`; adapt the assertion to the observed field name.

## 9. Implementation handoff

- Prerequisites: run `npm ci` on the existing lockfile if `node_modules` is missing. The MongoDB 7.0.45 binary is fetched by `mongodb-memory-server` on first use. No new packages.
- Permitted scope: the files listed in section 4 "Boundaries" and in T-01 to T-19. Nothing under `src/events/`, `src/database/`, `src/main.ts`, `src/health/`, `Dockerfile`, `package.json`, `package-lock.json`, `tsconfig*` or `vitest*`. No indexes, no `ObserveModule`, no `enableShutdownHooks`, no lease reclaim. No commits unless the user asks.
- Order: T-01 to T-04 (any order), then T-05 to T-08, T-09, T-10, T-11, then T-12 to T-19 (any order), then T-20. T-11 must not land before T-10.
- Known non-blocking risks: K-01 (floor with odd caps), K-02 (spurious stale warn after a lost ack), K-03 (failpoint availability and fallback), K-04 (e2e runtime), K-05 (env leakage, mitigated), K-07 (unbounded stop in this phase).
- Items to record in the implementation report: the environment; the CA-14 and CA-15 method, error kind and counts; how the logger context appears in `CaptureLogger` (T-09); the wire field name for `wtimeoutMS` (section 8 note); and per-CA status.
- Confirmation: the spec has no blocking question, and this plan makes no product, data-handling, permission, integration or acceptance decision beyond the spec. The resolved details R-01 to R-14 are test-infrastructure or internal choices backed by the repository evidence cited above. No blocking ambiguity remains.
