# Plan: Events crash safety (expired-lease reclaim, attempt-limit guard, signal-driven bounded shutdown, F-01 wake fix)

## 1. Identity

- Plan status: PLANNED. Ready for implementation. Nothing in this plan has been executed. Every check below is planned only.
- Date: 2026-11-02.
- Spec: `.ai/.specs/events-crash-safety.md`
- Spec SHA-256: `32e69a9554e4554cbd45606d367532944c653b598814475bc906694a82e2e353`
- Affected repositories: `clinical-event-ingestion-service` only (branch `main`, HEAD `79348bc`). The spec file is untracked in the working tree.
- Planning sources read:
  - The spec, `PLAN.md` (Phase 4 and Phase 6), `AGENTS.md`. There is no `CLAUDE.md` and no `.ai/docs/`.
  - Earlier artifacts: `.ai/.specs/events-worker.md` (D-07, D-10, D-12, D-13, D-15, CA-14, CA-16 and the failpoint fallback assumption), `.ai/.plans/events-worker.md` (plan format, the one-file-per-configuration rule R-01/R-02, the `tsc` test type-check), `.ai/.assessments/events-worker.md` (finding F-01 and its probe timings).
  - Manifests and config: `package.json`, `tsconfig.json` (no `include`, so it also covers `test/`), `tsconfig.build.json`, `nest-cli.json` (`deleteOutDir: true`), `vitest.config.ts`, `vitest.config.e2e.ts`, `.oxlintrc.json`, `.gitignore` (`/dist` ignored), `docker-compose.yml`, `Dockerfile`.
  - Source: `src/main.ts`, `src/app.module.ts`, `src/app.setup.ts`, `src/config/env.validation.ts`, `src/database/database.module.ts`, `src/events/event.document.ts`, `src/events/store-errors.ts`, `src/worker/events-worker.ts`, `src/worker/event-processor.ts`, `src/worker/simulated-processor.ts`, `src/worker/worker.module.ts`, `src/worker/backoff.ts`.
  - Tests: `test/worker.e2e-spec.ts`, `test/worker-short-lease.e2e-spec.ts`, `test/worker-concurrency-1.e2e-spec.ts`, `test/worker-concurrency-3.e2e-spec.ts`, `test/worker-timeout.e2e-spec.ts`, `test/worker-max-attempts.e2e-spec.ts`, `test/worker-disabled.e2e-spec.ts`, `test/worker-store-down.e2e-spec.ts`, `test/support/worker.ts`, `test/support/app.ts`, `test/support/mongo.ts`, `test/support/capture-logger.ts`.
  - Installed packages: `@nestjs/core` 12.3.2 (`nest-application-context.js` `shutdown`, `runShutdownSequence`, `listenToShutdownSignals`; `nest-application.js` `prepareClose`, `dispose`), `@nestjs/platform-express` (`express-adapter.js` `beforeClose`, `close`, `initHttpServer` `return503OnClosing`), `@nestjs/common` `console-logger.service.js` (stream per level), `mongodb` 7.8.0. Local Node `v24.21.0`.

## 2. Readiness check

- Status line: "ready for implementation", updated 2026-11-02. Section 5 "Open questions": none blocking. The follow-ups belong to Phases 5 and 6.
- RF-01 to RF-06 each have a trigger, rules and output. RNF-01 and RNF-02 are explicitly not applicable. RNF-03 and RNF-04 are concrete.
- D-01 to D-11 are concrete: the exact claim filter, update, sort and options (D-01, RF-01); reclaim detection via `returnDocument: 'before'` with derived values (D-04); the guard condition, update and fixed message (D-03); the stop sequence and log order (D-05, D-08); signal list (D-06); wake split (D-07); no commands after stop (D-11).
- CA-01 to CA-14 are observable, with settings, seeds and expected documents and log lines. The section 13 consistency review maps every RF and behaviour-affecting decision to a CA.
- The four assumptions each have a stated confirmation path or stop condition (CA-11 explain; CA-07 exit; harness only; reachability).
- Internal consistency checked:
  - D-03 "final when `attempts > MAX_ATTEMPTS`" and the existing final-failure rule (`attempts >= MAX_ATTEMPTS`, worker D-15) agree for a `lease_expired` outcome, so the existing `recordOutcome` final branch produces exactly the D-03 update.
  - CA-03(c) (`pending`, `attempts: 5`, `MAX_ATTEMPTS=3` → `done`, `attempts: 6`) matches "the guard is reclaim-only" (D-03, RF-03).
  - CA-03(d) arithmetic: the abandoned guard write leaves `attempts: 4`; the next reclaim makes it 5 and the guard fails it (`lease_expired`, `attempts: 5`).
  - CA-14 updates only the Phase 3 CA-05 expired-lease expectation, which D-01 supersedes. Worker CA-16(a)/(b) stay valid because the bound is 20 s by default.
- Repository facts that need specific handling. Each is resolved below without changing product behaviour or acceptance meaning:
  1. One configuration per vitest file. `ConfigModule.forRoot` snapshots `process.env` once per file and `createTestApp` rejects a different `env` in the same file (`test/support/app.ts`). The CAs need several settings sets (`MAX_ATTEMPTS` 5 vs 3; concurrency 10 vs 1; `SHUTDOWN_TIMEOUT_MS=300`; `POLL_INTERVAL_MS=1000`). Resolution: one new e2e file per settings set. The spec's section 9 names files as "suggested" and allows splitting.
  2. CA-04 needs instance B, not A, to reclaim. Both run in the same process with the same settings, and A keeps polling while its processor is blocked. With a free slot A could reclaim the event itself. Resolution: the CA-04 file runs with `WORKER_CONCURRENCY=1`, so A's pool is full while its attempt is blocked and only B can claim. The spec fixes no concurrency for CA-04, and a lease of 30 s with `PROCESSING_TIMEOUT_MS=10000` matches "default lease" (the `workerEnv` default).
  3. Existing suite `test/worker-short-lease.e2e-spec.ts` (Phase 3 CA-14 short-lease variant) would break once reclaim exists. With `LEASE_MS=1500`, `POLL_INTERVAL_MS=50` and the `update` failpoint `alwaysOn`, the worker abandons its write only after `Date.now() >= lockedUntil` (about claim + 2050 ms), while the dispatcher reclaims the expired event within one poll after claim + 1500 ms. That adds a `Reclaimed event` warn and more `update` commands before the test asserts "exactly 1 warn" and "2 worker-level writes". Resolution (T-07): change only that file's `POLL_INTERVAL_MS` setting to `5000`. After the F-01 fix (T-02), the next claim after the one that took the event is then about 5 s later, well after the abandon (about 2 s), so the event is not reclaimed while the test is asserting. No assertion changes, and the test still checks the same worker D-07 property. The spec's Preserve list ("every existing test assertion") and CA-01 talk about assertions, and this is a settings change in test setup. It is recorded as risk R-02 and must be reported in the implementation report.
  4. Nest 12.3.2 close order observed in `runShutdownSequence`: `prepareClose` (sets the Express adapter's `isShuttingDown`, which only matters with `return503OnClosing`, not set in `appOptions`) → `onModuleDestroy` → `beforeApplicationShutdown` → `dispose` (HTTP server close) → `onApplicationShutdown` (`DatabaseModule` closes the client) → unsubscribe signal listeners. The spec's D-10 and RF-04 text describe the last two in the opposite order (client close, then HTTP close). This does not change anything the implementation must do or any CA: during the drain (`beforeApplicationShutdown`) the HTTP server still serves and `POST /events` still stores (CA-07), and `main.ts` does not control the order. The only difference is that the "503 window" D-10 describes does not occur; requests after the drain hit a closed listener instead. Recorded as non-blocking risk R-06. The implementer must not try to reorder Nest's hooks.
  5. Nest 12.3.2 `listenToShutdownSignals`: on the first signal it runs `shutdown(signal)`, then `process.kill(process.pid, signal)` after `runShutdownSequence` removed the listeners, so the process ends by that signal. This confirms the spec's CA-07 exit assumption (`signal === 'SIGTERM'`). The same source shows that a second signal during the drain is ignored (the `receivedSignal` guard returns while the listener is still attached), not "kills it at once" as the assumption states. The spec marks second-signal behaviour as "noted, not tested", so this is recorded only (R-06). The bounded drain (D-05) and Compose's `stop_grace_period` SIGKILL still bound it.
  6. `npm run build` excludes `**/*spec.ts`, and vitest doesn't type-check. Test files are type-checked with `npx tsc --noEmit --incremental false -p tsconfig.json`, as in earlier plans.
  7. `ConsoleLogger` writes `log` and `warn` to stdout and `error`/`fatal` to stderr. All D-08 and worker D-10 lines are `log` or `warn`, so the child-process suite finds them in stdout; it still captures and checks both streams (CA-13).
- Conclusion: implementation-ready. No blocking ambiguity.

## 3. Observed implementation context

Facts about the current state (HEAD `79348bc`):

- Stack: NestJS 12.3.2, `mongodb` 7.8.0 (no Mongoose), TypeScript 6 `strict`, ESM with `.js` import suffixes, Node 24, vitest 4 (unit `**/*.spec.ts`, e2e `**/*.e2e-spec.ts`, files run in parallel), `mongodb-memory-server` 11.3.0 pinned to MongoDB 7.0.45. Lint: `oxlint --type-aware src/ test/` with `typescript/no-floating-promises: error`.
- `src/worker/events-worker.ts` (`EventsWorker`):
  - `claim()`: `findOneAndUpdate({ status: 'pending', nextAttemptAt: { $lte: now } }, { $set: { status: 'processing', workerId, lockedUntil: now + LEASE_MS }, $inc: { attempts: 1 } }, { sort: { nextAttemptAt: 1 }, returnDocument: 'after', writeConcern: WRITE_CONCERN })`.
  - `run()`: loop while `!stopping`; when `inFlight.size >= concurrency` it calls `waitForWake()` (no timer); after a `null` or failed claim it calls `waitForWake(pollMs)`. A single `this.wake` callback serves both waits. `start()` calls `this.wake?.()` in `finally` of every attempt, which is F-01. After a claim returns a document the loop calls `start()` without re-checking `stopping` (a claim already sent at stop time still starts its attempt).
  - `attempt()` = `callProcessor()` (AbortController, timeout race, late results ignored) then `recordOutcome(claimed, outcome)`.
  - `recordOutcome()`: reads `claimed.attempts` and `claimed.lockedUntil` from the `returnDocument: 'after'` document; final failure when `attempts >= MAX_ATTEMPTS`; fenced filter `{ _id, status: 'processing', workerId, attempts }`; retry loop with module-level `sleep(OUTCOME_WRITE_RETRY_DELAY_MS)` and the lease check `Date.now() >= claimed.lockedUntil` after each sleep; logs `Stale write discarded…`, `Event … failed after … attempts (…)`, `Write for event … abandoned: …`.
  - `ErrorCode = 'simulated_failure' | 'timeout' | 'processor_error'`; `errorMessage(code)` maps codes to fixed texts.
  - `stop()`: returns at once when `!this.loop` (disabled); otherwise sets `stopping`, calls `wake`, awaits the loop, then loops `await Promise.all(this.inFlight)` with no time limit, then logs `Worker stopped`. `beforeApplicationShutdown` memoizes `stopPromise`.
- `src/worker/event-processor.ts`: `EventProcessor.process(input, signal)`. `src/worker/simulated-processor.ts` honours the abort signal.
- `src/main.ts`: `NestFactory.create(AppModule, appOptions)` → `configureApp(app)` → `listen(PORT)`. No `enableShutdownHooks`.
- `src/database/database.module.ts`: claim index `claim_status_nextAttemptAt` `{ status: 1, nextAttemptAt: 1 }`; `onApplicationShutdown` closes the client.
- `src/config/env.validation.ts`: `SHUTDOWN_TIMEOUT_MS` integer ≥ 0, default 20000, currently unused. `LEASE_MS > PROCESSING_TIMEOUT_MS` enforced.
- `src/events/event.document.ts`: `EventError.code` is `string`, so `lease_expired` needs no type change.
- `src/events/store-errors.ts`: `isStoreUnavailable` (network, selection, closed, write-concern, retryable labels).
- Test support (`test/support/`): `workerEnv` (all worker settings explicit), `workerConfigure` (processor override, `MONGO_CLIENT` override with `monitorCommands`, `appName: TEST_APP_NAME`, command sink), `BlockingProcessor` (records `signal`, never settles until released), `ScriptedProcessor`, `SpyProcessor`, `waitFor`, `seedEvent`, `workerLines`, `D10_PATTERNS` (7 anchored patterns; the failed-event pattern allows `simulated_failure|timeout|processor_error` only), `D12_MESSAGES`, `startMongo(db, { enableTestCommands })`, `CaptureLogger`. `test/worker-concurrency-1.e2e-spec.ts` has a `MarkingLogger` that records the sink length at `Worker stopped`.
- Failpoints: `configureFailPoint: 'failCommand'` scoped by `appName: TEST_APP_NAME` works on the in-memory set with `enableTestCommands` (Phase 3 evidence: `closeConnection` on `update` produces one driver try plus one driver retry per worker-level write; `errorCode: 2` on `findAndModify` is non-retryable).
- `test/worker.e2e-spec.ts` lines 186–230: "CA-05 only claims due pending events" seeds one due event plus five others, including a `processing` document with `lockedUntil` 60 s in the past, and asserts one processor call and all five others deep-equal.
- Docker: `init: true`, `stop_grace_period: 30s`, `CMD ["node", "dist/main.js"]`. Not changed.
- Applicable instructions: `AGENTS.md` (optional NestJS Observe telemetry). Excluded by the spec (PLAN G12), so no task registers `ObserveModule`.

## 4. Implementation strategy

- Boundaries: product changes only in `src/worker/events-worker.ts` and `src/main.ts`. Test changes in `test/support/worker.ts`, three existing suites (minimal, listed in T-07) and new e2e files. No change to `EventsService`, `DatabaseModule`, `env.validation.ts`, `event.document.ts`, `worker.module.ts`, indexes, `docker-compose.yml`, `Dockerfile`, `README.md`, `package.json` or the lockfile.
- Data and control flow after the change:
  1. Claim (RF-01): read `now` once; send the D-01 `$or` filter with the unchanged update and sort, `returnDocument: 'before'`, same write concern. From the returned pre-update document build an internal attempt record: the payload fields from the document, `attempts = before.attempts + 1`, `lockedUntil = new Date(now + LEASE_MS)` (the exact value sent), `workerId = this.workerId`, `reclaimed = before.status === 'processing'`. Every later use (processor input, fencing filter, D-07 lease check, logs, guard) reads only this record, never `before.attempts`/`before.lockedUntil`.
  2. Reclaim (RF-02): when `reclaimed`, log `warn` `Reclaimed event <_id> after lease expiry (attempt <attempts>)` before anything else in the attempt.
  3. Guard (RF-03): when `reclaimed && attempts > MAX_ATTEMPTS`, skip the processor and pass the outcome `{ ok: false, code: 'lease_expired' }` to the existing `recordOutcome`. `ErrorCode` gains `'lease_expired'` and `errorMessage` returns `Lease expired before the attempt completed`. Because `attempts > MAX_ATTEMPTS` implies `attempts >= MAX_ATTEMPTS`, `recordOutcome` takes its final branch: `$set: { status: 'failed', processedAt, lastError }`, `$unset` lock fields, fenced filter, worker D-07 retries, and the existing `Event <_id> failed after <n> attempts (lease_expired)` / `Stale write discarded…` / `Write … abandoned…` lines. This reuses the path the spec names (section 9 "Reuse") and changes nothing for non-reclaimed claims (worker D-15 preserved).
  4. Dispatcher wakes (RF-06): two separate mechanisms. A slot waiter, resolved by a settling attempt, used only by the pool-full wait. A stop wake that resolves whichever wait is active (pool-full or poll). The poll wait after an empty or failed claim is resolved only by its timer or the stop wake.
  5. Bounded stop (RF-05, D-05, D-11): `stop()` (when enabled) records the hook start time, logs `Worker stopping: <inFlight.size> attempts in flight`, sets `stopping`, fires the stop wake, awaits the loop (a claim already sent may still start one attempt), then waits for in-flight attempts until `hookStart + SHUTDOWN_TIMEOUT_MS`. If they all settle first: `Worker stopped`, resolve. If the deadline passes with `n > 0` attempts unfinished: `warn` `Shutdown timeout after <SHUTDOWN_TIMEOUT_MS> ms: <n> attempts left for lease reclaim`, then for each unfinished attempt mark it cancelled, abort its processor signal and cancel its D-07 retry wait; then `Worker stopped`, resolve without awaiting them. A cancelled attempt sends no further outcome write and no retry; if a write it already sent returns later, its result is ignored and nothing is logged. `SHUTDOWN_TIMEOUT_MS=0` makes the deadline immediate. The memoized `stopPromise` keeps "calling the hook twice returns the same promise".
  6. Signals (RF-04, D-06): `main.ts` calls `app.enableShutdownHooks(['SIGTERM', 'SIGINT'])` after `configureApp(app)` and before `listen`.
- Per-attempt state: today an attempt is just a promise in `inFlight`. The bounded stop needs, per attempt, the abort controller, a cancelled flag and a way to cancel the retry wait. Planned shape: `inFlight` keyed by the attempt promise with this state as value (or an equivalent set of state objects); the processor's `AbortController` is created by the attempt and passed into `callProcessor`; the module-level `sleep` used for D-07 retries is replaced by a cancellable wait tied to the attempt state. On cancellation `callProcessor`'s race also resolves at once and clears its timeout timer, so a cancelled attempt does not keep a 10 s timer alive after `app.close()` (relevant to in-process tests; with a signal the process is killed by Nest anyway).
- Compatibility: existing log lines, `lastError` codes and texts, fencing, write concern, backoff, `WORKER_ENABLED` handling and `workerId` format are unchanged. Behaviour changes are exactly those the spec supersedes: expired `processing` events are now claimed (worker D-01, Phase 3 CA-05), and the stop is bounded (worker D-02).
- Sequencing rationale: test-support patterns first (every later test uses them); then the dispatcher wake split (smallest, isolated, and a prerequisite for T-07's short-lease fix); then claim/reclaim, guard, bounded stop, signals; then adjust existing suites so the full regression run stays green; then new suites from simplest (in-process) to the child-process suite; then full verification.
- Rejected alternatives:
  - A separate sweeper that resets expired leases to `pending` (rejected by D-01; two operations, not atomic with the claim).
  - Reading reclaim state from `returnDocument: 'after'` (cannot tell a reclaim from a pending claim; D-04 mandates `'before'`).
  - A new guard write path separate from `recordOutcome` (duplicates fencing and retry logic; the spec asks for reuse).
  - Releasing held events to `pending` or recording a `shutdown` error on timeout (rejected by D-05).
  - Stopping the HTTP server or returning 503 during the drain (`return503OnClosing`) (out of scope, D-10).
  - `enableShutdownHooks()` with no arguments (would listen to every Nest default signal; D-06).

## 5. Ordered tasks

### T-01 — Test support: D-08 patterns and the `lease_expired` text

- Outcome: shared helpers accept exactly the new lines and stored message.
- Traces: D-08, D-03, RNF-03, CA-13.
- Dependencies: none.
- Files: `test/support/worker.ts`.
- Changes:
  - In `D10_PATTERNS`, extend the failed-event alternation to `(simulated_failure|timeout|processor_error|lease_expired)` and add three anchored patterns: `^Reclaimed event [0-9a-f]{24} after lease expiry \(attempt \d+\)$`, `^Worker stopping: \d+ attempts in flight$`, `^Shutdown timeout after \d+ ms: \d+ attempts left for lease reclaim$`.
  - Add `'Lease expired before the attempt completed'` to `D12_MESSAGES`.
- Invariants: existing patterns keep their exact anchoring; no other helper changes are required (optional small helpers for new suites may be added here if shared by several files).
- Completion evidence: `npx tsc --noEmit --incremental false -p tsconfig.json` and the existing suites using these constants still pass (T-14).

### T-02 — Dispatcher wake split (F-01 fix)

- Outcome: a settling attempt ends only the pool-full wait; the poll wait ends only on its timer or on stop.
- Traces: RF-06, D-07, worker D-13, CA-12.
- Dependencies: none.
- Files: `src/worker/events-worker.ts` (`run`, `waitForWake`, `start`, `stop`).
- Changes: replace the single `wake` with a slot waiter (pool-full wait; fired in `start()`'s `finally`) and a stop wake (fired by `stop()`, ends any active wait). The poll wait (`POLL_INTERVAL_MS` timer) listens only to its timer and the stop wake. Keep the existing re-check of `stopping` around waits.
- Invariants: the dispatcher never rejects; at most `WORKER_CONCURRENCY` attempts; idle stop is prompt (worker CA-16(b)); no lost wake when an attempt settles between the pool-full check and registering the slot waiter (register before or re-check `inFlight.size` after registering).
- Edge cases: stop while waiting for a slot; stop while in a poll wait; attempt settling while the dispatcher is mid-claim (no waiter registered: nothing to wake, the next loop iteration re-checks).
- Completion evidence: CA-12 (T-12), worker CA-06/CA-07/CA-16 regression (T-14).

### T-03 — Claim with the expired-lease branch, derived attempt values and reclaim log

- Outcome: due `pending` and expired `processing` events are claimed atomically; reclaims are detected and logged; all later logic uses the derived values.
- Traces: RF-01, RF-02, D-01, D-02, D-04, D-08, RNF-04, CA-02, CA-04, CA-05, CA-10, CA-11, CA-14.
- Dependencies: T-02 (same file; avoids conflicting edits).
- Files: `src/worker/events-worker.ts` (`claim`, `start`, `attempt`, `callProcessor`, `recordOutcome` signatures).
- Changes:
  - `claim()`: filter `{ $or: [ { status: 'pending', nextAttemptAt: { $lte: new Date(now) } }, { status: 'processing', lockedUntil: { $lt: new Date(now) } } ] }`; update unchanged; `sort: { nextAttemptAt: 1 }`; `returnDocument: 'before'`; `writeConcern: WRITE_CONCERN`. `now` read once.
  - Return (or build in `run`) an internal claimed-attempt record: `doc` (pre-update), `attempts = doc.attempts + 1`, `lockedUntil = new Date(now + LEASE_MS)`, `reclaimed = doc.status === 'processing'`.
  - `recordOutcome` uses the record's `attempts` and `lockedUntil` (fencing filter, final-failure check, lease guard, log text). Processor input still built from the document's `_id`, `idempotencyKey`, `patientId`, `type`, `ts`, `data`.
  - On `reclaimed`, log `warn` `Reclaimed event ${id} after lease expiry (attempt ${attempts})` with a named constant/template, at the start of the attempt.
  - Update the class comment (lease reclaim now exists).
- Invariants: `done`, `failed`, future `pending` and valid-lease `processing` documents are never matched; the update document is byte-for-byte the same shape as before; no new index; `lastError` untouched by a reclaim; a `pending` claim logs nothing new.
- Edge cases: `before.lockedUntil` absent on `pending` documents (never read); clock read once so `lockedUntil` in the record equals the stored value.
- Completion evidence: CA-02, CA-04, CA-05, CA-10, CA-11, CA-14.

### T-04 — Attempt-limit guard for reclaimed events

- Outcome: a reclaim with `attempts > MAX_ATTEMPTS` ends `failed` with `lease_expired`, without a processor call.
- Traces: RF-03, D-02, D-03, D-08, RNF-03, CA-03, CA-13.
- Dependencies: T-03.
- Files: `src/worker/events-worker.ts` (`ErrorCode`, `errorMessage`, `attempt`).
- Changes: add `'lease_expired'` to `ErrorCode`; `errorMessage('lease_expired')` returns the constant `Lease expired before the attempt completed`; in `attempt`, when `reclaimed && attempts > MAX_ATTEMPTS`, skip `callProcessor` and call `recordOutcome` with `{ ok: false, code: 'lease_expired' }`.
- Invariants: non-reclaimed claims never take this path even with `attempts > MAX_ATTEMPTS` (worker D-15 path: processor called, final on failure, `done` on success); the write is fenced and uses the D-11 write concern; D-07 retries bounded by the derived `lockedUntil`; the resulting document satisfies data-model presence rules (`processedAt`, `lastError`, no `result`/lock fields).
- Edge cases: guard write abandoned → event stays `processing` and is reclaimed again with a higher `attempts`, guard fails it again (CA-03 d); stale guard write → `Stale write discarded…`.
- Completion evidence: CA-03 (a)–(d).

### T-05 — Bounded stop with cancellation

- Outcome: stop drains up to `SHUTDOWN_TIMEOUT_MS`, then aborts and abandons unfinished attempts without further writes.
- Traces: RF-05, D-05, D-08, D-11, worker CA-16 (preserved), CA-06, CA-07, CA-08, CA-09, CA-13.
- Dependencies: T-02, T-03 (per-attempt record exists), T-04.
- Files: `src/worker/events-worker.ts` (`inFlight` structure, `start`, `attempt`, `callProcessor`, `recordOutcome` retry wait, `stop`).
- Changes (see section 4, items 5 and "Per-attempt state"):
  - Per-attempt state with `AbortController`, `cancelled` flag and cancellable retry wait; `callProcessor` takes the controller (or state) and also settles when cancelled, clearing its timer.
  - `recordOutcome` checks `cancelled` before the first write and after every retry wait; after an awaited write, if `cancelled`, return without logging or retrying. Replace the module `sleep` for D-07 with the cancellable wait.
  - `stop()`: early return when disabled (no log); `hookStart = Date.now()`; log `Worker stopping: ${n} attempts in flight`; set `stopping`; stop wake; await loop; race "all in-flight settled" (re-checking for attempts started by the last claim) against a timer for `max(0, hookStart + SHUTDOWN_TIMEOUT_MS - Date.now())`; on timeout with unfinished attempts: warn `Shutdown timeout after ${SHUTDOWN_TIMEOUT_MS} ms: ${n} attempts left for lease reclaim`, cancel each (flag, abort, cancel wait); log `Worker stopped`; clear the timer; resolve.
- Invariants: no `findAndModify` or `update` on `events` is sent by the worker after `Worker stopped` (D-11); completed attempts within the bound still write normally (worker CA-16(a)); disabled worker logs nothing on stop (worker RF-07, CA-13); the timeout warn is emitted only when attempts are unfinished; log order is stopping → (timeout) → stopped.
- Edge cases: `SHUTDOWN_TIMEOUT_MS=0` with nothing in flight (no timeout line); deadline passing while the loop's last claim is still in progress (timeout handled right after the loop resolves); an attempt in its D-07 retry wait at the deadline (CA-09 variant); a processor that ignores its signal (`BlockingProcessor`) — the attempt is still released by cancellation.
- Completion evidence: CA-08, CA-09, CA-06, CA-07; worker CA-16 regression.

### T-06 — Shutdown hooks in `main.ts`

- Outcome: SIGTERM and SIGINT run `app.close()` and the process exits by the signal.
- Traces: RF-04, D-06, D-10, CA-06, CA-07, CA-10.
- Dependencies: T-05 (so the signal-driven close uses the bounded stop).
- Files: `src/main.ts`.
- Changes: `app.enableShutdownHooks(['SIGTERM', 'SIGINT']);` after `configureApp(app)` and before `listen`.
- Invariants: no other signals registered; `appOptions` unchanged (no `return503OnClosing`), so `POST /events` keeps working during the drain.
- Completion evidence: CA-06, CA-07 (child-process suite).

### T-07 — Adjust existing suites for the new behaviour

- Outcome: the full Phase 1–3 regression run stays green with only the permitted change of expectation.
- Traces: CA-14, CA-01, CA-13, D-01, Preserve.
- Dependencies: T-01, T-02, T-03, T-05.
- Files and changes:
  - `test/worker.e2e-spec.ts` "CA-05 only claims due pending events" (lines 186–230): rename to reflect Phase 4 (for example "CA-05 claims due pending and expired processing events"); expect the expired `processing` seed to end `done` with `attempts: 2` (wait for it); expect two processor calls (the due event and the reclaimed one); keep the deep-equal check for the other four seeds (future `pending`, valid-lease `processing`, `done`, `failed`). This is the only assertion change (CA-14).
  - `test/worker-short-lease.e2e-spec.ts`: change `POLL_INTERVAL_MS: '50'` to `'5000'` in that file's `workerEnv` overrides, with a one-line comment that it keeps the Phase 4 reclaim from running while the abandon is asserted. No assertion changes (see section 2, item 3; risk R-02). If the waitFor budget (15 s) proves tight in practice, raise only that timeout.
  - `test/worker-disabled.e2e-spec.ts`: after `app.close()`, additionally assert that no `Worker stopping` line is logged (CA-13 disabled part). Existing assertions unchanged.
- Invariants: no other existing assertion edited; no existing suite deleted.
- Completion evidence: `npm run test:e2e` (T-14); `git diff` of these three files shows only the changes listed.

### T-08 — Reclaim e2e file (`MAX_ATTEMPTS=5`, concurrency 10)

- Outcome: evidence for reclaim, the two-instance race, index use and log hygiene.
- Traces: RF-01, RF-02, D-01, D-02, D-04, D-08, RNF-03, RNF-04, CA-02, CA-05, CA-11, CA-13.
- Dependencies: T-01, T-03.
- File (suggested by the spec): `test/worker-reclaim.e2e-spec.ts`, own `startMongo` database, `workerEnv({ WORKER_CONCURRENCY: '10', POLL_INTERVAL_MS: '50', PROCESSING_DELAY_MS: '50', PROCESSING_TIMEOUT_MS: '500', LEASE_MS: '1000', MAX_ATTEMPTS: '5' })`.
- Tests:
  - CA-02: seed `processing`, `attempts: 1`, `workerId: 'dead:1:aaaaaaaa'`, `lockedUntil` now − 1 s, plus a `processing` document with `lockedUntil` now + 1 h; boot with `SpyProcessor(ScriptedProcessor(success))`; assert the first ends `done`, `attempts: 2`, `result` set, no lock fields; spy called once with the stored `idempotencyKey`; exactly one warn equals `Reclaimed event <_id> after lease expiry (attempt 2)`; after 10 × 50 ms the second document is deep-equal to its seed.
  - CA-05: boot two instances (two `SpyProcessor`s), insert 100 expired `processing` seeds with distinct keys; wait for 100 `done`; all `attempts: 2`; combined spy keys length 100 and unique; exactly 100 `Reclaimed event` lines across the shared logger.
  - CA-11: seed pending and processing documents; run `db.command({ explain: { findAndModify: 'events', query: <D-01 filter>, sort: { nextAttemptAt: 1 }, update: <RF-01 update> }, verbosity: 'executionStats' })`; walk `queryPlanner.winningPlan` (`inputStage`/`inputStages`) and assert every `IXSCAN` uses `claim_status_nextAttemptAt`, both `$or` branches are index scans, and no stage is `SORT`. Print the winning plan (`console.log`) for the report. If a blocking `SORT` appears, stop and report per the spec's assumption table; do not change the claim or add an index.
  - CA-13 (in-process part): `expectCleanLogs`-style check in these tests: every worker line matches `D10_PATTERNS`; no posted/seeded `patientId`, `type`, `ts`, `data` value or any `idempotencyKey` in `logger.all`.
- Completion evidence: these tests pass; winning plan printed.

### T-09 — Attempt-limit guard e2e file (`MAX_ATTEMPTS=3`)

- Outcome: evidence for the guard and its write-failure path.
- Traces: RF-03, D-02, D-03, D-04, D-08, RNF-03, CA-03, CA-13.
- Dependencies: T-01, T-04.
- File: `test/worker-reclaim-limit.e2e-spec.ts`, `startMongo(..., { enableTestCommands: true })`, `workerEnv({ MAX_ATTEMPTS: '3', WORKER_CONCURRENCY: '10', POLL_INTERVAL_MS: '50', PROCESSING_DELAY_MS: '50', PROCESSING_TIMEOUT_MS: '500', LEASE_MS: '1000' })`; boot one app per test with its own processor (processor overrides don't affect the settings snapshot); `afterEach` turns the failpoint off and closes apps.
- Tests:
  - (a) seed `processing`, `attempts: 3`, expired; spy processor; assert zero calls; document `failed`, `attempts: 4`, `processedAt` set, `lastError` `{ code: 'lease_expired', message: 'Lease expired before the attempt completed', at: Date }`, no `result`/`workerId`/`lockedUntil`; warns in order: reclaim (attempt 4), `Event <_id> failed after 4 attempts (lease_expired)`.
  - (b) seed `processing`, `attempts: 2`, expired; always-failing processor (`error`); one call; `failed`, `attempts: 3`, `lastError.code: 'processor_error'`; no `lease_expired` anywhere.
  - (c) seed `pending`, `attempts: 5`, due; success processor; `done`, `attempts: 6`; no reclaim line.
  - (d) as (a) with a `failCommand` failpoint on `update` (`appName: TEST_APP_NAME`) that fails the guard write beyond what D-07 covers: recommended `closeConnection: true`, mode `{ times: 2 }` (one driver try plus its one retry, as observed in Phase 3; with `LEASE_MS=1000` the 1 s retry wait reaches the lease, so the worker abandons), so the failpoint turns itself off before the next reclaim. Assert a `Write for event <_id> abandoned` warn; then the event is reclaimed again and ends `failed`, `lease_expired`, `attempts: 5`; zero processor calls overall. If the observed driver behaviour differs, use a mode that deterministically fails exactly the first guard write (for example non-retryable `errorCode: 2`, `{ times: 1 }`), or the spec's `EVENTS_COLLECTION` wrapper fallback, and record which in the report. Do not use `alwaysOn` toggled after the warn: the next reclaim can race the toggle.
  - All `lastError.message` values are in `D12_MESSAGES`; logs clean (CA-13).
- Completion evidence: these tests pass; failpoint method recorded (`console.log` like Phase 3's `failpoint usage`).

### T-10 — Stale holder after reclaim (concurrency 1)

- Outcome: evidence that fencing protects a reclaimed event from its old holder.
- Traces: RF-01, D-04, worker D-03, CA-04, CA-13.
- Dependencies: T-01, T-03.
- File: `test/worker-reclaim-stale.e2e-spec.ts`, `workerEnv({ WORKER_CONCURRENCY: '1', POLL_INTERVAL_MS: '50', PROCESSING_DELAY_MS: '50', PROCESSING_TIMEOUT_MS: '10000', LEASE_MS: '30000' })` (section 2, item 2).
- Test: boot A with `BlockingProcessor`; insert one due event; wait for A's call; set the document's `lockedUntil` to now − 1 s; boot B with `SpyProcessor(success)`; wait for `done`, `attempts: 2`; snapshot; `blocking.releaseAll('success')`; wait for `Stale write discarded for event <_id> (attempt 1)`; document deep-equal to the snapshot; exactly one `Reclaimed event <_id> after lease expiry (attempt 2)` line; B's spy called once. Use one shared `CaptureLogger` (both apps log through the static Nest logger override) and assert on line content only, not on which app logged it.
- Completion evidence: test passes.

### T-11 — Drain timeout and no commands after stop (`SHUTDOWN_TIMEOUT_MS=300`)

- Outcome: evidence for the bounded stop, aborts, later reclaim and D-11.
- Traces: RF-05, D-05, D-08, D-11, CA-08, CA-09, CA-13.
- Dependencies: T-01, T-05.
- File: `test/worker-shutdown-timeout.e2e-spec.ts`, `startMongo(..., { enableTestCommands: true })`, `workerEnv({ SHUTDOWN_TIMEOUT_MS: '300', PROCESSING_TIMEOUT_MS: '4000', LEASE_MS: '5000', POLL_INTERVAL_MS: '50', PROCESSING_DELAY_MS: '50', WORKER_CONCURRENCY: '10' })`; a `MarkingLogger`-style logger that records the sink length at `Worker stopped` (copy the pattern from `worker-concurrency-1`, or move it to `test/support/` if shared).
- Tests:
  - CA-08 + CA-09: `BlockingProcessor` never released; 2 due events; wait for 2 calls; snapshot both documents; time `app.close()` → ≤ 1300 ms; log order exactly `Worker stopping: 2 attempts in flight`, `Shutdown timeout after 300 ms: 2 attempts left for lease reclaim`, `Worker stopped`; both `calls[i].signal.aborted`; both documents still `processing`, `attempts: 1`, same `lockedUntil` as the snapshot. Then wait until `PROCESSING_TIMEOUT_MS` + 500 ms after `close()` resolved and assert no `findAndModify` on `events` and no `update` on `events` in the sink after the marker. Then (after `lockedUntil`) boot a new instance with a success spy and assert both end `done`, `attempts: 2`.
  - CA-09 retry variant: `BlockingProcessor`; 1 due event; set `failCommand` on `update` (`closeConnection: true`, `alwaysOn`, `appName` scoped); release the attempt with success; wait until the sink shows the failed `update` commands (worker is now in its 1 s D-07 retry wait); call `app.close()`; after `Worker stopped`, wait > 1 s (past when the retry would have fired) and assert no `update` on `events` after the marker; failpoint off in `afterEach`.
  - Logs clean (CA-13).
- Completion evidence: tests pass; timings logged.

### T-12 — Poll spacing and pool-full wake (F-01 regression)

- Outcome: evidence that idle claims are spaced by `POLL_INTERVAL_MS` regardless of completions, and the pool-full wake still works.
- Traces: RF-06, D-07, worker D-13, CA-12, CA-13.
- Dependencies: T-01, T-02.
- Files:
  - `test/worker-poll-spacing.e2e-spec.ts`: `workerEnv({ POLL_INTERVAL_MS: '1000', WORKER_CONCURRENCY: '10', PROCESSING_DELAY_MS: '100', PROCESSING_TIMEOUT_MS: '10000', LEASE_MS: '30000' })`, `enableTestCommands: true`, command sink.
    - Empty-claim case: processor resolving after 100 ms (`SimulatedProcessor({ delayMs: 100, failureRate: 0 })` wrapped in a spy); one due event; identify the `findAndModify` on `events` sent right after the claiming one (sent while the attempt is in flight, before it settles); assert the attempt settled before the next claim and the next claim is ≥ 900 ms after that empty claim.
    - Failed-claim case: use a `BlockingProcessor` so the test controls when the attempt settles: after the event is claimed and the empty follow-up claim is observed, set `failCommand` on `findAndModify` with `errorCode: 2`, `{ times: 1 }`; wait for the `Claim failed` warn; release the attempt immediately; assert the next claim is ≥ 900 ms after the failed one. This is the spec's "same check after a failed claim (failpoint, 1 time)"; the blocking processor only makes the timing deterministic.
  - `test/worker-pool-wake.e2e-spec.ts`: `workerEnv({ POLL_INTERVAL_MS: '1000', WORKER_CONCURRENCY: '1', PROCESSING_DELAY_MS: '100', PROCESSING_TIMEOUT_MS: '10000', LEASE_MS: '30000' })`; processor resolving after 100 ms; 3 due events; for each processor call after the first, the claim that took it was sent within 200 ms of the previous attempt settling (use the spy's settle time and sink timestamps).
- Optional: `src/worker/events-worker.spec.ts` unit test with a fake collection (as in the F-01 probe) if the implementer wants faster evidence; not a substitute for the e2e above.
- Completion evidence: tests pass; measured gaps printed.

### T-13 — Child-process signal suite

- Outcome: real-signal evidence for drain, POST during drain, SIGKILL recovery and stdout hygiene.
- Traces: RF-01, RF-02, RF-04, RF-05, D-06, D-08, D-09, D-10, RNF-03, CA-06, CA-07, CA-10, CA-13.
- Dependencies: T-03, T-05, T-06.
- File: `test/process-signals.e2e-spec.ts` (suggested by the spec).
- Setup:
  - `beforeAll` (timeout ≥ 180 s): `startMongo('signals')`, a test `MongoClient`, and `npm run build` once (`execFile('npm', ['run', 'build'], { cwd: <repo root> })`, failing the suite on non-zero exit).
  - Spawn helper: `spawn(process.execPath, ['dist/main.js'], { cwd: <repo root>, env: <explicit>, stdio: ['ignore', 'pipe', 'pipe'] })`. Explicit env only (no spread of `process.env`): `MONGO_URI`, `PORT` (free port from a `net` server bound to port 0, then closed), `NO_COLOR=1`, every worker setting (`workerEnv` values with the CA's overrides). Collect stdout and stderr text. Ready when `GET http://127.0.0.1:<port>/health` returns 200 (global `fetch`). Exit promise resolving `{ code, signal }`.
  - `afterEach`: SIGKILL any child still running; `deleteMany` the collection. `afterAll`: close client, stop Mongo.
  - Worker-line extraction: lines containing `[EventsWorker] `, message is the text after it.
- Tests:
  - CA-06: settings `PROCESSING_DELAY_MS=1500`, `PROCESSING_TIMEOUT_MS=3000`, `LEASE_MS=5000`, `SHUTDOWN_TIMEOUT_MS=10000`, `FAILURE_RATE=0`, small poll. POST 3 events (fictional, distinct content); wait until all 3 are `processing`; `child.kill('SIGTERM')`; exit within 10 s with `signal === 'SIGTERM'` or `code === 143` (record which); stdout has `Worker stopping: 3 attempts in flight` before `Worker stopped`, and no `Shutdown timeout`; all 3 documents `done`, `attempts: 1`.
  - CA-07: as CA-06; right after sending SIGTERM (once `Worker stopping` appears in stdout), POST a fourth event with new content; expect `202` and `duplicate: false`; after exit that event is `pending`, `attempts: 0`. The fourth POST must finish before the drain ends (about 1.5 s window).
  - CA-10: child A with `PROCESSING_DELAY_MS=3000`, `PROCESSING_TIMEOUT_MS=4000`, `LEASE_MS=5000`; POST 1 event; wait until `processing`; record `workerId` and `lockedUntil`; SIGKILL; A's stdout has no `Worker stopped`. Start child B with the same settings (new port). While `Date.now() < lockedUntil`, the document keeps A's `workerId` and `processing`. Then B logs `Reclaimed event <_id> after lease expiry (attempt 2)` and the document ends `done`, `attempts: 2`; `countDocuments({ idempotencyKey })` is 1. Stop B with SIGTERM at the end.
  - CA-13 (process part): for every child, every worker line matches `D10_PATTERNS`; stdout and stderr contain none of the posted `patientId`, `type`, `ts`, `data` values or any stored `idempotencyKey`.
- Completion evidence: tests pass; observed exit `{ code, signal }` printed.

### T-14 — Full verification and scope review

- Outcome: CA-01 evidence and scope confirmation.
- Traces: CA-01, CA-14, RNF-04, Preserve.
- Dependencies: T-01 to T-13.
- Steps: run the section 6 commands; run `git diff --stat` and confirm only `src/worker/events-worker.ts`, `src/main.ts`, `test/support/worker.ts`, the three existing suites from T-07 and the new test files changed; confirm `package.json`, `package-lock.json`, `src/database`, `src/events`, `src/config`, `src/worker/worker.module.ts`, `docker-compose.yml`, `Dockerfile`, `README.md` are untouched; confirm `src/worker` logger calls are only worker D-10 and D-08 templates (`grep -n "logger\." src/worker`); record F-01 as resolved with the CA-12 evidence.
- Completion evidence: command outputs in the implementation report.

## 6. Verification plan

All checks are planned. None have been executed.

| Check | Command or procedure | Expected evidence | Criteria |
| --- | --- | --- | --- |
| Build | `npm run build` | exit 0 | CA-01 |
| Lint | `npm run lint` | exit 0, no output | CA-01, RNF-04 |
| Type-check tests | `npx tsc --noEmit --incremental false -p tsconfig.json` | exit 0 | CA-01 (supplementary) |
| Unit | `npm test` | exit 0; existing unit suites unchanged | CA-01 |
| E2E (all) | `npm run test:e2e -- --silent=false` | exit 0; all Phase 1–3 suites plus the new files pass; console shows failpoint usage, CA-11 winning plan, CA-12 gaps, child exits | CA-01 to CA-14 |
| E2E focused | `npx vitest run --config ./vitest.config.e2e.ts test/worker-reclaim test/worker-shutdown-timeout test/worker-poll-spacing test/worker-pool-wake test/process-signals --reporter=verbose` | per-test pass list | CA-02 to CA-13 |
| Stability | `npm run test:e2e` a second time | exit 0 (timing-sensitive suites stable) | CA-08, CA-12, CA-06 |
| Scope | `git diff --stat`; `git status --short` | only planned files | RNF-04, Preserve |
| Log templates | `grep -n "logger\." src/worker/events-worker.ts` | only D-10 and D-08 templates | CA-13, D-08 |
| Manual (optional) | Spec section 11 Docker procedure (`docker compose up --build`, `stop app`, `kill app`, `start app`) | `Worker stopping…`/`Worker stopped`; later `Reclaimed event…`; events `done` | CA-06, CA-10 (supplementary) |

- Setup: Node 24, local `mongodb-memory-server` binary 7.0.45 (already used by existing suites), free local ports for children.
- Record in the implementation report: Node and MongoDB versions; child exit `{ code, signal }`; the CA-11 winning plan; failpoint modes and command counts; pass/fail/blocked per CA; the T-07 short-lease settings change.
- Limitations: one-member replica set (no failover); timings depend on machine load, especially while `npm run build` runs in parallel with other e2e files (lower bounds like ≥ 900 ms are robust; the 200 ms pool-wake and 1300 ms close bounds are the sensitive ones).

## 7. Risk and recovery

- R-01 — CA-11 assumption fails (blocking `SORT` in the `$or` claim plan). Per spec: stop implementation and report; the spec must be revised (hint or index). Do not change the claim or add an index.
- R-02 — `test/worker-short-lease.e2e-spec.ts` settings change (`POLL_INTERVAL_MS` 50 → 5000). Necessary because reclaim otherwise races the asserted abandon. Assertions unchanged. If the reviewer considers any edit outside the CA-05 test out of scope, the alternative is a spec revision; report it explicitly in the implementation report.
- R-03 — Timing flakiness (CA-08 1300 ms bound, CA-12 200 ms wake, child-process windows). Mitigation: the settings the spec chose; generous `waitFor` budgets; second full run. A flaky result is reported, not hidden by loosening a CA bound.
- R-04 — Child-process suite: `npm run build` deletes and rebuilds `dist/` (`deleteOutDir`); nothing else in the test run reads `dist/`. Orphan children are killed in `afterEach`. Port race between picking and binding is small; on `EADDRINUSE` the child exits and the test fails visibly.
- R-05 — Cancelled attempts after the deadline: a write already sent may complete after `Worker stopped`; D-05 allows it, and the result is ignored. CA-09 checks no new command is sent, which is the stated property.
- R-06 — Spec factual discrepancies with Nest 12.3.2 (non-blocking): HTTP close happens before `DatabaseModule.onApplicationShutdown` (spec D-10/RF-04 state the reverse), and a second signal during the drain is ignored rather than killing the process. Neither changes any task or CA. Suggest correcting the wording in a later spec revision via `/create-spec`.
- Regression surface: every worker suite (claim, fencing, retries, stop) and the Phase 1–2 suites through `npm run test:e2e`. No migrations, no data shape change, no destructive or external action. Rollback: revert the commit(s); existing documents remain valid (`lease_expired` is a plain string code).

## 8. Coverage matrix

| ID | Tasks | Checks |
| --- | --- | --- |
| RF-01 | T-03, T-08, T-10, T-13 | CA-02, CA-04, CA-05, CA-10, CA-11, CA-14 |
| RF-02 | T-03, T-08, T-13 | CA-02, CA-10 |
| RF-03 | T-04, T-09 | CA-03 |
| RF-04 | T-06, T-13 | CA-06, CA-07, CA-10 |
| RF-05 | T-05, T-11, T-13 | CA-06, CA-07, CA-08, CA-09 |
| RF-06 | T-02, T-12 | CA-12 |
| RNF-01 | Not applicable — backend only, no UI (spec RNF-01) | — |
| RNF-02 | Not applicable — no UI (spec RNF-02) | — |
| RNF-03 | T-01, T-04, T-08–T-13 | CA-13 |
| RNF-04 | T-03, T-08, T-14 | CA-01, CA-11, CA-12 |
| D-01 | T-03, T-07, T-08 | CA-02, CA-05, CA-11, CA-14 |
| D-02 | T-03, T-04 | CA-02, CA-03 |
| D-03 | T-04, T-09 | CA-03 |
| D-04 | T-03, T-08, T-10 | CA-02, CA-04 |
| D-05 | T-05, T-11 | CA-08, CA-09 |
| D-06 | T-06, T-13 | CA-06 |
| D-07 | T-02, T-12 | CA-12 |
| D-08 | T-01, T-03, T-05, T-08–T-13 | CA-13, CA-02, CA-06, CA-08 |
| D-09 | T-13 | CA-06, CA-07, CA-10 |
| D-10 | T-06, T-13 | CA-07 |
| D-11 | T-05, T-11 | CA-09 |
| CA-01 | T-07, T-14 | Section 6 build, lint, unit, e2e |
| CA-02 | T-08 | `worker-reclaim` |
| CA-03 | T-09 | `worker-reclaim-limit` |
| CA-04 | T-10 | `worker-reclaim-stale` |
| CA-05 | T-08 | `worker-reclaim` |
| CA-06 | T-13 | `process-signals` |
| CA-07 | T-13 | `process-signals` |
| CA-08 | T-11 | `worker-shutdown-timeout` |
| CA-09 | T-11 | `worker-shutdown-timeout` |
| CA-10 | T-13 | `process-signals` |
| CA-11 | T-08 | `worker-reclaim` (explain) |
| CA-12 | T-12 | `worker-poll-spacing`, `worker-pool-wake` |
| CA-13 | T-01, T-07, T-08–T-13 | log checks in each suite; `worker-disabled` |
| CA-14 | T-07 | `worker.e2e-spec.ts` updated CA-05 |
| Preserve (worker CA-16, Phase 1–3 suites) | T-02, T-05, T-07, T-14 | `worker-concurrency-1`, full e2e run |

## 9. Implementation handoff

- Prerequisites: `npm ci` state as in the repo; MongoDB 7.0.45 binary available to `mongodb-memory-server`; free local ports. No secrets, services or network access needed.
- Permitted scope: `src/worker/events-worker.ts`, `src/main.ts`, `test/support/worker.ts` (and an optional small shared helper under `test/support/`), `test/worker.e2e-spec.ts` (CA-05 test only), `test/worker-short-lease.e2e-spec.ts` (`POLL_INTERVAL_MS` setting only), `test/worker-disabled.e2e-spec.ts` (one added assertion), the new e2e files in T-08 to T-13, and optionally `src/worker/events-worker.spec.ts`. No dependency, lockfile, index, model, config, compose, Dockerfile or README changes. No commits unless the user asks.
- Known non-blocking risks: R-01 (stop condition defined by the spec), R-02 (short-lease settings change, must be reported), R-03 (timing), R-04 (build in the e2e run), R-06 (spec wording vs Nest 12.3.2 close order and second-signal handling).
- Report must include: per-CA pass/fail/blocked, CA-11 winning plan, child exit signal/code, failpoint methods, F-01 resolved with CA-12 timings, and the T-07 changes.
- Confirmation: no blocking ambiguity remains. Every RF, RNF, D and CA identifier is mapped above.
