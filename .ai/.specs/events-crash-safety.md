# Events crash safety — events held by a crashed or stopped worker are reclaimed after their lease expires, and SIGTERM drains in-flight work within a bounded time

## 1. Status and reading contract

- Status: implemented and verified.
- Updated: 2026-11-02.
- Assessment: [`.ai/.assessments/events-crash-safety.md`](../.assessments/events-crash-safety.md) (PASS, 2026-11-02).
- Decision owner: repository owner (decisions recorded from the create-spec interview of 2026-11-02).
- Affected areas/routes: `src/worker/events-worker.ts` (claim, reclaim guard, bounded stop, dispatcher wake fix), `src/main.ts` (`enableShutdownHooks`), the Phase 3 e2e test `test/worker.e2e-spec.ts` (CA-05 assertion for the expired lease), and new unit and e2e tests, including a child-process e2e suite. No HTTP route, index, environment variable, data-model type or compose setting is added or changed.
- Audience: operators and evaluators who need the PLAN P4/P6 promises to hold when processes are killed or restarted: no event stays stuck, none is completed twice, and a deploy (SIGTERM) doesn't throw away work in progress. Phase 5 (`/stats`) and Phase 6 (chaos and verification scripts) build on this.
- Deliverable type: integrated backend change. No frontend.
- Related or superseded document: `PLAN.md` Phase 4, §3 (claim query, expired-lease branch), P4, P6, G7. It builds on `.ai/.specs/events-worker.md` (Phase 3). It **supersedes** Phase 3 D-01 (pending-only claim), D-02 (unbounded stop wait) and the Phase 3 CA-05 expectation that an expired `processing` event is left untouched. It also closes the open Phase 3 assessment finding F-01 (D-13) without changing D-13's wording.
- Convention: `RF-xx` for functional requirements; `RNF-xx` for quality requirements; `D-xx` for decisions; `CA-xx` for acceptance criteria. Phase 3 identifiers are prefixed `worker` (for example worker D-03).

This spec describes the desired state. Nothing in it has been implemented or verified yet. All requirements are mandatory unless explicitly marked optional.

## 2. Context and problem

The Phase 3 worker claims only `pending` events. An event whose process dies during an attempt (SIGKILL, OOM, container restart), or whose outcome write was abandoned (worker D-07), stays `processing` with an expired `lockedUntil` forever. That breaks PLAN P4 ("never lost"). `main.ts` never enables shutdown hooks, so a SIGTERM from `docker compose stop` or a deploy kills the process without the worker's stop logic running. When the stop does run (on `app.close()`), it waits with no time limit, even though `SHUTDOWN_TIMEOUT_MS` exists for exactly this.

### Evidence and current state

| Verifiable reference | Observed fact | Implication |
| --- | --- | --- |
| `src/worker/events-worker.ts` `claim()` | `findOneAndUpdate({ status: 'pending', nextAttemptAt: { $lte: now } }, { $set: { status: 'processing', workerId, lockedUntil }, $inc: { attempts: 1 } }, { sort: { nextAttemptAt: 1 }, returnDocument: 'after', writeConcern })`. | Extend with the expired-lease branch (D-01). Switch to `returnDocument: 'before'` to detect reclaims (D-04). |
| `src/worker/events-worker.ts` `recordOutcome()` | Fenced filter `{ _id, status: 'processing', workerId, attempts }`. The retry guard reads `claimed.lockedUntil`. | Fencing already makes reclaim safe (a stale attempt can't complete). The guard must read the `lockedUntil` the worker computed itself once the claim returns the pre-update document (D-04). |
| `src/worker/events-worker.ts` `stop()` / `waitForWake()` / `start()` | `stop()` waits for the loop and every in-flight attempt with no limit. A single `wake` callback serves both the pool-full wait and the poll wait, and `start()` calls it when any attempt settles. | Add the `SHUTDOWN_TIMEOUT_MS` bound (D-05). Split the wakes (D-07, F-01). |
| `.ai/.assessments/events-worker.md` F-01 | Overall FAIL on D-13: a freed slot cuts short the `POLL_INTERVAL_MS` wait (reproduced: next claim at about 102 ms instead of about 1001 ms). | Fixed here with a regression test (D-07, CA-12). |
| `src/main.ts` | `NestFactory.create` → `configureApp` → `listen`. No `enableShutdownHooks`. | Add `app.enableShutdownHooks(['SIGTERM', 'SIGINT'])` (D-06). |
| `src/database/database.module.ts` | `onApplicationShutdown` closes the Mongo client. The claim index `claim_status_nextAttemptAt` on `{ status: 1, nextAttemptAt: 1 }`. | The worker's `beforeApplicationShutdown` runs first, so the client is still open while it drains. The `$or` claim can use the existing index for both branches (assumption, CA-11). |
| `src/config/env.validation.ts` | `SHUTDOWN_TIMEOUT_MS` integer ≥ 0, default 20000, unused. `LEASE_MS > PROCESSING_TIMEOUT_MS` is enforced. | Use it. There are no new settings. |
| `docker-compose.yml` | `init: true` (tini as PID 1), `stop_grace_period: 30s`, with a comment saying it is longer than `SHUTDOWN_TIMEOUT_MS`. | No compose change. 30 s covers 20 s of drain plus the client close. |
| `README.md` config table | `LEASE_MS`: "…before others may reclaim it". `SHUTDOWN_TIMEOUT_MS`: "How long shutdown waits for in-flight events". | It already describes the Phase 4 behaviour. No README change (PLAN Phase 8 owns the architecture docs). |
| `test/worker.e2e-spec.ts` CA-05 (lines 186–230) | Seeds a `processing` event with `lockedUntil` 60 s in the past and asserts it is unchanged. | That expectation is superseded. The test must be updated (D-01, CA-14). |
| `test/support/worker.ts`, `app.ts`, `mongo.ts`, `capture-logger.ts` | `workerEnv`, `workerConfigure` (processor override and command sink), `BlockingProcessor`, `ScriptedProcessor`, `SpyProcessor`, `seedEvent`, `waitFor`, `workerLines`, `D10_PATTERNS`, `startMongo` (one-member 7.0.45 replica set). | Reuse them. `D10_PATTERNS` gains the D-08 lines. |
| `package.json` | `build` = `nest build` (output `dist/main.js`), `test:e2e` = vitest with `vitest.config.e2e.ts`. No new dependencies are needed. | The child-process suite builds once and spawns `node dist/main.js` (D-09). |
| `AGENTS.md` | Optional NestJS Observe telemetry. `ObserveModule` not registered. | Not applied (PLAN G12 defers metrics). |

Missing: the expired-lease claim branch, the attempt-limit guard for reclaimed events, signal-driven shutdown, the bounded drain, and the F-01 fix.

## 3. Objective and expected outcome

- Product outcome: an event held by an attempt that never finished (process killed, write abandoned, process stopped by the drain timeout) is claimed again by any worker once `lockedUntil` has passed, and completes exactly once in the store. An event lost on its final allowed attempt ends visibly as `failed` (`lease_expired`) instead of looping forever. SIGTERM or SIGINT makes the process stop claiming, finish in-flight attempts for up to `SHUTDOWN_TIMEOUT_MS`, close Mongo and exit. Attempts still running at the deadline are aborted and left for lease reclaim.
- Verifiable success signal: e2e tests against the in-memory 7.0.45 replica set for reclaim, the attempt-limit guard, fencing after reclaim, the bounded drain and the F-01 regression, plus a child-process e2e suite that sends real SIGTERM and SIGKILL to `node dist/main.js` (section 11).
- Limits of the claim: recovery after a crash takes up to `LEASE_MS` (30 s by default) plus a poll interval. Reclaim is driven by the app clock, so clock skew between replicas shifts when a lease counts as expired (accepted, worker assumptions). A reclaimed attempt may repeat an external call that already took effect. That is at-least-once, covered by the idempotency key (PLAN G6). Throughput under chaos is measured in Phase 6, not here.

## 4. Scope

### Included

- The expired-lease branch in the claim, with reclaim detection and a log line (RF-01, RF-02).
- The attempt-limit guard for reclaimed events (`lease_expired`) (RF-03).
- `enableShutdownHooks` for SIGTERM and SIGINT (RF-04).
- The bounded stop: drain up to `SHUTDOWN_TIMEOUT_MS`, then abort and leave events for reclaim (RF-05).
- The F-01 fix: separate wakes for the pool-full wait and the poll wait (RF-06).
- The new log lines in D-08 and nothing else.
- Unit and e2e tests for every scenario in section 11, including the child-process suite. The Phase 3 CA-05 test is updated to the new expectation.

### Out of scope

- `GET /stats`, the Mongo check in `GET /health`, and any readiness signal during drain: Phase 5.
- Load, chaos and verification scripts: Phase 6.
- Releasing held events back to `pending` on shutdown, or recording a `shutdown` failure (rejected in the interview, D-05).
- Recording `lastError` on every reclaim (rejected, D-04). `lastError` changes only when the guard fails an event.
- Stopping the HTTP server before the drain, or rejecting `POST /events` while draining (D-10).
- New settings, indexes, `EventDocument` fields, compose or Dockerfile changes, README changes.
- Retrying `failed` events, per-patient serialization, separate API/worker roles, metrics (PLAN "with more time").

### Preserve

- The `POST /events` contract, the insert and its logging (Phase 1). The indexes and startup semantics (Phase 2).
- Worker D-03 (fenced outcome writes), D-04 (backoff), D-05/D-06 (processor contract and simulator), D-07 (outcome-write retry, bounded by the lease), D-08 (`WORKER_ENABLED`), D-09 (`workerId`), D-10 log lines (all kept verbatim; D-08 here only adds lines), D-11 (write concern), D-12 (existing `lastError` codes), D-13 (dispatcher contract, now honoured), D-14, D-15 (final failure on processor failure at `attempts ≥ MAX_ATTEMPTS`, unchanged for non-reclaimed claims).
- Worker CA-16(a)/(b): `app.close()` still waits for an attempt that finishes within `SHUTDOWN_TIMEOUT_MS`, and an idle close is prompt.
- `EventDocument` presence rules (data-model D-03, D-04, D-05).
- Every existing environment variable, default and cross-field rule. `GET /health` → `200 { status: 'ok' }`.
- Every existing test assertion except Phase 3 CA-05's expired-lease expectation (D-01).

## 5. Decisions, assumptions, and questions

### Adopted decisions

| ID | Concrete decision | Rationale and impact |
| --- | --- | --- |
| D-01 | The claim filter becomes `{ $or: [ { status: 'pending', nextAttemptAt: { $lte: now } }, { status: 'processing', lockedUntil: { $lt: now } } ] }`, with the same update, the same `sort: { nextAttemptAt: 1 }` and the same write concern. No separate sweeper and no new index. | Chosen in the interview. Follows PLAN §3. One atomic operation, so a reclaimed event can't be taken by two workers. An expired event's `nextAttemptAt` is at or before its earlier claim, so it sorts ahead of most due work. Supersedes worker D-01 and the Phase 3 CA-05 expectation for expired leases. |
| D-02 | A reclaim counts as an attempt. The claim's `$inc: { attempts: 1 }` is unchanged, and the lost attempt is charged. | Chosen in the interview. Bounds the total work spent on an event that keeps killing its process. |
| D-03 | Attempt-limit guard: if a claim is a **reclaim** (D-04) and the new `attempts > MAX_ATTEMPTS`, the worker doesn't call the processor. It writes, with the worker D-03 fenced filter, `$set: { status: 'failed', processedAt: now, lastError: { code: 'lease_expired', message: 'Lease expired before the attempt completed', at: now } }, $unset: { workerId: '', lockedUntil: '' }`, and the worker D-07 retry rules apply. A non-reclaim claim keeps worker D-15 behaviour, even when `attempts > MAX_ATTEMPTS` (a lowered `MAX_ATTEMPTS`). | Chosen in the interview. The processor runs at most `MAX_ATTEMPTS` times per event, and a poison event ends visibly as `failed`. Stored `attempts` is then `MAX_ATTEMPTS + 1`: it counts claims, not processor calls. The message contains no payload (data-model D-05). |
| D-04 | Reclaim detection: the claim uses `returnDocument: 'before'`. A returned document with `status: 'processing'` is a reclaim. The worker derives the attempt's values itself: `attempts = before.attempts + 1`, `lockedUntil = now + LEASE_MS` (the value it sent), and `workerId` = its own. Every later use (fencing, the D-07 lease guard, logs, the guard in D-03) uses these derived values. On a reclaim it logs `warn` `Reclaimed event <_id> after lease expiry (attempt <attempts>)`. `lastError` is not touched by a reclaim. | Chosen in the interview (warn log only). The claim stays a plain update, and operators and the Phase 6 chaos run can see recovery happen. |
| D-05 | Bounded stop. `beforeApplicationShutdown` stops claiming and waits for in-flight attempts up to `SHUTDOWN_TIMEOUT_MS`, measured from the start of the hook. When the deadline passes with attempts still in flight, the worker: (1) logs `warn` `Shutdown timeout after <SHUTDOWN_TIMEOUT_MS> ms: <n> attempts left for lease reclaim`; (2) aborts every in-flight processor signal; (3) makes every unfinished attempt skip its outcome write and cancels any pending worker D-07 retry wait, so no new outcome write is sent; (4) logs `Worker stopped` and resolves. A write already sent may still complete; its result is ignored. Those events stay `processing` and are reclaimed after `lockedUntil`. With `SHUTDOWN_TIMEOUT_MS=0` the deadline is immediate. The same bound applies to `app.close()` without a signal. | Chosen in the interview. Adds no new write path that could race the client close. The cost is up to `LEASE_MS` of delay for the events left behind. Supersedes worker D-02's unbounded wait. With defaults (5 s call, 10 s timeout, ≤ 3 s of write retries), the timeout only fires when something hangs. |
| D-06 | `main.ts` calls `app.enableShutdownHooks(['SIGTERM', 'SIGINT'])` before `listen`. Other signals keep Node's default behaviour. | Low-risk. SIGTERM is what Compose and orchestrators send, and SIGINT is Ctrl-C locally. Listening to every Nest default signal (SIGHUP, SIGUSR2…) would change unrelated behaviour. |
| D-07 | F-01 fix. The dispatcher uses two separate wake mechanisms: the **slot wake** (fired when an attempt settles) ends only the wait taken because the pool is full; the **stop wake** ends any wait. The `POLL_INTERVAL_MS` wait after an empty or failed claim ends only on its timer or on stop. | Chosen in the interview. Restores worker D-13 as written: one idle claim per `POLL_INTERVAL_MS`, and no faster retries during an outage. |
| D-08 | New log lines (context `EventsWorker`), exactly: `warn` `Reclaimed event <_id> after lease expiry (attempt <attempts>)`; `log` `Worker stopping: <n> attempts in flight`; `warn` `Shutdown timeout after <ms> ms: <n> attempts left for lease reclaim`. The existing `warn` `Event <_id> failed after <attempts> attempts (<code>)` is also used with `lease_expired`. All worker D-10 lines are unchanged. `Worker stopping` is logged once at the start of a stop when the worker is enabled. The privacy prohibitions of worker D-10 apply unchanged. | Low-risk. Gives the child-process tests and the Phase 6 chaos run fixed markers, and contains only `_id`, counts and fixed text. |
| D-09 | Real-signal verification uses a child-process e2e suite: `beforeAll` runs `npm run build` once, then each test spawns `node dist/main.js` with explicit env (`MONGO_URI` from `startMongo`, small timings, `PORT` free, `NO_COLOR=1`) and reads stdout/stderr. The suite covers SIGTERM drain, SIGTERM with the timeout path, SIGKILL mid-attempt followed by reclaim in a second process, and POST during drain. It uses the real simulator (no provider override). | Chosen in the interview. It is the only automated evidence that the signal wiring, the hook order and the process exit work together. Makes `npm run test:e2e` slower by one build. |
| D-10 | During the drain the HTTP server keeps serving: `POST /events` still stores events (they stay `pending` and are picked up by another process or after restart). After the worker's hook resolves, `DatabaseModule` closes the client, and requests in the short window before Nest closes the HTTP server get the existing `503` (store unavailable), which is safe to retry. | Observed Nest order (`beforeApplicationShutdown` → `onApplicationShutdown` → HTTP close). Preserving it keeps accepting work during a deploy. Refusing it would be an API change and is out of scope. |
| D-11 | After a stop resolves (with or without a timeout), the worker sends no new Mongo commands: no claims, no outcome writes, no write retries. | Strengthens worker RF-07 for the timeout path. The client closes immediately afterwards. |

### Assumptions to verify

| Assumption | Available evidence | Confirmation / effect if false |
| --- | --- | --- |
| On MongoDB 7.0.45 the `$or` claim sorted by `nextAttemptAt` uses `claim_status_nextAttemptAt` for both branches with no blocking `SORT` stage (for example `SORT_MERGE` over two `IXSCAN`s). | Planner behaviour for `$or` + sort when each branch's index gives the sort order. Unconfirmed here. | CA-11 checks `explain`. If a blocking `SORT` appears, implementation stops and reports back. The spec is then revised (for example with a hint or a second index) and not silently changed. |
| Nest 12 `enableShutdownHooks` removes its signal listeners on the first signal, awaits `app.close()`, then re-sends the signal to the process, so the process ends by that signal, and a second signal during the drain kills it at once. | Nest source behaviour in earlier majors. Not yet checked against 12. | CA-07 asserts the child's exit (`signal === 'SIGTERM'` or `code === 143`). If Nest 12 exits differently, record the observed exit and adjust CA-07's expectation without changing the drain behaviour. The second-signal behaviour is noted, not tested. |
| `node dist/main.js` started from the repo root with `MONGO_URI` pointing at the in-memory replica set behaves like the Docker image (same build output). | Dockerfile runs `node dist/main.js` from `npm run build`. | If the build or module resolution differs, record it and fix the test harness. The service code must not change for it. |
| The replica-set URI from `mongodb-memory-server` is reachable from a child process on the same host. | It listens on 127.0.0.1. | Otherwise the child-process suite is blocked, and that must be reported. |

### Open questions

None blocking. Non-blocking follow-ups: Phase 5 may expose reclaim counts or a draining state in `/stats` or `/health`; Phase 6 measures recovery time and claim contention under chaos.

## 6. User journey and states

### Preconditions and entry

- The app is initialized against a MongoDB replica set and `WORKER_ENABLED=true`. There is no HTTP surface or authentication change.
- An event can be left `processing` with an expired `lockedUntil` by: a process killed mid-attempt; a worker D-07 abandoned write; a stop that hit `SHUTDOWN_TIMEOUT_MS`; or a stale worker paused past its lease.

### Main flow — reclaim

1. A worker's claim finds an expired `processing` event (`lockedUntil < now`). Its `nextAttemptAt` is old, so it sorts early.
2. The claim atomically sets `status: 'processing'`, the new `workerId`, `lockedUntil = now + LEASE_MS`, and `attempts + 1`, and returns the pre-update document (`status: 'processing'`).
3. The worker logs `Reclaimed event <_id> after lease expiry (attempt <n>)`.
4. If `n ≤ MAX_ATTEMPTS`: the attempt runs exactly like any other (processor call, fenced outcome, backoff or final failure).
5. If `n > MAX_ATTEMPTS`: no processor call. A fenced write sets `failed` with `lastError.code = 'lease_expired'`, and `warn` `Event <_id> failed after <n> attempts (lease_expired)` is logged.
6. Any late outcome write from the original holder matches nothing (worker D-03) and logs `Stale write discarded…`.

### Main flow — shutdown

1. SIGTERM or SIGINT (or `app.close()`): the worker logs `Worker stopping: <n> attempts in flight`, stops claiming and cancels its idle wait.
2. In-flight attempts finish and write their outcomes. When the last one settles, `Worker stopped` is logged and the hook resolves.
3. `DatabaseModule` closes the client, Nest closes the HTTP server, and the process exits by the signal.

### Alternatives and exceptions

- Drain deadline reached: timeout `warn`, abort signals, skip remaining outcome writes, `Worker stopped`, resolve. Those events are reclaimed after their lease (CA-08, CA-09).
- SIGKILL or a crash: nothing runs. Events in flight are reclaimed by any worker after `lockedUntil` (CA-10).
- Stale holder writes after a reclaim: discarded by fencing (CA-04).
- Two workers race for the same expired event: only one claim matches (CA-05).
- `MAX_ATTEMPTS` lowered between runs, non-reclaimed event: worker D-15 is unchanged (CA-03 c).
- Store error on the `lease_expired` write: worker D-07 retries, otherwise abandoned and reclaimed again later. The event is then reclaimed with an even higher `attempts`, and the guard fails it again (CA-03 d).
- Worker disabled: stop resolves at once and logs nothing new (worker RF-07 unchanged; CA-13).
- POST during drain: `202`, the event is stored `pending` (CA-07).

| State (event) | Trigger | Observable document | Exit condition |
| --- | --- | --- | --- |
| `processing`, lease valid | Claim or reclaim | `workerId`, `lockedUntil > now` | Fenced outcome write |
| `processing`, lease expired | Holder died, abandoned its write, or was stopped at the deadline | `lockedUntil < now` | Reclaimed by the next claim |
| `failed` (`lease_expired`) | Reclaim with `attempts > MAX_ATTEMPTS` | `attempts = MAX_ATTEMPTS + 1` (or more), `lastError.code = 'lease_expired'`, `processedAt`, no lock fields, no `result` | — (terminal) |
| `pending` / `done` / `failed` (other) | Unchanged from Phase 3 | Unchanged | Unchanged |

| State (worker) | Trigger | Behaviour | Exit condition |
| --- | --- | --- | --- |
| Running | Bootstrap | Claims due pending and expired processing events | Signal or `app.close()` |
| Draining | `beforeApplicationShutdown` | `Worker stopping` logged. No new claims. In-flight attempts finish and write | All settled → Stopped; or deadline → Timed out |
| Timed out | `SHUTDOWN_TIMEOUT_MS` elapsed | Timeout `warn`. Signals aborted. No further writes | Immediately → Stopped |
| Stopped | Drain complete | `Worker stopped`. No new Mongo commands from the worker | Client closed, process exits |

## 7. Functional requirements and contracts

### RF-01 — Claim with the expired-lease branch

- Trigger: the dispatcher has a free slot and isn't stopping.
- Rules: `findOneAndUpdate(<D-01 filter>, { $set: { status: 'processing', workerId, lockedUntil: now + LEASE_MS }, $inc: { attempts: 1 } }, { sort: { nextAttemptAt: 1 }, returnDocument: 'before', writeConcern: { w: 'majority', wtimeoutMS: 5000 } })`. `now` is read once per claim.
- Output: `null` → poll wait (RF-06). A document → derive the attempt values (D-04) and start an attempt, or apply the guard (RF-03).
- Exceptions: unchanged from worker RF-02 (`Claim failed` warn, poll wait).
- Side effects: `done`, `failed`, future `pending`, and `processing` with `lockedUntil ≥ now` are never touched.

### RF-02 — Reclaim detection and logging

- Trigger: the claim returned a document whose pre-update `status` is `processing`.
- Rules: log `warn` `Reclaimed event <_id> after lease expiry (attempt <attempts>)` with the derived `attempts`, then continue with RF-03.
- Output: one line per reclaim. A claim of a `pending` event logs nothing.

### RF-03 — Attempt-limit guard

- Trigger: a reclaim with derived `attempts > MAX_ATTEMPTS`.
- Rules: per D-03. The processor is not called. The write uses the fenced filter `{ _id, status: 'processing', workerId, attempts }` and the worker D-11 write concern. On matched 1 → `warn` `Event <_id> failed after <attempts> attempts (lease_expired)`. Matched 0 → `Stale write discarded…`. Errors → worker RF-06 retry/abandon, with the lease guard using the derived `lockedUntil`.
- Output: the slot is released when the write settles.
- Exceptions: a reclaim with `attempts ≤ MAX_ATTEMPTS` runs a normal attempt. A non-reclaim claim never takes this path.

### RF-04 — Shutdown signals

- Trigger: the process receives SIGTERM or SIGINT.
- Rules: `app.enableShutdownHooks(['SIGTERM', 'SIGINT'])` in `main.ts`, so Nest runs `app.close()` (worker `beforeApplicationShutdown` → `DatabaseModule.onApplicationShutdown` → HTTP close), then terminates the process.
- Output: the process exits after the drain (CA-06, CA-07).

### RF-05 — Bounded stop

- Trigger: `beforeApplicationShutdown` (signal or `app.close()`), worker enabled.
- Rules: per D-05 and D-11. Log `Worker stopping: <n> attempts in flight` (`n` = attempts in flight at that moment). Stop claiming and cancel the idle wait (a claim already sent may finish; if it returns an event, that attempt is in flight and bounded by the deadline too). Wait for in-flight attempts until `SHUTDOWN_TIMEOUT_MS` after the hook started. On the deadline: the timeout `warn` with the number of unfinished attempts, abort their signals, mark them so they skip the outcome write and any D-07 retry, log `Worker stopped`, and resolve. Without a deadline hit: log `Worker stopped` and resolve once all attempts have settled. Calling the hook twice returns the same promise.
- Output: the hook resolves no later than about `SHUTDOWN_TIMEOUT_MS` + the duration of an already-sent claim.
- Exceptions: disabled worker → resolves at once, no log lines.
- Side effects: on timeout, no outcome write for unfinished attempts; their events stay `processing` with the lease set.

### RF-06 — Dispatcher wakes (F-01)

- Trigger: an attempt settles, or stop begins.
- Rules: per D-07. A settled attempt wakes the dispatcher only if it is waiting because `inFlight ≥ WORKER_CONCURRENCY`. Stop wakes any wait. After an empty or failed claim, the next claim is sent no earlier than `POLL_INTERVAL_MS` later unless stop began.
- Output: one claim per `POLL_INTERVAL_MS` while idle, whatever the attempt completions.

### Data and validation

| Field | Type, label, and initial value | Normalization | Rules and limits | Exact message |
| --- | --- | --- | --- | --- |
| `lastError.code` | string | — | adds `lease_expired` to the worker D-12 codes | — |
| `lastError.message` | string | — | for `lease_expired`: fixed text | `Lease expired before the attempt completed` |
| `SHUTDOWN_TIMEOUT_MS` | existing env integer ≥ 0, default 20000 | unchanged | unchanged | unchanged |

- Validation timing: unchanged (config at startup).
- Source of truth: `EventDocument` (`code` is a free string; no type change), `EnvironmentVariables`.

### Integrations

| Operation | Confirmed contract | Success | Failures and recovery |
| --- | --- | --- | --- |
| Claim (`findOneAndUpdate`, `$or`) | RF-01, served by `claim_status_nextAttemptAt` (CA-11) | Pre-update document | `Claim failed` warn + poll wait |
| `lease_expired` write (`updateOne`) | RF-03, fenced, worker D-11 write concern | matched 1 | 0 → stale warn. Error → worker RF-06 |
| Shutdown hooks | Nest `enableShutdownHooks(['SIGTERM','SIGINT'])` | Hooks run in order, then the process exits | Second signal during drain → immediate termination (assumption) |
| External call (simulated) | Unchanged (worker D-05/D-06). Aborted on drain timeout | — | A repeated call after reclaim carries the same `idempotencyKey` (PLAN G6) |

### Content and actions

Not applicable: no UI and no HTTP contract changes.

## 8. Non-functional requirements

### RNF-01 — Visual design, responsiveness, and themes

Not applicable: backend only, no user interface.

### RNF-02 — Accessibility

Not applicable: no user interface.

### RNF-03 — Privacy and security

- Sensitive data: unchanged flow. Clinical fields go only from Mongo to the in-process processor.
- Persistence: the worker writes only status, lock fields, `attempts` (via the claim), `nextAttemptAt`, `result`, `lastError` and `processedAt`. The new `lease_expired` message is fixed text.
- Logs: the D-08 lines contain only `_id`, attempt numbers, counts, milliseconds and fixed text. Payload fields, `idempotencyKey`, `result` and raw error messages stay prohibited (worker D-10). The child-process suite must check stdout and stderr for the posted fictional values (CA-13).
- Trust boundary: unchanged. The signal handlers add no network surface.

### RNF-04 — Quality, performance, and compatibility

- Environment: Node 24, MongoDB 7.0 replica set (Compose and `mongodb-memory-server` 7.0.45).
- Performance: no numeric target. Structural properties: the claim stays a single indexed operation with no blocking sort (CA-11), and one idle claim per `POLL_INTERVAL_MS` (CA-12). Recovery delay after a crash is at most `LEASE_MS` + `POLL_INTERVAL_MS` + one claim, by construction.
- Reliability: reclaim is atomic (CA-05), stale holders are fenced (CA-04), processor calls are bounded at `MAX_ATTEMPTS` per event even across crashes (CA-03), the drain is bounded (CA-08), and no worker command follows the stop (CA-09).
- Dependencies: none added. The child-process suite uses `node:child_process` only.
- Code style: ESM `.js` import suffixes, Prettier and oxlint as configured, comment density matching `events-worker.ts`, and constants for fixed texts.

## 9. Technical guidelines and impact

- Applicable instructions: `AGENTS.md` (Observe telemetry not in scope). There is no `CLAUDE.md`.
- Observed stack: NestJS 12, `mongodb` ^7.8.0, TypeScript 6, vitest 4, `mongodb-memory-server` ^11.3.0 (MongoDB 7.0.45), ESM, Node 24.
- New dependencies: none.
- Architecture: all worker behaviour stays in `EventsWorker`. `main.ts` only gains the shutdown-hook call. `DatabaseModule` keeps sole ownership of the client lifecycle.
- Reuse: the existing fenced write and retry path (`recordOutcome`) for the `lease_expired` write. `describeError`. The test helpers in `test/support/`.
- Constraints: no new settings, indexes, model fields or dependencies. No change to `EventsService`, `DatabaseModule`, `docker-compose.yml`, `Dockerfile` or `README.md`.

| File/area | Current state | Expected change | Risk/regression |
| --- | --- | --- | --- |
| `src/worker/events-worker.ts` | Pending-only claim, `returnDocument: 'after'`, unbounded stop, shared wake | RF-01–RF-03, RF-05, RF-06 | Fencing and D-07 must use the derived values (D-04). Phase 3 tests must still pass |
| `src/main.ts` | No shutdown hooks | `enableShutdownHooks(['SIGTERM','SIGINT'])` (RF-04) | Signals now terminate the process after the drain instead of at once |
| `test/worker.e2e-spec.ts` CA-05 | Expects the expired `processing` event unchanged | Expect it reclaimed (`done`, `attempts: 2`); the other four documents still unchanged | Only this assertion changes |
| `test/support/worker.ts` | `D10_PATTERNS`, `D12_MESSAGES` | Add the D-08 patterns and the `lease_expired` message | Shared by all worker suites |
| `test/worker-reclaim.e2e-spec.ts` (suggested) | Absent | CA-02–CA-05, CA-11 | Use short leases |
| `test/worker-shutdown.e2e-spec.ts` (suggested; may be split per env) | Absent | CA-08, CA-09, CA-12 | Timing tolerances |
| `test/process-signals.e2e-spec.ts` (suggested) | Absent | CA-06, CA-07, CA-10, CA-13 (process part) | Needs `npm run build`; free ports; kills children in `afterEach` |
| `src/worker/*.spec.ts` (optional) | — | A unit test for the wake split, if simpler than e2e | — |

## 10. Traceable acceptance criteria

The e2e criteria run against the in-memory 7.0.45 replica set with small timings (for example `POLL_INTERVAL_MS=50`, `PROCESSING_DELAY_MS=50`, `PROCESSING_TIMEOUT_MS=500`, `LEASE_MS=1000`) unless stated otherwise. The patient ids and payloads are fictional.

| ID | Given / when | Then, observable | Requirement |
| --- | --- | --- | --- |
| CA-01 | `npm run build`, `npm run lint`, `npm test`, `npm run test:e2e`. | All exit 0. Every Phase 1–3 suite passes, with only the Phase 3 CA-05 expired-lease assertion changed. | RNF-04, Preserve |
| CA-02 | Seed a `processing` event, `attempts: 1`, `workerId: 'dead:1:aaaaaaaa'`, `lockedUntil` 1 s in the past, `MAX_ATTEMPTS=5`. Boot with a spy processor that succeeds. | The event ends `done`, `attempts: 2`, `result` set, lock fields absent. The processor got the stored `idempotencyKey` once. Exactly one `warn` reads `Reclaimed event <_id> after lease expiry (attempt 2)`. A `processing` event with `lockedUntil` 1 h ahead is unchanged after 10 × `POLL_INTERVAL_MS`. | RF-01, RF-02, D-01, D-02, D-04 |
| CA-03 | `MAX_ATTEMPTS=3`. (a) Seed `processing`, `attempts: 3`, expired lease. (b) Seed `processing`, `attempts: 2`, expired lease, and a processor that always fails. (c) Seed `pending`, `attempts: 5`, due, and a processor that succeeds. (d) As (a), with a failpoint (or the worker fallback wrapper) making the `lease_expired` `update` fail more times than the D-07 retries cover, then turned off. | (a) No processor call. The document is `failed`, `attempts: 4`, `processedAt` set, `lastError = { code: 'lease_expired', message: 'Lease expired before the attempt completed', at }`, no `result`/`workerId`/`lockedUntil`. Logs: the reclaim `warn`, then `Event <_id> failed after 4 attempts (lease_expired)`. (b) One processor call (attempt 3), then `failed` with `processor_error` (worker D-15), no `lease_expired`. (c) Processed normally to `done`, `attempts: 6` (the guard is reclaim-only). (d) A `Write for event <_id> abandoned` warn. After the lease expires and the failpoint is off, the event is reclaimed again and ends `failed` (`lease_expired`, `attempts: 5`), with zero processor calls overall. | RF-03, D-03 |
| CA-04 | Instance A (blocking processor, default lease) claims an event. While A is blocked, the test sets the document's `lockedUntil` 1 s in the past (simulating a holder paused past its lease). Instance B (spy, succeeds) reclaims and completes it. Then A's processor is released with success. | The document ends `done`, `attempts: 2`, and A doesn't change it afterwards (deep-equal before and after A's release). B logs the reclaim `warn` (attempt 2). A logs `Stale write discarded for event <_id> (attempt 1)`. B's spy was called once. | RF-01, worker D-03, PLAN P5 |
| CA-05 | Two instances, `WORKER_CONCURRENCY=10` each, 100 seeded `processing` events with expired leases and distinct keys, a spy processor that succeeds. | All 100 end `done`, `attempts: 2`. Across both spies each `idempotencyKey` was seen exactly once. There are exactly 100 `Reclaimed event` lines in total. | RF-01, D-01 |
| CA-06 | Child process (`node dist/main.js`), `PROCESSING_DELAY_MS=1500`, `PROCESSING_TIMEOUT_MS=3000`, `LEASE_MS=5000`, `SHUTDOWN_TIMEOUT_MS=10000`, `FAILURE_RATE=0`. POST 3 events, wait until all 3 are `processing`, send SIGTERM. | stdout contains `Worker stopping: 3 attempts in flight`, then `Worker stopped`, with no `Shutdown timeout` line. The process exits by SIGTERM (`signal === 'SIGTERM'` or `code === 143`) within 10 s. All 3 documents are `done`, `attempts: 1`. | RF-04, RF-05, D-06, PLAN P6 |
| CA-07 | As CA-06, but POST a fourth event (new content) while the drain is in progress. | The POST returns `202` with `duplicate: false`. That event is `pending`, `attempts: 0` after the process exits (no claims after `Worker stopping`). | D-10, RF-05 |
| CA-08 | In-process: `SHUTDOWN_TIMEOUT_MS=300`, `PROCESSING_TIMEOUT_MS=4000`, `LEASE_MS=5000`, a blocking processor (never released), 2 attempts in flight. Call `app.close()`. | `close()` resolves within 300 ms + 1 s. Logs, in order: `Worker stopping: 2 attempts in flight`, `Shutdown timeout after 300 ms: 2 attempts left for lease reclaim`, `Worker stopped`. Both processor signals are aborted. Both documents are still `processing`, `attempts: 1`, with their original `lockedUntil`. Booting a new instance after `lockedUntil` reclaims both to `done`, `attempts: 2`. | RF-05, D-05 |
| CA-09 | As CA-08, plus a command monitor. Also a variant where the blocked attempt is already in its D-07 retry wait (failpoint on `update`) when the deadline passes. | Checked after waiting `PROCESSING_TIMEOUT_MS` + 500 ms past `close()` (so the aborted attempts' own timeout race has fired): no `findAndModify` or `update` on `events` is sent by the worker after `Worker stopped` (command sink after the log marker is empty). In the retry variant, no retry is sent after the deadline. | D-11, RF-05 |
| CA-10 | Child A (`PROCESSING_DELAY_MS=3000`, `PROCESSING_TIMEOUT_MS=4000`, `LEASE_MS=5000`): POST 1 event, wait until `processing`, send SIGKILL. Start child B with the same env. | A dies without `Worker stopped`. The document stays `processing` (A's `workerId`) until its `lockedUntil`. Afterwards B logs `Reclaimed event <_id> after lease expiry (attempt 2)` and the document ends `done`, `attempts: 2`, B's processing visible via the reclaim line. Exactly one document exists for the key. | RF-01, RF-02, PLAN P4, P6 |
| CA-11 | `explain('executionStats')` of the RF-01 `findAndModify` (filter, sort, update) with seeded pending and processing documents. | The winning plan uses `claim_status_nextAttemptAt` for both `$or` branches and contains no blocking `SORT` stage. | D-01, RNF-04 |
| CA-12 | F-01 regression: `POLL_INTERVAL_MS=1000`, a processor that resolves after 100 ms, one due event, command sink. | After the claim that returns nothing (sent while the attempt is in flight), the next claim is sent ≥ 900 ms later, not when the attempt settles. Same check after a failed claim (failpoint, 1 time). Pool-full wake still works: with `WORKER_CONCURRENCY=1` and 3 due events, each next claim is sent within 200 ms of the previous attempt settling. | RF-06, D-07, worker D-13 |
| CA-13 | `CaptureLogger` during CA-02–CA-05, CA-08 and CA-12, and child stdout/stderr during CA-06, CA-07 and CA-10. Disabled worker: `WORKER_ENABLED=false`, `app.close()`. | Every worker line matches a worker D-10 or D-08 pattern exactly. No line contains a posted `patientId`, `type`, `ts`, `data` value or any `idempotencyKey`. Every stored `lastError.message` is one of the worker D-12 texts or the `lease_expired` text. With the worker disabled, `close()` logs no `Worker stopping`/`Worker stopped` line. | RNF-03, D-08 |
| CA-14 | The updated Phase 3 CA-05 test. | The expired `processing` seed ends `done`, `attempts: 2`. The other four seeds (future `pending`, valid-lease `processing`, `done`, `failed`) are deep-equal to their seeded state. | D-01 (supersedes Phase 3 CA-05 expectation) |

## 11. QA and evidence

All of the following are planned. None have run yet.

| Area/criteria | Setup and procedure | Expected result | Evidence |
| --- | --- | --- | --- |
| Build, lint, unit, regression (CA-01, CA-14) | `npm run build`, `npm run lint`, `npm test`, `npm run test:e2e` | Exit 0 | Command output, test counts |
| Reclaim (CA-02, CA-05) | e2e: seeded expired leases, spy processors, one and two instances | Reclaimed once, logs | vitest output + per-key counts |
| Attempt-limit guard (CA-03) | e2e: seeded attempts at/over the limit, failpoint variant | `lease_expired` only for reclaims | vitest output + document snapshots |
| Stale holder after reclaim (CA-04) | e2e: two instances, blocked holder, short lease | Fenced, stale warn | vitest output + command sink |
| Signal drain (CA-06, CA-07) | Child-process e2e, SIGTERM | Drain logs, exit by SIGTERM, documents `done`, POST 202 during drain | vitest output + captured stdout + documents |
| Drain timeout (CA-08, CA-09) | e2e: `app.close()`, blocking processor, short timeout, command sink | Bounded, aborted, no further commands, later reclaim | vitest output + logs + command sink |
| Crash recovery (CA-10) | Child-process e2e, SIGKILL then a second child | Reclaimed by B, `done`, attempts 2 | vitest output + stdout + documents |
| Index use (CA-11) | e2e: `explain` on the claim | No blocking SORT | Printed winning plan |
| F-01 (CA-12) | e2e: command sink timestamps | Poll spacing ≥ 900 ms; pool-full wake prompt | vitest output with timings |
| Privacy (CA-13) | `CaptureLogger` and child stdout | Only allowed lines | vitest output |

- Scenarios that don't apply here:
  - Accepted, validation, malformed and oversized POSTs; duplicate POSTs: unchanged (Phase 1), rerun in CA-01. POST during drain is covered by CA-07.
  - Authentication and authorization: none exist (Phase 1 D-08). Signals add no network surface.
  - Ordering: unchanged (PLAN G2). Reclaimed events take their natural place by `nextAttemptAt` (D-01); read order is Phase 2.
  - Replica-set failover: can't be reproduced on a one-member set. Store errors during the guard write and during the drain are simulated with failpoints (CA-03 d, CA-09).
  - Emitted events and metrics: none produced (PLAN G12).
- Manual QA (optional, planned): `docker compose up --build`, POST a few events, `docker compose stop app` within 5 s; `docker compose logs app` shows `Worker stopping…` then `Worker stopped`, and the events are `done`. Then POST again, `docker compose kill app`, `docker compose start app`; after about 30 s the logs show `Reclaimed event…` and the events are `done`.
- Record: the environment (Node and MongoDB versions), the observed child exit (`signal`/`code`), the `explain` winning plan for CA-11, whether failpoints or the wrapper fallback were used, and pass/fail/blocked per CA in the implementation report.

## 12. Definition of done and delivery

- [ ] No blocking decisions or required placeholders remain.
- [ ] RF-01 to RF-06 implemented and CA-01 to CA-14 verified with actual results.
- [ ] Negative scenarios covered: stale holder, reclaim race, attempt-limit guard (including write failure), drain timeout, no commands after stop, SIGKILL recovery.
- [ ] Responsiveness, themes and accessibility: not applicable (no UI).
- [ ] Logs and stored errors comply with D-08, worker D-10/D-12 and RNF-03.
- [ ] `npm run build`, `npm run lint`, `npm test` and `npm run test:e2e` executed, with any limitations declared.
- [ ] Changes limited to scope. No dependency, lockfile, index, model, compose, Dockerfile or README changes.
- [ ] Phase 3 finding F-01 recorded as resolved in the delivery, with the CA-12 evidence.
- [ ] Delivery describes the final behaviour, the files, the tests and the follow-ups for Phases 5 and 6.

Expected artifact: code and tests in this repository.
External actions/publication: none. Commits only when the user requests them.

## 13. References and consistency review

- `PLAN.md`: Phase 4 (scope), §3 (expired-lease branch of the claim), P4 (never lost), P5 (never counted twice), P6 (lease and SIGTERM), G6 (idempotency key), G7 (attempt limit), G12 (no metrics).
- `.ai/.specs/events-worker.md`: D-01/D-02 (superseded), D-03, D-07, D-10, D-12, D-13, D-15, CA-05 (expectation superseded), CA-16 (preserved).
- `.ai/.assessments/events-worker.md`: finding F-01 (D-13) and its reproduction.
- `.ai/.specs/events-data-model.md`: D-03 (`$unset`), D-04 (presence rules), D-05 (`EventError` privacy).
- `.ai/.specs/events-ingest-path.md`: D-08 (no auth), 503 on store unavailable.
- `src/worker/events-worker.ts`, `src/worker/worker.module.ts`, `src/main.ts`, `src/database/database.module.ts`, `src/config/env.validation.ts`, `src/events/event.document.ts`: current claim, stop, wake, lifecycle, settings and model.
- `test/worker.e2e-spec.ts`, `test/worker-concurrency-1.e2e-spec.ts`, `test/support/*.ts`, `vitest.config.e2e.ts`, `package.json`: test infrastructure, the CA-05 assertion to update, scripts.
- `docker-compose.yml`, `Dockerfile`, `README.md`: `init: true`, `stop_grace_period: 30s`, the `node dist/main.js` entrypoint, the existing configuration descriptions.
- `AGENTS.md`: telemetry guidance (not applied).
- Interview answers of 2026-11-02: D-01 (extend the claim), D-02/D-03 (count and fail past the limit), D-05 (abort and leave for reclaim), D-04 (warn log only), D-07 (fix F-01 here), D-09 (child-process e2e).

Consistency review: RF-01→CA-02, CA-04, CA-05, CA-10, CA-11, CA-14; RF-02→CA-02, CA-10; RF-03→CA-03; RF-04→CA-06, CA-10; RF-05→CA-06–CA-09; RF-06→CA-12; D-08/RNF-03→CA-13; D-10→CA-07; D-11→CA-09; Preserve→CA-01, CA-14. D-01 supersedes worker D-01 and only the Phase 3 CA-05 expired-lease expectation. D-05 supersedes worker D-02's unbounded wait, while worker CA-16 still holds because its attempt finishes inside the default 20 s. The guard (D-03) applies only to reclaims, so worker D-15 is unchanged for `pending` claims (CA-03 c). Section 2 lists observed facts, section 5 decisions and assumptions, and section 11 planned, not executed, QA.
