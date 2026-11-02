# Events worker — stored events are claimed, processed by the simulated external call, and end as `done` or, after bounded retries, `failed`

## 1. Status and reading contract

- Status: ready for implementation.
- Updated: 2026-11-02.
- Decision owner: repository owner (decisions recorded from the create-spec interview of 2026-11-02).
- Affected areas/routes: a new worker module in `src/worker/`, `src/app.module.ts`, `src/config/env.validation.ts` (`WORKER_ENABLED`), `docker-compose.yml` (pass-through), `README.md` (configuration table row), the existing e2e suites (run with the worker disabled), and new unit and e2e tests. No HTTP route is added or changed.
- Audience: operators and evaluators who need submitted events to actually be processed (PLAN P1, P2, P5, G7). It is also the foundation that Phase 4 (lease reclaim, graceful shutdown with a timeout), Phase 5 (`/stats`) and Phase 6 (load, chaos and verification) build on.
- Deliverable type: integrated backend change (background processing in the same process as the API). No frontend.
- Related or superseded document: `PLAN.md` Phase 3, §3 (claim query), P1, P5, P6, G2, G6, G7, G10, G12. It builds on `.ai/.specs/events-ingest-path.md` and `.ai/.specs/events-data-model.md` (both implemented and verified) and supersedes nothing in them.
- Convention: `RF-xx` for functional requirements; `RNF-xx` for quality requirements; `D-xx` for decisions; `CA-xx` for acceptance criteria.

This spec describes the desired state. Nothing in it has been implemented or verified yet. All requirements are mandatory unless explicitly marked optional.

## 2. Context and problem

`POST /events` stores each event as `pending` with `attempts: 0` and `nextAttemptAt = receivedAt` (Phase 1), and the claim index exists (Phase 2). Nothing ever picks the events up, so every event stays `pending` forever. PLAN P1 needs about 84 events in flight at any time (1000/min × 5 s), so processing must be concurrent, and P5 needs each event to be completed at most once even though processing is at-least-once.

### Evidence and current state

| Verifiable reference | Observed fact | Implication |
| --- | --- | --- |
| `src/config/env.validation.ts` | `WORKER_CONCURRENCY` (100), `LEASE_MS` (30000), `POLL_INTERVAL_MS` (500), `PROCESSING_DELAY_MS` (5000), `PROCESSING_TIMEOUT_MS` (10000), `FAILURE_RATE` (0.05), `MAX_ATTEMPTS` (5), `BACKOFF_BASE_MS` (1000), `BACKOFF_MAX_MS` (60000) and `SHUTDOWN_TIMEOUT_MS` (20000) are already validated. `LEASE_MS > PROCESSING_TIMEOUT_MS` and `BACKOFF_MAX_MS >= BACKOFF_BASE_MS` are enforced. Blank values mean the default. | Reuse these settings. Only `WORKER_ENABLED` is new (D-08). `SHUTDOWN_TIMEOUT_MS` stays unused until Phase 4. |
| `src/events/event.document.ts` | `EventDocument` has every processing field as optional. A doc comment fixes the presence rules (data-model D-04), the `$unset` rule (D-03) and `EventError { code, message, at }` with no payload in `message` (D-05). | The worker's writes must follow these rules exactly (RF-04, RF-05). |
| `src/database/database.module.ts` | Exports `MONGO_CLIENT` and `EVENTS_COLLECTION`. Creates `claim_status_nextAttemptAt` on `{ status: 1, nextAttemptAt: 1 }` in `onModuleInit`. Closes the client in `onApplicationShutdown`. | The worker starts after module init (indexes exist) and must stop before `onApplicationShutdown` closes the client (D-02). |
| `src/events/store-errors.ts` | `isStoreUnavailable(error)` classifies driver errors that mean "the store can't confirm now". | Reuse it to decide which write errors are retried (D-07). |
| `src/events/events.service.ts` | Writes use `{ w: 'majority', wtimeoutMS: 5000 }`. Store errors are logged as `warn` with the class name and code only. | Use the same write concern and log format (D-10, D-11). |
| `src/main.ts` | `enableShutdownHooks` is not called. | Signals don't trigger shutdown hooks yet. That is Phase 4. In this phase the stop runs on `app.close()` (D-02). |
| `test/events.e2e-spec.ts` (lines 79–105, 137–158), `test/events-data-model.e2e-spec.ts`, `test/events-store-down.e2e-spec.ts` | They assert stored documents stay `pending`/`attempts: 0`, seed `processing`/`done` documents directly, and expect exactly one `warn` line after Mongo stops. | A running worker would break them, so they run with `WORKER_ENABLED=false` (D-08, CA-22). |
| `test/support/app.ts`, `mongo.ts`, `capture-logger.ts` | `createTestApp({ mongoUri, logger, configure })` has a provider-override hook. `startMongo` starts a one-member 7.0.45 replica set. | Reuse them. Tests swap in a controllable processor through `configure` (D-05). |
| `docker-compose.yml` | Passes every worker variable through from the shell. `init: true` and `stop_grace_period: 30s` are already set. | Add `WORKER_ENABLED` to the pass-through list. No other compose change. |
| `package.json` | `mongodb` ^7.8.0, NestJS 12, vitest 4, `mongodb-memory-server` ^11.3.0. Scripts: `build`, `lint`, `test`, `test:e2e`. | No new dependencies. |
| `AGENTS.md` | Optional NestJS Observe telemetry. `ObserveModule` is not registered. | Not applied in this phase (PLAN G12 defers metrics). |

Missing: the claim loop, the bounded concurrency, the simulated processor, the timeout, the fenced completion and failure writes, the backoff policy, the stop on close and a switch to disable the worker.

## 3. Objective and expected outcome

- Product outcome: every process with `WORKER_ENABLED=true` (the default) runs a pool of up to `WORKER_CONCURRENCY` concurrent attempts. Each attempt atomically claims the due `pending` event with the oldest `nextAttemptAt`, calls the external processor (by default the simulator, which receives the idempotency key), and records the outcome with a write that applies only if this attempt still holds the claim. A failed attempt is retried with exponential backoff and equal jitter. After `MAX_ATTEMPTS` attempts the event becomes `failed` and stays visible. On `app.close()` the worker stops claiming and waits for in-flight attempts to finish.
- Verifiable success signal: unit tests for the backoff and the simulator, and e2e tests against the in-memory 7.0 replica set for each scenario in section 11. In particular: POST, then poll until `done`; no double claims across two instances; the exact retry and failure transitions; rejected stale writes; the concurrency bound; and the stop behaviour.
- Limits of the claim: this phase doesn't reclaim expired leases. An event whose process dies mid-attempt, or whose final write is abandoned (D-07), stays `processing` until Phase 4. It doesn't react to SIGTERM or bound the stop wait (Phase 4), and doesn't measure throughput at 1000/min (Phase 6). The simulated call is not a real integration: success is marked by `result: { simulated: true }`.

## 4. Scope

### Included

- A worker that starts after app initialization and polls with bounded concurrency (RF-01, RF-02).
- The pending-only claim query from PLAN §3 (RF-02).
- The processor contract plus the simulated processor, with delay, failure rate, abort support and the idempotency key (RF-03).
- The per-attempt timeout (RF-03).
- Fenced success and failure writes, the backoff policy and the final `failed` state (RF-04, RF-05).
- Bounded retry of the outcome write on store errors (RF-06).
- Stop on application close: stop claiming, then wait for in-flight attempts (RF-07).
- The `WORKER_ENABLED` setting, its compose pass-through and README row (RF-08).
- The log lines in D-10 and nothing else.
- Unit and e2e tests for every scenario in section 11. The existing e2e suites are switched to `WORKER_ENABLED=false`.

### Out of scope

- Reclaiming expired leases (`status: processing, lockedUntil < now`) and any test of it: Phase 4.
- `enableShutdownHooks`, SIGTERM handling and the `SHUTDOWN_TIMEOUT_MS` bound: Phase 4.
- `GET /stats` and the Mongo check in `GET /health`: Phase 5.
- Load, chaos and verification scripts: Phase 6.
- Per-patient serialization or ordering of processing (PLAN G2: processing order doesn't matter, and order is rebuilt at read time).
- Separate API and worker roles, change streams, metrics, a real broker, and retrying `failed` events (PLAN "with more time"). `WORKER_ENABLED` is a switch, not a role split (D-08).
- A real external integration.
- README architecture or decision docs: Phase 8. Only the configuration table gains a row.
- New indexes or changes to existing ones.

### Preserve

- The `POST /events` contract, responses, stored initial document, `w: 'majority'` insert and logging (Phase 1).
- The three secondary indexes and startup semantics (Phase 2 RF-02, D-06).
- `EventDocument` and its presence rules (data-model D-03, D-04, D-05). This phase doesn't change the type.
- `GET /health` → `200 { status: 'ok' }`.
- Every existing environment variable, default and cross-field rule.
- The Dockerfile. In docker-compose, only the pass-through list changes.
- Existing test assertions: the only change to existing suites is that they run with `WORKER_ENABLED=false`.

## 5. Decisions, assumptions, and questions

### Adopted decisions

| ID | Concrete decision | Rationale and impact |
| --- | --- | --- |
| D-01 | The claim matches only `{ status: 'pending', nextAttemptAt: { $lte: now } }`, sorted by `{ nextAttemptAt: 1 }`. The expired-lease branch of PLAN §3 is added in Phase 4. | Chosen in the interview. Follows the PLAN phase list, and Phase 4 owns reclaim and its tests. |
| D-02 | On `app.close()` (Nest `beforeApplicationShutdown`), the worker stops starting new claims, cancels any idle wait at once, and resolves only after every in-flight attempt, including its outcome write and that write's retries, has settled. The wait has no time limit in this phase. Each attempt is bounded by `PROCESSING_TIMEOUT_MS` plus the D-07 retries. | Chosen in the interview. `DatabaseModule.onApplicationShutdown` closes the client afterwards, so no outcome write hits a closed client. Phase 4 adds the signal hooks and the `SHUTDOWN_TIMEOUT_MS` bound. |
| D-03 | Every outcome write uses the fenced filter `{ _id, status: 'processing', workerId: <this process>, attempts: <value returned by this claim> }`. If it matches 0 documents, nothing changes and a stale-write `warn` is logged (D-10). | Chosen in the interview. `attempts` increases on every claim, so it works as a fencing token even when the same process reclaims an event (Phase 4). No new field is needed. |
| D-04 | Backoff after a failed attempt `n` (1-based, = the claimed `attempts`): `cap = min(BACKOFF_MAX_MS, BACKOFF_BASE_MS × 2^(n−1))`, `delay = cap/2 + random() × cap/2`, so `delay ∈ [cap/2, cap)`, and `nextAttemptAt = now + delay` (rounded down to whole ms). `random` is injectable for tests. | Chosen in the interview (equal jitter). There is always some backoff, it still spreads bursts out, and it has firm test bounds. With the defaults, attempts 1–4 wait 0.5–1 s, 1–2 s, 2–4 s and 4–8 s. With `BACKOFF_BASE_MS=0` the delay is 0. |
| D-05 | The external call is behind an injectable provider (token `EVENT_PROCESSOR`) with the contract `process(input: { eventId: string; idempotencyKey: string; patientId: string; type: string; ts: Date; data: Record<string, unknown> }, signal: AbortSignal): Promise<Record<string, unknown>>`. The default is the simulator. | It passes the idempotency key (PLAN G6), lets tests drive outcomes deterministically, and leaves room for a real integration later. |
| D-06 | Simulator: it waits `PROCESSING_DELAY_MS`, then with probability `FAILURE_RATE` rejects with a simulated-failure error, otherwise resolves `{ simulated: true }`. An abort rejects at once. Its random source is injectable. The worker races each call against `PROCESSING_TIMEOUT_MS`: if the timer wins, it aborts the signal and records a `timeout` failure. A result that arrives after the timeout is ignored. Timeouts only happen when `PROCESSING_DELAY_MS ≥ PROCESSING_TIMEOUT_MS`. | Chosen in the interview (fail after the delay). A failure costs the same slot time as a success. `{ simulated: true }` marks the result as simulated. |
| D-07 | When an outcome write throws a store-unavailable error (`isStoreUnavailable`), the same fenced write is retried up to 3 more times, 1 s apart. No retry starts at or after the claim's `lockedUntil`. Any other error is not retried. If the write still hasn't succeeded, the worker logs an abandoned-write `warn` (D-10), leaves the document as it is (`processing`, recovered by Phase 4 reclaim), and moves on. | Chosen in the interview. It rides out a short failover without repeating the 5 s call. Safety holds because every retry is fenced (D-03). |
| D-08 | New setting `WORKER_ENABLED`, default `true`. Only the exact strings `true` and `false` are accepted, and blank means the default, as for the other variables. Any other value stops startup with `WORKER_ENABLED must be true or false`. When `false`, no claim is ever sent and one `log` line is written (D-10). Compose passes it through, and the README config table documents it. | Chosen in the interview. Keeps the existing e2e suites deterministic and is useful for debugging. Exact-string parsing avoids `Boolean('false') === true`. It is not an API/worker role split. |
| D-09 | `workerId` = `<os.hostname()>:<process.pid>:<8 random lowercase hex chars>`, fixed when the worker starts. | Low-risk. Identifies the process for diagnostics (D-03 provides per-claim fencing). The hostname is the container id under Compose and isn't clinical data. |
| D-10 | Logging (context `EventsWorker`). Only these lines, with exactly this text: `log` `Worker started: concurrency <n>, workerId <workerId>`; `log` `Worker disabled (WORKER_ENABLED=false)`; `log` `Worker stopped`; `warn` `Event <_id> failed after <attempts> attempts (<code>)`; `warn` `Stale write discarded for event <_id> (attempt <attempts>)`; `warn` `Claim failed: <ErrorName>[ (code <code>)]`; `warn` `Write for event <_id> abandoned: <ErrorName>[ (code <code>)]`. Successes and non-final retries log nothing. Never logged: `patientId`, `type`, `ts`, `data`, `idempotencyKey`, `result`, error messages from the processor or the driver. | Chosen in the interview (`_id` and fixed codes are allowed). Follows Phase 1 D-14. The `[ (code …)]` part appears only when the error has a code, matching `EventsService`. |
| D-11 | The claim and every outcome write use `writeConcern: { w: 'majority', wtimeoutMS: 5000 }`. The claim is `findOneAndUpdate` with `returnDocument: 'after'`. Outcome writes are `updateOne` with the D-03 filter. `now` is the app's clock (`new Date()`), read when the claim is sent and again when each outcome is written. | Consistent with Phase 1 D-04 and P4. Uses the app clock, as `receivedAt` already does. |
| D-12 | `lastError` codes and messages (fixed): `simulated_failure` → `Simulated external call failure`; `timeout` → `External call timed out after <PROCESSING_TIMEOUT_MS> ms`; `processor_error` (any other rejection or throw from the processor) → `External call failed`. `at` is the time the failure was recorded. | Fulfills data-model D-05: no payload or key in `message`. The original error's text is never stored. |
| D-13 | A single dispatcher loop keeps up to `WORKER_CONCURRENCY` attempts in flight. While a slot is free and the last claim returned an event, it claims again at once. When a claim returns nothing, or throws (logged per D-10), it waits `POLL_INTERVAL_MS` (cancelled at once by stop) before claiming again. A freed slot wakes the loop if it is waiting because the pool is full. No error from the loop or an attempt escapes as an unhandled rejection. | Low-risk, reversible, and not externally visible. Idle cost is one claim query per `POLL_INTERVAL_MS` per process, whatever the concurrency, rather than one per slot. |
| D-14 | The worker starts in `onApplicationBootstrap`, after every `onModuleInit` (so all indexes exist). It lives in a new `WorkerModule` under `src/worker/`, imported by `AppModule`, which imports `DatabaseModule`. | Matches the existing module layout. The HTTP server isn't affected. |
| D-15 | Final failure: when a failed attempt has `attempts ≥ MAX_ATTEMPTS`, the event becomes `failed`, with no further backoff. | PLAN G7. `≥` handles a `MAX_ATTEMPTS` that was lowered between runs. With `MAX_ATTEMPTS=1` the first failure is final. |
| D-16 | No new README sections. Only the configuration table gains the `WORKER_ENABLED` row: `` `WORKER_ENABLED` \| `true` \| Run the background worker in this process (`true` or `false`) ``. | PLAN Phase 8 owns the architecture docs. The table already lists every variable. |

### Assumptions to verify

| Assumption | Available evidence | Confirmation / effect if false |
| --- | --- | --- |
| `mongodb-memory-server` 11 starts `mongod` with test commands enabled, so a `failCommand` failpoint can make `update`/`findAndModify` fail with a retryable network-class error. | Unconfirmed. | CA-14 and CA-15 use the failpoint if `configureFailPoint` works. If not, they override the `EVENTS_COLLECTION` provider with a wrapper whose `updateOne` or `findOneAndUpdate` throws a `MongoNetworkError` a fixed number of times, and the implementation report says which method was used. |
| The driver's own retryable-writes logic doesn't fully absorb the failpoint's errors before the worker sees them. | `retryWrites` defaults to true and retries once. | Configure the failpoint to fail at least 2 more times than the driver retries, so the worker's D-07 retry is what's being exercised. Record the counts used. |
| Running a single dispatcher's claims one after another keeps up with PLAN P1 (about 17 claims/s per process at 1000/min). | Each claim is one indexed `findAndModify`. Unmeasured. | Measured in Phase 6. If it falls short, a later spec may allow parallel claims. |
| Clock skew between replicas is small compared with the backoff and lease durations. | All replicas use the host clock. Unconfirmed in production. | Accepted as a known limit (PLAN G2 already accepts sender clock skew). Phase 4 documents the effect on leases. |

### Open questions

None blocking. Non-blocking follow-ups: Phase 4 adds reclaim, which recovers events left by D-07 and by a crash, and adds the shutdown timeout. Phase 6 measures claim throughput and contention.

## 6. User journey and states

### Preconditions and entry

- The app has initialized against a MongoDB replica set: it is connected and the three indexes exist.
- `WORKER_ENABLED` is `true` (the default). The events were stored by `POST /events`, or written directly in tests with the Phase 1 shape.
- There is no HTTP surface for the worker and no authentication change.

### Main flow

1. On bootstrap the worker logs `Worker started: concurrency 100, workerId <id>` and begins claiming.
2. It claims the due `pending` event with the oldest `nextAttemptAt`: `status: 'processing'`, `workerId`, `lockedUntil = now + LEASE_MS`, and `attempts` incremented.
3. It calls the processor with the event's fields, the idempotency key and an abort signal, racing it against `PROCESSING_TIMEOUT_MS`.
4. On success: `status: 'done'`, `result`, `processedAt`; `workerId` and `lockedUntil` are `$unset`; any earlier `lastError` is kept. The write is fenced.
5. The slot is free and the loop claims the next due event.

### Alternatives and exceptions

- Attempt fails and `attempts < MAX_ATTEMPTS`: the event goes back to `pending` with `nextAttemptAt = now + delay` (D-04) and `lastError` set (D-12). `workerId` and `lockedUntil` are `$unset` (CA-10).
- Attempt fails and `attempts ≥ MAX_ATTEMPTS`: `failed`, with `processedAt` and `lastError`, `workerId`/`lockedUntil` `$unset`, and no `result`. One `warn` line. It is never claimed again (CA-11).
- Timeout: recorded as a `timeout` failure. The signal is aborted and a late result is ignored (CA-12).
- Fenced write matches nothing (the event is no longer held by this attempt): no change, plus a stale-write `warn` (CA-13).
- Store error on an outcome write: D-07 retries, then the write is abandoned with a `warn`, and the document stays `processing` until Phase 4 (CA-14).
- Store error or other error on a claim: a `warn`, then a wait of `POLL_INTERVAL_MS` and another try. The process stays up and `GET /health` keeps answering (CA-15).
- No due events: the loop waits `POLL_INTERVAL_MS` between claims.
- `app.close()`: stop claiming, wait for in-flight attempts, then `Worker stopped` (CA-16).
- `WORKER_ENABLED=false`: no claims at all (CA-17).
- Events of the same patient are processed in parallel (PLAN G2, CA-08).

| State (event) | Trigger | Observable document | Exit condition |
| --- | --- | --- | --- |
| `pending`, due | Ingest, or a retry's `nextAttemptAt` passed | `attempts` = attempts so far; no `workerId`/`lockedUntil` | Claimed |
| `pending`, waiting | Failed attempt below the limit | `nextAttemptAt` in the future; `lastError` set | `nextAttemptAt` passes |
| `processing` | Claim | `workerId`, `lockedUntil`, `attempts` +1 | Fenced outcome write; or abandoned (stays until Phase 4) |
| `done` (terminal) | Successful attempt | `result`, `processedAt`; no lock fields | — |
| `failed` (terminal) | Failed attempt at the limit | `lastError`, `processedAt`; no lock fields, no `result` | — (retrying `failed` is out of scope) |

| State (worker) | Trigger | Behaviour | Exit condition |
| --- | --- | --- | --- |
| Disabled | `WORKER_ENABLED=false` | One `log` line, no Mongo commands from the worker | Process exit |
| Running | Bootstrap | Claims while slots are free and work is due; otherwise polls | `app.close()` |
| Stopping | `beforeApplicationShutdown` | No new claims; in-flight attempts finish their outcome writes | Last attempt settles → `Worker stopped` |
| Stopped | Stop complete | Nothing runs; the client is then closed by `DatabaseModule` | — |

## 7. Functional requirements and contracts

### RF-01 — Worker lifecycle

- Trigger: `onApplicationBootstrap`.
- Rules: if `WORKER_ENABLED` is `false`, log `Worker disabled (WORKER_ENABLED=false)` and do nothing else. Otherwise generate `workerId` (D-09), log `Worker started: concurrency <WORKER_CONCURRENCY>, workerId <workerId>`, and start the dispatcher (D-13).
- Output: the background loop runs without blocking bootstrap or the HTTP server.
- Exceptions: no worker error rejects bootstrap or crashes the process.
- Side effects: Mongo claim queries, and none when disabled.

### RF-02 — Claim with bounded concurrency

- Trigger: the dispatcher has a free slot and isn't stopping.
- Rules: `findOneAndUpdate({ status: 'pending', nextAttemptAt: { $lte: now } }, { $set: { status: 'processing', workerId, lockedUntil: now + LEASE_MS }, $inc: { attempts: 1 } }, { sort: { nextAttemptAt: 1 }, returnDocument: 'after', writeConcern: { w: 'majority', wtimeoutMS: 5000 } })`. At most `WORKER_CONCURRENCY` attempts are in flight per process. There is no grouping by patient.
- Output: the claimed document (post-update) starts an attempt. `null` → wait `POLL_INTERVAL_MS`.
- Exceptions: any thrown error → `warn` `Claim failed: <ErrorName>[ (code <code>)]`, then wait `POLL_INTERVAL_MS`.
- Side effects: one document moves to `processing`. Documents in other states, or `pending` with a future `nextAttemptAt`, are never touched (CA-05).

### RF-03 — Processor call with timeout

- Trigger: a successful claim.
- Rules: call `EVENT_PROCESSOR.process({ eventId: _id hex, idempotencyKey, patientId, type, ts, data }, signal)`. Race it with a `PROCESSING_TIMEOUT_MS` timer. When the timer wins, abort the signal and treat it as a `timeout` failure. Clear the timer when the call settles first. The simulator follows D-06.
- Output: a result object (success) or a failure classified by D-12.
- Exceptions: a synchronous throw from `process` counts as `processor_error`.
- Side effects: none besides the call. The worker never logs the input or the result.

### RF-04 — Fenced success write

- Trigger: the processor resolved before the timeout.
- Rules: `updateOne(<D-03 filter>, { $set: { status: 'done', result, processedAt: now }, $unset: { workerId: '', lockedUntil: '' } })`, with the D-11 write concern. `lastError` is not touched.
- Output: matched 1 → done, nothing logged. Matched 0 → `warn` `Stale write discarded for event <_id> (attempt <attempts>)`.
- Exceptions: errors follow RF-06.
- Side effects: exactly one document reaches `done`, once.

### RF-05 — Fenced failure write and backoff

- Trigger: the processor rejected, threw, or timed out.
- Rules: `lastError = { code, message, at: now }` (D-12). If `attempts < MAX_ATTEMPTS`: `$set: { status: 'pending', nextAttemptAt: now + delay(attempts), lastError }`, `$unset: { workerId: '', lockedUntil: '' }`. Otherwise: `$set: { status: 'failed', processedAt: now, lastError }`, `$unset: { workerId: '', lockedUntil: '' }`. The D-03 filter and D-11 write concern apply. `delay` follows D-04.
- Output: on a final failure with matched 1 → `warn` `Event <_id> failed after <attempts> attempts (<code>)`. Matched 0 → stale-write `warn`, as in RF-04.
- Exceptions: errors follow RF-06.
- Side effects: `attempts` is not changed by this write (only the claim increments it).

### RF-06 — Outcome-write retry

- Trigger: an RF-04 or RF-05 `updateOne` throws.
- Rules: if `isStoreUnavailable(error)` and fewer than 3 retries have run and `now < lockedUntil`, wait 1 s and resend the identical update (same filter, same `$set` values computed for this outcome). Otherwise stop and log `warn` `Write for event <_id> abandoned: <ErrorName>[ (code <code>)]`.
- Output: the slot is released either way. The processor is never called again within the attempt.
- Side effects: an abandoned event stays `processing` with its lease (Phase 4 recovers it).

### RF-07 — Stop on close

- Trigger: `beforeApplicationShutdown` (reached via `app.close()`; signal wiring is Phase 4).
- Rules: per D-02. A claim that is already in flight when stop begins is allowed to finish. If it returns an event, that event is processed normally.
- Output: the hook resolves after the last attempt settles, then logs `Worker stopped`. When disabled, it resolves at once and doesn't log.
- Side effects: after the hook resolves, the worker sends no further Mongo commands.

### RF-08 — `WORKER_ENABLED` setting

- Trigger: configuration validation at startup.
- Rules: per D-08. It is added to `EnvironmentVariables` with the same "blank means default" rule, and errors are collected with the others into `Invalid configuration:\n- …`.
- Side effects: the compose `environment` list gains `- WORKER_ENABLED`, and the README row is added (D-16).

### Data and validation

| Field | Type, label, and initial value | Normalization | Rules and limits | Exact message |
| --- | --- | --- | --- | --- |
| `WORKER_ENABLED` | env string → boolean, default `true` | none (no trimming or case folding) | exactly `true` or `false`; blank = default | `WORKER_ENABLED must be true or false` |
| `lastError.code` | string | — | one of `simulated_failure`, `timeout`, `processor_error` | — |
| `lastError.message` | string | — | one of the three D-12 texts | D-12 |
| `result` | object | — | the processor's resolved value. Simulator: `{ simulated: true }` | — |

- Validation timing: config at startup only. The worker doesn't validate documents: it trusts the Phase 1 insert shape.
- Source of truth: `EventDocument` (data model), `EnvironmentVariables` (config).

### Integrations

| Operation | Confirmed contract | Success | Failures and recovery |
| --- | --- | --- | --- |
| Claim (`findOneAndUpdate`) | RF-02, served by `claim_status_nextAttemptAt` (data-model CA-05) | Post-update document | `warn` + wait `POLL_INTERVAL_MS`, then try again |
| Outcome (`updateOne`) | RF-04/RF-05 fenced filter, D-11 write concern | `matchedCount` 1 | 0 → stale `warn`. Error → RF-06 |
| External call (simulated) | D-05/D-06, receives `idempotencyKey`. It is a simulation, marked by `result.simulated: true` | Result object | Rejection/timeout → RF-05 |

### Content and actions

Not applicable: no UI and no HTTP changes.

## 8. Non-functional requirements

### RNF-01 — Visual design, responsiveness, and themes

Not applicable: backend only, no user interface.

### RNF-02 — Accessibility

Not applicable: no user interface.

### RNF-03 — Privacy and security

- Sensitive data: `patientId`, `type`, `ts` and `data` are clinical. They flow only from Mongo to the in-process processor. The simulator discards them.
- Persistence: the worker writes only status, lock fields, `attempts` (via the claim), `nextAttemptAt`, `result`, `lastError` and `processedAt`. It never rewrites the payload fields or `idempotencyKey`.
- Logs: exactly the D-10 lines. `_id`, attempt numbers, `lastError.code`, `workerId` and driver error class names and codes are allowed. Payload fields, `idempotencyKey`, `result` and raw error messages are prohibited.
- `lastError.message` is fixed text (D-12), never derived from the error.
- Trust boundary: unchanged. There is no authentication (Phase 1 D-08), and the worker has no network surface.

### RNF-04 — Quality, performance, and compatibility

- Environment: Node 24, MongoDB 7.0 replica set (Compose and `mongodb-memory-server` 7.0.45).
- Performance: no numeric target in this phase. Structural properties: at most `WORKER_CONCURRENCY` attempts in flight (CA-07), one idle claim per `POLL_INTERVAL_MS` (D-13), and claims served by the claim index. Sizing (P1, G10) is measured in Phase 6.
- Reliability: atomic claims (no double claim across instances, CA-09), fenced writes (CA-13), bounded write retry (CA-14), survival of claim errors (CA-15), and a clean stop (CA-16). Processing is at-least-once with exactly-once completion in the store. Crash recovery is Phase 4.
- Dependencies: none added. Only `node:crypto`, `node:os` and `node:timers/promises` are used.
- Code style: ESM `.js` import suffixes, Prettier and oxlint as configured, comment density matching existing files, and constants for the fixed values (3 retries, 1 s, 5000 ms write timeout).

## 9. Technical guidelines and impact

- Applicable instructions: `AGENTS.md` (Observe telemetry not in scope). There is no `CLAUDE.md`.
- Observed stack: NestJS 12, `mongodb` ^7.8.0, TypeScript 6, vitest 4, `mongodb-memory-server` ^11.3.0 (MongoDB 7.0.45), ESM.
- New dependencies: none.
- Architecture: `WorkerModule` owns the dispatcher, the claim and outcome writes, and the processor provider. `DatabaseModule` keeps sole ownership of the client lifecycle. The backoff function and the simulator are pure or injectable units, so they can be unit-tested.
- Reuse: `EVENTS_COLLECTION`, `isStoreUnavailable`, the `EventDocument`/`EventError` types, `createTestApp`, `startMongo`, `CaptureLogger`.
- Constraints: no new indexes, no change to `EventsService`, no Mongoose, no broker, no new env vars beyond `WORKER_ENABLED`.

| File/area | Current state | Expected change | Risk/regression |
| --- | --- | --- | --- |
| `src/worker/` (suggested: `worker.module.ts`, `events-worker.ts`, `backoff.ts`, `event-processor.ts`, `simulated-processor.ts`) | Absent | RF-01 to RF-07, D-04 to D-06 | Background errors must not crash the process |
| `src/app.module.ts` | Imports Config, Health, Events | Also imports `WorkerModule` | Worker runs in every app, including tests (D-08) |
| `src/config/env.validation.ts` (+ spec) | 12 variables | Add `WORKER_ENABLED` (RF-08) | Boolean parsing pitfalls (D-08) |
| `docker-compose.yml` | Pass-through list | Add `- WORKER_ENABLED` | None |
| `README.md` | Config table | Add one row (D-16) | None |
| `test/events.e2e-spec.ts`, `test/events-data-model.e2e-spec.ts`, `test/events-store-down.e2e-spec.ts`, `test/app.e2e-spec.ts`, `test/startup-failure.e2e-spec.ts` | Worker doesn't exist | Run with `WORKER_ENABLED=false`, assertions unchanged | Must still pass unchanged |
| `test/support/app.ts` | Sets `MONGO_URI` | May accept extra env values (implementation choice) | Shared by all suites |
| `test/worker.e2e-spec.ts` (suggested; may be split per config) | Absent | CA-03 to CA-17, CA-20 | Runtime: use small delays |
| `src/worker/*.spec.ts` | Absent | CA-18, CA-19 | — |

## 10. Traceable acceptance criteria

All e2e criteria run against the in-memory 7.0.45 replica set with small timings (for example `PROCESSING_DELAY_MS=50`, `POLL_INTERVAL_MS=50`, `BACKOFF_BASE_MS=100`) unless stated otherwise. The patient ids and payloads are fictional.

| ID | Given / when | Then, observable | Requirement |
| --- | --- | --- | --- |
| CA-01 | `npm run build`, `npm run lint`, `npm test`. | All exit 0. | RNF-04 |
| CA-02 | `validateEnv` with `WORKER_ENABLED` unset, `''`, `'true'`, `'false'`, `'FALSE'`, `'yes'`, `'1'`. | Unset/`''`/`'true'` → `true`; `'false'` → `false`; the others throw an error whose message contains `WORKER_ENABLED must be true or false`. Combined with another invalid variable, both messages are listed. | RF-08, D-08 |
| CA-03 | Worker on, simulator with `FAILURE_RATE=0`. `POST /events`, then poll the document until it isn't `pending`/`processing` (timeout 10 s). | The document is `done`, `attempts: 1`, `result: { simulated: true }`, with a `processedAt` Date; `workerId`, `lockedUntil` and `lastError` are absent; the payload fields and `idempotencyKey` are unchanged. A spy processor wrapping the simulator received `idempotencyKey` equal to the stored one and `eventId` equal to the `_id` hex. | RF-02–RF-04, D-05, D-06, PLAN Phase 7 E2E |
| CA-04 | A test processor that blocks until released. Insert one due event. | While it is blocked, the document is `processing`, `attempts: 1`, `workerId` matches `/^.+:\d+:[0-9a-f]{8}$/`, and `lockedUntil` is within ±1 s of claim time + `LEASE_MS`. After release it is `done` with the lock fields absent. | RF-02, RF-04, D-09 |
| CA-05 | Seed: due `pending`; `pending` with `nextAttemptAt` 1 h ahead; `processing` with `lockedUntil` in the past; `processing` with `lockedUntil` in the future; `done`; `failed`. Run for 10 × `POLL_INTERVAL_MS`. | Only the due `pending` event was processed. The other five documents are deep-equal to their seeded state (including the expired `processing` one: no reclaim in this phase). | RF-02, D-01 |
| CA-06 | `WORKER_CONCURRENCY=1` and a processor that records call order. Seed 5 due events with distinct `nextAttemptAt` inserted in shuffled order. | The processor is called in ascending `nextAttemptAt` order. | RF-02 |
| CA-07 | `WORKER_CONCURRENCY=3`, a blocking processor, 10 due events. | The maximum number of concurrent `process` calls observed is 3, and exactly 3 documents are `processing` while blocked. After release, all 10 end `done`. | RF-02, D-13, PLAN P1 |
| CA-08 | `WORKER_CONCURRENCY=2`, a blocking processor, 2 due events with the same `patientId`. | Both `process` calls are in flight at the same time. | RF-02, PLAN G2 |
| CA-09 | Two app instances on the same database, `WORKER_CONCURRENCY=10` each, a spy processor that always succeeds, 200 events with distinct content. | All 200 end `done` with `attempts: 1`. The spy saw each `idempotencyKey` exactly once (200 calls in total), and both instances processed at least one event. | RF-02, PLAN P5, Phase 7 integration |
| CA-10 | A processor that fails attempts 1 and 2 (simulated-failure error) and succeeds on 3. `BACKOFF_BASE_MS=200`, `BACKOFF_MAX_MS=10000`. | After each failure, until the next claim, the document is `pending` with no `workerId`/`lockedUntil`, `lastError = { code: 'simulated_failure', message: 'Simulated external call failure', at }`, and `nextAttemptAt − lastError.at` in [cap/2, cap] for cap = 200, 400. It ends `done`, `attempts: 3`, with `lastError` still present from attempt 2. Nothing was logged at `warn`. | RF-05, D-04, D-12, data-model D-04 |
| CA-11 | `MAX_ATTEMPTS=3`, a processor that always fails with a non-simulated error. | The document ends `failed`, `attempts: 3`, with `processedAt`, `lastError.code = 'processor_error'` and `message = 'External call failed'`; `result`, `workerId` and `lockedUntil` are absent. Exactly one `warn` reads `Event <_id> failed after 3 attempts (processor_error)`. After another 10 × `POLL_INTERVAL_MS` the processor call count is still 3. With `MAX_ATTEMPTS=1` the first failure ends `failed`, `attempts: 1`. | RF-05, D-12, D-15, PLAN G7 |
| CA-12 | Simulator with `PROCESSING_DELAY_MS=2000`, `PROCESSING_TIMEOUT_MS=200`, `LEASE_MS=5000`, `MAX_ATTEMPTS=1`. | The document ends `failed` with `lastError = { code: 'timeout', message: 'External call timed out after 200 ms', … }` within about 1 s of the claim. The signal passed to the processor was aborted. A spy shows the simulator settled by rejecting, and the document never became `done`. | RF-03, D-06, D-12 |
| CA-13 | Blocking processor. While blocked, directly `$inc` the document's `attempts` (a simulated reclaim). Release with success. Repeat with a failing release, and once more by changing `workerId` instead. | Each time, the document is deep-equal to its state after the manual change (not `done`, no `result`, no `lastError` from this attempt), and one `warn` reads `Stale write discarded for event <_id> (attempt 1)`. | RF-04, RF-05, D-03, PLAN P5, Phase 7 stale-worker |
| CA-14 | (a) A `failCommand` failpoint (or the fallback wrapper, see §5 assumptions) makes the success `update` fail with a retryable error enough times that the worker retries twice. (b) It makes it fail more often than 1 + 3 worker retries cover. | (a) The document ends `done`, the processor was called once, and there's no `warn`. (b) The document stays `processing` (attempt 1, lock fields present), exactly one `warn` matches `Write for event <_id> abandoned: Mongo\w*Error`, and a second event inserted afterwards is processed to `done`. A retry never starts after `lockedUntil` (asserted by a short `LEASE_MS` variant: no retry after expiry). | RF-06, D-07 |
| CA-15 | (a) A failpoint (or the fallback) makes `findAndModify` fail 3 times, then recover. (b) Mongo is stopped while the worker is idle. | (a) 3 `warn` lines `Claim failed: …`, then the due event is processed to `done`. (b) `warn` lines `Claim failed: Mongo…Error…` appear, `GET /health` still returns `200 { status: 'ok' }`, and no unhandled rejection is reported (a `process.on('unhandledRejection')` spy stays empty). | RF-02, D-13, RNF-04 |
| CA-16 | (a) Blocking processor with one attempt in flight and 3 more due events, `WORKER_CONCURRENCY=1`. Call `app.close()`, then release after 300 ms. (b) Idle worker, call `app.close()`. | (a) `close()` hasn't resolved before the release. After the release it resolves, the in-flight event is `done`, the 3 others are `pending` with `attempts: 0`, `Worker stopped` is logged, and no Mongo command from the worker follows it (command-monitor check). (b) `close()` resolves within `POLL_INTERVAL_MS` + 1 s. | RF-07, D-02 |
| CA-17 | `WORKER_ENABLED=false`. POST an event and wait 10 × `POLL_INTERVAL_MS`. | The document is still `pending`, `attempts: 0`. No `findAndModify` on `events` was sent (command monitor). The log contains `Worker disabled (WORKER_ENABLED=false)`. | RF-01, RF-08 |
| CA-18 | Unit: the backoff with `random` = 0 and 0.999999 for n = 1..8, base 1000, max 60000; base 0; base = max. | The delay is in [cap/2, cap) with cap = min(60000, 1000·2^(n−1)), so it hits the max from n = 7 on. Base 0 → 0. The result is an integer. | D-04, PLAN Phase 7 unit |
| CA-19 | Unit (fake timers): simulator with `FAILURE_RATE` 0 and 1, an injected random; abort before the delay ends. | Rate 0 → resolves `{ simulated: true }` only after `PROCESSING_DELAY_MS`. Rate 1 → rejects with the simulated-failure error only after the delay. Random exactly equal to the rate → success (fail iff random < rate). Abort → rejects at once. | D-06 |
| CA-20 | `CaptureLogger` during CA-03, CA-10, CA-11, CA-13 and CA-14. | Every worker line matches one D-10 pattern exactly. No line contains any posted `patientId`, `type`, `ts` or `data` value, any `idempotencyKey`, or any serialized `result`. Every stored `lastError.message` is one of the three D-12 strings. | RNF-03, D-10, D-12 |
| CA-21 | `docker compose config`. README config table. | The app service environment lists `WORKER_ENABLED`. The README has the D-16 row. | RF-08, D-16 |
| CA-22 | Run the existing suites with `WORKER_ENABLED=false` and their assertions unchanged. | All Phase 1 and Phase 2 unit and e2e tests pass. `GET /health` → `200 { status: 'ok' }`. | Preserve |

## 11. QA and evidence

All of the following are planned. None have run yet.

| Area/criteria | Setup and procedure | Expected result | Evidence |
| --- | --- | --- | --- |
| Build, lint, unit (CA-01, CA-02, CA-18, CA-19) | `npm run build`, `npm run lint`, `npm test` | Exit 0 | Command output |
| Happy path (CA-03, CA-04) | e2e: POST via supertest, poll the document, spy processor | `done` document shape, lease fields while processing | vitest e2e output + document snapshots |
| Claim selection and order (CA-05, CA-06) | e2e: direct `insertMany` with fixed `nextAttemptAt`/`lockedUntil`, concurrency 1 | Only due pending, ascending order | vitest output + deep-equal on untouched docs |
| Concurrency and parallelism (CA-07, CA-08) | e2e: blocking processor with an in-flight counter | Max 3; same-patient parallel | vitest output |
| No double claim (CA-09) | e2e: two `createTestApp` instances, one DB, 200 events | 200 calls, one per key | vitest output + per-key counts |
| Retry and final failure (CA-10, CA-11) | e2e: scripted processor, small backoff | Exact transitions and bounds | vitest output + document snapshots per attempt |
| Timeout (CA-12) | e2e: simulator, delay > timeout | `timeout` failure, signal aborted | vitest output |
| Fencing (CA-13) | e2e: manual `$inc`/`$set` during a blocked attempt | Document unchanged, stale `warn` | vitest output + `CaptureLogger` |
| Store errors (CA-14, CA-15) | e2e: failpoint or wrapper fallback (recorded); `mongo.stop()` | Retry, then abandon; claim survives | vitest output + logs + unhandled-rejection spy |
| Stop (CA-16) | e2e: `app.close()` with a blocked attempt; command monitor | Waits, then no further commands | vitest output + command log |
| Disabled (CA-17) | e2e: `WORKER_ENABLED=false`, command monitor | No `findAndModify` | vitest output |
| Privacy (CA-20) | `CaptureLogger` across the listed suites | Only D-10 lines, no payload | vitest output |
| Compose and README (CA-21) | `docker compose config`, read the README | Variable listed, row present | Command output / diff |
| Regression (CA-22) | `npm test`, `npm run test:e2e` | All pass | Command output |

- Scenarios that don't apply here:
  - Accepted/validation/malformed/oversized POSTs: unchanged, covered by the Phase 1 suites rerun in CA-22.
  - Authentication and authorization: none exist (Phase 1 D-08). The worker has no network surface.
  - Duplicate POSTs: unchanged (Phase 1). Duplicate *processing* is covered by CA-09 and CA-13.
  - Ordering: processing order is deliberately unordered across patients (PLAN G2). The claim order by `nextAttemptAt` is covered by CA-06, and same-patient parallelism by CA-08. Read order is Phase 2.
  - Replica-set failover: can't be reproduced on a one-member set. Its effect on the worker (retryable errors on writes and claims) is simulated by CA-14 and CA-15.
  - Crash mid-attempt and lease reclaim: Phase 4. CA-05 confirms expired leases are left untouched here.
  - Emitted events and metrics: none produced (PLAN G12).
- Manual QA (optional, planned): `docker compose up --build`, POST the README's curl example, wait about 6 s, then `docker compose exec mongo mongosh ingest --quiet --eval 'db.events.find({}, {status:1, attempts:1, result:1}).toArray()'` shows `done`, `attempts: 1`, `result: { simulated: true }`. `docker compose logs app` shows `Worker started: concurrency 100, workerId …`.
- Record: the environment (Node and MongoDB versions), whether CA-14 and CA-15 used the failpoint or the wrapper fallback with the failure counts, and the pass/fail/blocked status per CA in the implementation report.

## 12. Definition of done and delivery

- [ ] No blocking decisions or required placeholders remain.
- [ ] RF-01 to RF-08 implemented and CA-01 to CA-22 verified with actual results.
- [ ] Negative scenarios covered: retry, final failure, timeout, stale writes, store errors on claims and writes, stop while busy, disabled worker.
- [ ] Responsiveness, themes and accessibility: not applicable (no UI).
- [ ] Logs and stored errors comply with D-10, D-12 and RNF-03.
- [ ] `npm run build`, `npm run lint`, `npm test` and `npm run test:e2e` executed, with any limitations declared.
- [ ] Changes limited to scope. No dependency or lockfile changes. No change to indexes, `EventsService` or `EventDocument`.
- [ ] Delivery describes the final behaviour, the files, the tests and the Phase 4 follow-ups (reclaim, signal shutdown with a timeout).

Expected artifact: code, tests, a one-row README update and a one-line compose update in this repository.
External actions/publication: none. Commits only when the user requests them.

## 13. References and consistency review

- `PLAN.md`: Phase 3 (scope), §3 (claim query), P1/P2/P5/P6, G2 (no grouping by patient), G6 (idempotency key to the external call), G7 (failure rate, timeout, 5 attempts, backoff with jitter), G10 (concurrency 100), G12 (single process, deferred metrics), Phase 4 (reclaim and shutdown, deferred) and Phase 7 (test list).
- `.ai/.specs/events-ingest-path.md`: D-04 (write timeouts), D-08 (no auth), D-11 (store-unavailable classes), D-14 (logging rules).
- `.ai/.specs/events-data-model.md`: D-03 (`$unset`), D-04 (field presence rules), D-05 (`EventError`, privacy), CA-05 (claim index plan).
- `src/config/env.validation.ts`, `src/database/database.module.ts`, `src/database/database.tokens.ts`, `src/events/event.document.ts`, `src/events/events.service.ts`, `src/events/store-errors.ts`, `src/main.ts`, `src/app.module.ts`: the current config, lifecycle, model and error handling.
- `test/*.e2e-spec.ts`, `test/support/*.ts`, `vitest.config*.ts`, `package.json`: the test infrastructure, scripts and the assertions affected by a running worker.
- `docker-compose.yml`, `Dockerfile`, `README.md`: deployment and documented configuration.
- `AGENTS.md`: telemetry guidance (not applied).
- The interview answers of 2026-11-02: D-01/D-02 (scope and stop), D-03 (fencing), D-04 (equal jitter), D-06 (simulator), D-07 (write retry), D-08 (`WORKER_ENABLED`), D-10 (logging).

Consistency review: RF-01→CA-17; RF-02→CA-03–CA-09, CA-15; RF-03→CA-03, CA-12; RF-04→CA-03, CA-04, CA-13; RF-05→CA-10, CA-11, CA-13; RF-06→CA-14; RF-07→CA-16; RF-08→CA-02, CA-17, CA-21; D-04→CA-10, CA-18; D-06→CA-12, CA-19; D-10/D-12/RNF-03→CA-20; Preserve→CA-22. D-01's limit (no reclaim) is asserted by CA-05. D-02's unbounded wait is stated as a Phase 3 limit that Phase 4 removes. The simulator is explicitly a simulation (`result.simulated: true`). Section 2 lists observed facts, section 5 the decisions and assumptions, and section 11 the planned, not executed, QA.
