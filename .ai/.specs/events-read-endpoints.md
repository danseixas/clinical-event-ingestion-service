# Events read endpoints — `GET /stats` shows queue depth, lag and stuck events, and `GET /health` reports whether MongoDB is reachable

## 1. Status and reading contract

- Status: ready for implementation.
- Updated: 2026-11-02.
- Decision owner: repository owner (decisions recorded from the create-spec interview of 2026-11-02).
- Affected areas/routes: `GET /health` (changed: Mongo check), `GET /stats` (new). `src/health/*`, a new `src/stats/` module, `src/app.module.ts`, `README.md`, and the e2e tests that assert the `/health` body (`test/app.e2e-spec.ts`, `test/worker-store-down.e2e-spec.ts`). No index, environment variable, data-model type, worker behaviour, compose or Dockerfile change.
- Audience: operators and evaluators who need to see that the service is up, that it can reach its store, and whether the workers keep up with the backlog (PLAN P9, G9). Phase 6 (load, chaos and verification scripts) reads `/stats`, and the Compose healthcheck reads `/health`.
- Deliverable type: integrated backend change. No frontend.
- Related or superseded document: `PLAN.md` Phase 5, G9, P9. It builds on `.ai/.specs/events-ingest-path.md` (Phase 1), `events-data-model.md` (Phase 2), `events-worker.md` (Phase 3) and `events-crash-safety.md` (Phase 4). It **supersedes** the preserved `GET /health → 200 { status: 'ok' }` expectation of Phases 1–4 (ingest CA-16, data-model CA-10, worker CA-15(b) and CA-22) with the D-01 body. It resolves the Phase 4 follow-up "draining state" by deciding against it (D-02).
- Convention: `RF-xx` for functional requirements; `RNF-xx` for quality requirements; `D-xx` for decisions; `CA-xx` for acceptance criteria. Identifiers from earlier specs are prefixed with their name (for example worker D-10, crash-safety D-10).

This spec describes the desired state. Nothing in it has been implemented or verified yet. All requirements are mandatory unless explicitly marked optional.

## 2. Context and problem

`GET /health` always answers `200 { status: 'ok' }`, even when MongoDB is unreachable, so the Compose healthcheck and any load balancer can't see a store outage. There is no way to see queue depth, lag or events stuck behind a dead worker without querying Mongo directly. That leaves PLAN P9 ("`GET /stats` shows queue depth and lag") and G9 unmet, and Phase 6 has nothing to poll.

### Evidence and current state

| Verifiable reference | Observed fact | Implication |
| --- | --- | --- |
| `src/health/health.controller.ts` | `@Get()` returns `{ status: 'ok' }`. The comment says "Liveness only for now; the Mongo connection check arrives with Phase 5." | Add the Mongo check here (RF-01). |
| `src/health/health.module.ts` | Declares only the controller and imports nothing. | Import `DatabaseModule` to get `MONGO_CLIENT`. |
| `src/database/database.module.ts` | `MongoClient` with `serverSelectionTimeoutMS: 5000`, connected in `onModuleInit` (startup fails if Mongo is unreachable), closed in `onApplicationShutdown`. Indexes: `idempotencyKey_unique`, `claim_status_nextAttemptAt` `{ status: 1, nextAttemptAt: 1 }`, `patient_read_order`. | A ping without its own bound could take 5 s. Status counts and the oldest-due lookup can use the claim index. Nothing indexes `receivedAt` by status. |
| `docker-compose.yml` app healthcheck | `fetch('http://localhost:3000/health')`, exits 0 only if `r.ok`. `interval: 5s`, `timeout: 3s`, `retries: 5`. `restart: unless-stopped` (it doesn't restart when unhealthy). | The ping bound must stay well below 3 s (D-03). Under D-01 a 503 marks the container unhealthy, which is the intended effect. No compose change. |
| `src/events/event.document.ts` | `status: 'pending' \| 'processing' \| 'done' \| 'failed'`, `nextAttemptAt: Date`, `lockedUntil?` present only while `processing`. | Source of the `/stats` fields (D-04). |
| `src/worker/events-worker.ts` (Phase 4) | The claim matches `{ status: 'pending', nextAttemptAt: { $lte: now } }` or `{ status: 'processing', lockedUntil: { $lt: now } }`. | `due` and `expiredLeases` use exactly these two predicates (D-04). |
| `src/events/events.service.ts`, `src/events/store-errors.ts` | `isStoreUnavailable()` classifies store errors. A store error becomes `ServiceUnavailableException('Event store unavailable, retry later')`, and `warn` `Event store unavailable: <Name>[ (code <code>)]` is logged. | Reuse both for `/stats` (D-06). |
| `test/app.e2e-spec.ts` | Expects `/health` → `200` and body exactly `{ status: 'ok' }`. | Update to the D-01 body (CA-01). |
| `test/worker-store-down.e2e-spec.ts` CA-15(b) | After `mongo.stop()`, expects `/health` → `200 { status: 'ok' }` and no unhandled rejection. | Superseded: expect `503 { status: 'error', mongo: 'down' }`. The "process stays up, keeps answering, no unhandled rejection" parts stay (CA-04). |
| `test/process-signals.e2e-spec.ts` | Waits for `/health` to return `200` before using a child process. | Still valid: Mongo is up in that suite. |
| `README.md` | "`GET /health` reports whether the app is up." A full `POST /events` section. No `/stats`. | Document both endpoints (D-08). |
| `package.json` | NestJS 12, `mongodb` ^7.8.0, vitest 4, `mongodb-memory-server` ^11.3.0 (MongoDB 7.0.45), supertest. No `@nestjs/terminus`. | No new dependency is needed (D-09). |
| `.ai/.specs/events-ingest-path.md` D-08, README | No authentication. Known limit: deploy behind a gateway or mTLS. | `/stats` and `/health` follow the same rule (D-07). |
| `AGENTS.md` | Optional NestJS Observe telemetry, `ObserveModule` not registered. | Not applied (PLAN G12 defers metrics). |

Missing: the Mongo check in `/health`, the whole `/stats` endpoint, and the docs for both.

## 3. Objective and expected outcome

- Product outcome: `GET /health` answers `200 { status: 'ok', mongo: 'up' }` when the app can ping MongoDB within 1 s, and `503 { status: 'error', mongo: 'down' }` otherwise. `GET /stats` answers `200` with global event counts per status, the number of due pending events, the number of processing events whose lease has expired, how long the oldest due event has waited, and the time the numbers were taken. Every replica reports the same numbers because they come from the shared collection.
- Verifiable success signal: e2e tests against the in-memory 7.0.45 replica set for both endpoints, covering seeded states, Mongo stopped or slow, the query plans and the logs (section 11).
- Limits of the claim: the counts come from separate queries, so they are not a consistent snapshot. Under concurrent changes their sum may differ slightly from the document total. `/stats` shows no per-process state (in-flight attempts, workerId, draining) and no throughput figure. Phase 6 derives throughput from the store. Counting `done` events scans their index keys, so its cost grows with the size of the collection (D-05). `/health` proves that a ping reached the primary or a selectable server, not that writes with `w: 'majority'` succeed.

## 4. Scope

### Included

- The Mongo ping in `GET /health`, with the D-01 bodies and the 1 s bound (RF-01).
- `GET /stats` with the D-04 body (RF-02), the 503 mapping when the store is unavailable (RF-03), and its log line.
- A new `StatsModule` (controller and service) registered in `AppModule`.
- README sections for `GET /health` and `GET /stats`.
- Updates to the two existing `/health` assertions and new e2e tests for every scenario in section 11.

### Out of scope

- A draining or readiness state in `/health`, and a separate `/ready` route (D-02).
- Per-process data in `/stats` (in-flight count, `workerId`, worker enabled or draining), throughput or rates, failures grouped by `lastError.code`, `oldestPendingAgeMs` by `receivedAt` (rejected in the interview).
- Caching, pagination or filters on `/stats`. Query parameters are ignored.
- Authentication or authorization (D-07).
- New indexes, settings, model fields, worker changes, compose or Dockerfile changes. The healthcheck stays as it is.
- Metrics or telemetry export, NestJS Observe (PLAN G12).
- Load, chaos and verification scripts: Phase 6.

### Preserve

- The `POST /events` contract, its logging and its 503 text (Phase 1).
- Indexes and startup semantics: the app still fails to start when Mongo is unreachable (Phase 2, ingest CA-15).
- All worker and crash-safety behaviour, including the log lines in worker D-10 and crash-safety D-08, and the drain and HTTP order in crash-safety D-10.
- Every environment variable, default and cross-field rule.
- `test/process-signals.e2e-spec.ts` readiness polling (`/health` → 200 while Mongo is up).
- Every existing test assertion except the `/health` body expectations listed in section 2.

## 5. Decisions, assumptions, and questions

### Adopted decisions

| ID | Concrete decision | Rationale and impact |
| --- | --- | --- |
| D-01 | `GET /health` sends `ping` (`{ ping: 1 }`) to the app's Mongo client (`client.db().command`). If it resolves within the D-03 bound, the response is `200 { "status": "ok", "mongo": "up" }`. If it rejects for any reason, or the bound passes first, the response is `503 { "status": "error", "mongo": "down" }`. That body is the whole response: no `statusCode`, `message` or `error` fields. | Chosen in the interview. Follows PLAN G9 ("liveness plus the Mongo connection"). Compose and load balancers see an outage through the status code. Supersedes the `200 { status: 'ok' }` body of Phases 1–4. |
| D-02 | `/health` has no draining or readiness state. During the crash-safety D-05 drain it reports only Mongo reachability. After `DatabaseModule` has closed the client, the ping fails, so a request in the short window before the HTTP server closes gets the D-01 503. | Chosen in the interview. The drain is bounded (20 s by default), `POST /events` keeps working during it (crash-safety D-10), and the service has no readiness/liveness split. Keeps `HealthModule` independent of the worker. |
| D-03 | The ping bound is 1000 ms, a fixed constant (no new setting). When it passes, the request answers at once. The ping may keep running in the background, and its later outcome is ignored and causes no unhandled rejection. | Low-risk, reversible. Well below the 3 s Compose healthcheck timeout, and far below the 5 s server-selection timeout that an unbounded ping would hit. The implementer may use the driver's `timeoutMS` or a timer race, as long as CA-03 holds. |
| D-04 | `GET /stats` → `200` with exactly this JSON body: `{ "counts": { "pending": int, "processing": int, "done": int, "failed": int }, "due": int, "expiredLeases": int, "oldestDueAgeMs": int, "generatedAt": ISO-8601 string }`. One `now` (taken once per request) is used for every query, and `generatedAt = now.toISOString()`. Definitions: `counts.<s>` = number of documents with `status: s`, with all four keys always present (0 when none). `due` = number of documents matching `{ status: 'pending', nextAttemptAt: { $lte: now } }`. `expiredLeases` = number matching `{ status: 'processing', lockedUntil: { $lt: now } }`, a subset of `counts.processing`. `oldestDueAgeMs` = `now − min(nextAttemptAt)` over the `due` documents, in whole milliseconds, or `0` when `due` is 0. | Chosen in the interview (PLAN fields plus the stuck count, lag as the oldest due wait). The predicates are the Phase 4 claim's two branches, so `due + expiredLeases` is exactly the work that could be claimed at `now`. Backoff waits don't count as lag. All values come from the shared collection, so every replica agrees. |
| D-05 | Queries: six `countDocuments` (one per status, `due`, `expiredLeases`) and one `findOne({ status: 'pending', nextAttemptAt: { $lte: now } }, { sort: { nextAttemptAt: 1 }, projection: { nextAttemptAt: 1 } })`. They may run in parallel. Each one passes `maxTimeMS: 5000`. They use the collection's default read concern and read preference, and no transaction. | Low-risk. Every query can be served by `claim_status_nextAttemptAt` (CA-08). The counts aren't a snapshot (section 3). `maxTimeMS` matches the existing 5 s store bound (ingest D-04). |
| D-06 | `/stats` errors: if a query fails with an error that `isStoreUnavailable()` classifies as a store error, or with a `maxTimeMS` expiry (`MongoServerError` code 50, `MaxTimeMSExpired`), the response is the existing `503` `ServiceUnavailableException('Event store unavailable, retry later')`, and `warn` `Event store unavailable: <ErrorName>[ (code <code>)]` is logged with context `StatsService`, once per request. Any other error is rethrown unchanged (Nest's default 500, Nest's error log). `/health` logs nothing, whatever the outcome. | Low-risk, consistent with `EventsService.mapError`. `/health` is polled every 5 s by Compose, and the worker's `Claim failed` warns already show an outage while the worker is enabled. |
| D-07 | `/stats` and `/health` have no authentication, like the rest of the service (ingest D-08). `/stats` returns only counts, durations and a timestamp: no `_id`, `patientId`, `type`, `ts`, `data`, `idempotencyKey`, `result` or `lastError`. | Keeps the existing trust model ("deploy behind a gateway or mTLS"). Nothing clinical can leak through these routes. |
| D-08 | README: replace "`GET /health` reports whether the app is up" with a short `GET /health` section (the two bodies, the 1 s bound, no draining state) and add a `GET /stats` section (the D-04 fields and definitions, the 503, and the not-a-snapshot and `done`-count-cost notes). The architecture docs stay in PLAN Phase 8. | Low-risk. Phase 1 documented its endpoint in the README the same way. |
| D-09 | Structure: `HealthModule` imports `DatabaseModule`, and `HealthController` injects `MONGO_CLIENT`. A new `src/stats/` folder holds `StatsModule` (imports `DatabaseModule`), `StatsController` (`@Controller('stats')`, `@Get()`) and `StatsService` (injects `EVENTS_COLLECTION`). Both modules are registered in `AppModule`. No `@nestjs/terminus`. | Low-risk. Follows the existing module-per-feature layout and the single shared `DatabaseModule`. `/stats` works with `WORKER_ENABLED=false`. |

### Assumptions to verify

| Assumption | Available evidence | Confirmation / effect if false |
| --- | --- | --- |
| On MongoDB 7.0.45, each D-05 query uses `claim_status_nextAttemptAt` (`COUNT_SCAN` or `IXSCAN`), and the `findOne` has no blocking `SORT` stage. | Index prefix `{ status, nextAttemptAt }`. `expiredLeases` filters `lockedUntil` after an `IXSCAN` on `status`. That is acceptable because `processing` is bounded by concurrency × replicas. | CA-08 checks `explain`. If a query falls back to `COLLSCAN` or a blocking `SORT`, implementation stops and reports it. The spec is revised (for example with a hint), not silently changed. |
| A `failCommand` failpoint with `blockConnection: true, blockTimeMS: 3000` on `ping` delays the app's ping on the in-memory replica set (`enableTestCommands`). | `failCommand` is already used for `update` and `findAndModify` in the Phase 3–4 suites. Not yet checked for `ping`. | If `ping` can't be targeted, the slow-Mongo case (CA-03) and the recovery case (CA-05) use a test-only override of `MONGO_CLIENT` whose `db().command` is wrapped to delay or fail on demand. Record which method was used. |
| After `mongo.stop()`, the driver's ping rejects or exceeds 1 s, so `/health` answers 503 within about 1 s. | Phase 3 CA-15(b) observed `Mongo…Error` on claims after `mongo.stop()`. | CA-04 asserts the 503 and the response time. If the stop behaves differently, record what was observed and adjust only the timing tolerance, not D-01. |
| `ServiceUnavailableException` built with the object `{ status: 'error', mongo: 'down' }` makes Nest 12 send exactly that object as the body. | Nest's `HttpException` uses an object response as the body in earlier majors. | CA-02/CA-04 assert deep equality. If Nest adds fields, set the status with `@Res({ passthrough: true })` instead. The body contract doesn't change. |

### Open questions

None blocking. Non-blocking follow-ups: Phase 6 decides its own limits for `oldestDueAgeMs` and polls `/stats` for "nothing stuck" (`counts.pending = 0`, `counts.processing = 0`). PLAN Phase 8 ("with more time") may add per-process metrics, failures by code, or a readiness signal.

## 6. User journey and states

### Preconditions and entry

- The app has started, which means it connected to MongoDB and created the indexes (Phase 2). Any client that can reach the HTTP port may call either route. There is no authentication (D-07).

### Main flow — health

1. A client (the Compose healthcheck, a load balancer, an operator) sends `GET /health`.
2. The app pings Mongo with the 1 s bound.
3. Ping resolves: `200 { status: 'ok', mongo: 'up' }`. Otherwise: `503 { status: 'error', mongo: 'down' }`.

### Main flow — stats

1. A client (an operator, the Phase 6 scripts) sends `GET /stats`.
2. The app takes `now` and runs the D-05 queries.
3. `200` with the D-04 body.

### Alternatives and exceptions

- Mongo stopped or unreachable: `/health` → 503 within about 1 s (CA-04). `/stats` → 503 `Event store unavailable, retry later` and one `warn` (CA-07). The process stays up and keeps answering.
- Mongo slow (ping takes longer than 1 s): `/health` → 503 (CA-03). Back to normal: the next `/health` → 200 (CA-05).
- `/stats` query exceeds `maxTimeMS`: 503 (D-06).
- Unexpected error in `/stats`: Nest's default 500 (D-06).
- Empty collection: all counts 0, `oldestDueAgeMs: 0` (CA-06).
- Only future pending events (in backoff): `due: 0`, `oldestDueAgeMs: 0`, `counts.pending > 0` (CA-06).
- During the shutdown drain: `/health` answers based on Mongo alone (D-02). After the client closes: 503 until the HTTP server closes.
- Worker disabled: `/stats` and `/health` behave the same (D-09).
- Other HTTP methods on these paths: Nest's default 404 (no handler).

| State (`/health`) | Trigger | Response | Exit condition |
| --- | --- | --- | --- |
| Up | Ping resolves within 1000 ms | `200 { status: 'ok', mongo: 'up' }` | Next request |
| Down | Ping rejects or the bound passes | `503 { status: 'error', mongo: 'down' }` | Next request after Mongo is reachable again |

| State (`/stats`) | Trigger | Response | Exit condition |
| --- | --- | --- | --- |
| Available | All queries succeed | `200` D-04 body | Next request |
| Store unavailable | Store error or `maxTimeMS` expiry | `503` `Event store unavailable, retry later` and one warn | Next request after recovery |
| Unexpected error | Any other error | `500` (Nest default) | — |

## 7. Functional requirements and contracts

### RF-01 — `GET /health` with the Mongo check

- Trigger: `GET /health`.
- Rules: D-01 and D-03. The ping goes through the shared `MONGO_CLIENT`. No query touches `events`.
- Output: `200 { status: 'ok', mongo: 'up' }` or `503 { status: 'error', mongo: 'down' }`, `Content-Type: application/json`.
- Exceptions: none beyond the 503. A ping that settles after the bound is ignored, and it must not cause an unhandled rejection.
- Side effects: no writes, no logs (D-06).

### RF-02 — `GET /stats`

- Trigger: `GET /stats`. Query parameters are ignored.
- Rules: D-04 and D-05. `now` is read once. Every field is a non-negative integer except `generatedAt`. `oldestDueAgeMs = Math.max(0, now − oldest.nextAttemptAt)` in milliseconds.
- Output: `200` with the D-04 body and no other fields.
- Side effects: reads only. No writes and no logs on success.

### RF-03 — `/stats` store failure

- Trigger: a D-05 query fails.
- Rules: D-06. Store errors and `maxTimeMS` expiry → 503 with the existing message and one `warn` `Event store unavailable: <ErrorName>[ (code <code>)]` (context `StatsService`). The `[ (code …)]` part appears only when the error has a code. Any other error is rethrown.
- Output: `503 { statusCode: 503, message: 'Event store unavailable, retry later', error: 'Service Unavailable' }` (Nest's standard shape, as for `POST /events`).
- Side effects: exactly one warn per failed request, even if several parallel queries fail.

### Data and validation

| Field | Type, label, and initial value | Normalization | Rules and limits | Exact message |
| --- | --- | --- | --- | --- |
| `/health` `status` | `'ok' \| 'error'` | — | `ok` iff HTTP 200 | — |
| `/health` `mongo` | `'up' \| 'down'` | — | `up` iff ping resolved within 1000 ms | — |
| `/stats` `counts.pending/processing/done/failed` | integer ≥ 0 | — | per D-04, always present | — |
| `/stats` `due` | integer ≥ 0 | — | ≤ `counts.pending` when there are no concurrent changes | — |
| `/stats` `expiredLeases` | integer ≥ 0 | — | ≤ `counts.processing` when there are no concurrent changes | — |
| `/stats` `oldestDueAgeMs` | integer ≥ 0 | truncated to whole ms | 0 iff `due` is 0 (when there are no concurrent changes) | — |
| `/stats` `generatedAt` | string | `Date#toISOString()` (UTC, ms) | equals the `now` used by the queries | — |
| 503 `/stats` message | string | — | fixed | `Event store unavailable, retry later` |

- Validation timing: not applicable. Neither route takes input.
- Source of truth: `EventDocument` / `EventStatus` (`src/events/event.document.ts`), `isStoreUnavailable` (`src/events/store-errors.ts`).

### Integrations

| Operation | Confirmed contract | Success | Failures and recovery |
| --- | --- | --- | --- |
| Mongo `ping` | `client.db().command({ ping: 1 })`, bounded at 1000 ms (D-03) | `{ ok: 1 }` → 200 | Reject or timeout → 503. Recovers when Mongo answers again |
| `countDocuments` × 6, `findOne` × 1 on `events` | D-05, `maxTimeMS: 5000` | D-04 body | D-06 → 503 or 500. The client may retry, since it's read-only |

### Content and actions

Not applicable: no UI. The response bodies are fixed in D-01, D-04 and RF-03.

## 8. Non-functional requirements

### RNF-01 — Visual design, responsiveness, and themes

Not applicable: backend only, no user interface.

### RNF-02 — Accessibility

Not applicable: no user interface.

### RNF-03 — Privacy and security

- Sensitive data: neither route returns or logs any field of an event. `/stats` aggregates only counts and `nextAttemptAt` (D-07). The `findOne` projection is limited to `nextAttemptAt`, and that value is never returned as-is, only as an age.
- Persistence: none. Both routes are read-only.
- Logs: only the D-06 warn, containing the error name and code. Driver error messages are not logged (they may include host names). `/health` logs nothing.
- Trust boundary: unchanged, no authentication (D-07). The README keeps the gateway/mTLS note.

### RNF-04 — Quality, performance, and compatibility

- Environment: Node 24, MongoDB 7.0 replica set (Compose and `mongodb-memory-server` 7.0.45).
- Performance: `/health` answers within 1000 ms + request overhead, whatever the state of Mongo (CA-03, CA-04). `/stats` queries are index-served (CA-08). Each is bounded by `maxTimeMS: 5000`. With Mongo unreachable, `/stats` can take up to the 5 s server selection plus overhead. There is no numeric throughput target. The cost of counting `done` grows with the collection, which is accepted and documented (D-08).
- Reliability: no unhandled rejection from a late ping or from parallel query failures (CA-04, CA-07). Read-only, so it is safe to call at any rate the store tolerates.
- Dependencies: none added.
- Code style: ESM `.js` import suffixes, Prettier and oxlint as configured, comment density matching `events.service.ts`, constants for the fixed bound and texts.

## 9. Technical guidelines and impact

- Applicable instructions: `AGENTS.md` (Observe telemetry is not in scope). There is no `CLAUDE.md`.
- Observed stack: NestJS 12, `mongodb` ^7.8.0, TypeScript 6, vitest 4, supertest, `mongodb-memory-server` ^11.3.0 (MongoDB 7.0.45), ESM, Node 24.
- New dependencies: none.
- Architecture: `HealthController` owns the ping. `StatsService` owns the queries and the error mapping, and `StatsController` only exposes it. `DatabaseModule` keeps sole ownership of the client lifecycle. Nothing reads worker state.
- Reuse: `MONGO_CLIENT`, `EVENTS_COLLECTION`, `isStoreUnavailable`, the existing 503 message, and the test helpers (`startMongo` with `enableTestCommands`, `createTestApp`, `CaptureLogger`, `seedEvent`, `waitFor`).
- Constraints: no change to `EventsService`, `EventsWorker`, `DatabaseModule`, the indexes, env validation, `docker-compose.yml` or `Dockerfile`.

| File/area | Current state | Expected change | Risk/regression |
| --- | --- | --- | --- |
| `src/health/health.controller.ts` | Returns `{ status: 'ok' }` | RF-01 (ping, bound, 503 body). Update the comment | Compose marks the app unhealthy while Mongo is down (intended) |
| `src/health/health.module.ts` | No imports | Import `DatabaseModule` | — |
| `src/stats/stats.module.ts`, `stats.controller.ts`, `stats.service.ts` (suggested names) | Absent | RF-02, RF-03 | — |
| `src/app.module.ts` | Imports Config, Health, Events, Worker | Also imports `StatsModule` | — |
| `README.md` | One line on `/health`, no `/stats` | D-08 sections | Docs only |
| `test/app.e2e-spec.ts` | Expects `{ status: 'ok' }` | Expect `{ status: 'ok', mongo: 'up' }` | Only this assertion changes |
| `test/worker-store-down.e2e-spec.ts` CA-15(b) | Expects 200 `{ status: 'ok' }` with Mongo stopped | Expect 503 `{ status: 'error', mongo: 'down' }`. Keep the claim-failure wait and the unhandled-rejection check | Only the status and body assertions change |
| `test/health.e2e-spec.ts`, `test/stats.e2e-spec.ts` (suggested; may be split per env or Mongo lifecycle) | Absent | CA-02–CA-10 | Timing tolerances; tests that stop Mongo need their own replica set |

## 10. Traceable acceptance criteria

The e2e criteria run against the in-memory 7.0.45 replica set with `WORKER_ENABLED=false` (so seeded documents aren't changed) unless stated otherwise. Seeded values are fictional (for example `patientId: 'p-test-1'`, `data: { hr: 72 }`).

| ID | Given / when | Then, observable | Requirement |
| --- | --- | --- | --- |
| CA-01 | `npm run build`, `npm run lint`, `npm test`, `npm run test:e2e`. | All exit 0. Every Phase 1–4 suite passes. The only changed assertions are the `/health` bodies in `test/app.e2e-spec.ts` and `test/worker-store-down.e2e-spec.ts` (git diff limited to those lines). `test/process-signals.e2e-spec.ts` passes unchanged. | RNF-04, Preserve |
| CA-02 | Mongo up. `GET /health`. | `200`, `Content-Type` JSON, body deep-equals `{ status: 'ok', mongo: 'up' }`. | RF-01, D-01 |
| CA-03 | Mongo up, failpoint (or the D-03 fallback wrapper) delays `ping` by 3000 ms. `GET /health`. | `503`, body deep-equals `{ status: 'error', mongo: 'down' }`, response within 1500 ms of the request. No unhandled rejection after waiting 3500 ms (spy on `process.on('unhandledRejection')`). | RF-01, D-01, D-03 |
| CA-04 | Worker-enabled variant (updated CA-15(b)): `mongo.stop()`, wait for a `Claim failed: Mongo…Error` warn. Worker-disabled variant: `mongo.stop()`. `GET /health` in each. | `503 { status: 'error', mongo: 'down' }` within 1500 ms in both. The unhandled-rejection spy stays empty. `/health` logs nothing (no new log line between request and response, from any context other than `EventsWorker`). | RF-01, D-01, D-06, supersedes worker CA-15(b) body |
| CA-05 | As CA-03, then turn the delay off. `GET /health` again. | `200 { status: 'ok', mongo: 'up' }`. | RF-01 |
| CA-06 | Seed, with `now` known to the test: 3 `pending` due (`nextAttemptAt` = now − 10 s, − 5 s, − 1 s), 2 `pending` future (now + 60 s), 4 `processing` with `lockedUntil` now + 30 s, 1 `processing` with `lockedUntil` now − 1 s, 5 `done`, 2 `failed`. `GET /stats`. Also: an empty collection; only the 2 future `pending`. | Body has exactly the D-04 keys. `counts = { pending: 5, processing: 5, done: 5, failed: 2 }`, `due: 3`, `expiredLeases: 1`, `oldestDueAgeMs` within [10000, 10000 + request time], `generatedAt` a valid ISO string between the request's start and end. Empty: all counts 0, `due: 0`, `expiredLeases: 0`, `oldestDueAgeMs: 0`. Future only: `counts.pending: 2`, `due: 0`, `oldestDueAgeMs: 0`. | RF-02, D-04 |
| CA-07 | `mongo.stop()`. `GET /stats`. | `503`, body `{ statusCode: 503, message: 'Event store unavailable, retry later', error: 'Service Unavailable' }`, within 10 s. Exactly one `warn` with context `StatsService` matching `^Event store unavailable: Mongo\w*Error( \(code \S+\))?$`. No unhandled rejection. | RF-03, D-06 |
| CA-08 | `explain('executionStats')` of each D-05 query (the six counts as `aggregate` or `count` plans, and the `findOne`) over the CA-06 seed. | Every winning plan uses `claim_status_nextAttemptAt`. None has `COLLSCAN` or a blocking `SORT` stage. | D-05, RNF-04 |
| CA-09 | `WORKER_ENABLED=true`, a spy processor that succeeds, 20 events POSTed. Poll `GET /stats` until `counts.done = 20`. Second instance: two apps on one database, `GET /stats` on each. | The final body has `counts = { pending: 0, processing: 0, done: 20, failed: 0 }`, `due: 0`, `expiredLeases: 0`, `oldestDueAgeMs: 0`. Both instances return the same `counts`. | RF-02, D-04, D-09 |
| CA-10 | `CaptureLogger` during CA-02–CA-07 and CA-09. Response bodies of CA-06 and CA-09. | No log line or response body contains a seeded or posted `patientId`, `type`, `ts`, `data` value or any `idempotencyKey`. The only new log line is the CA-07 warn. Successful `/stats` and every `/health` request log nothing. | RNF-03, D-06, D-07 |
| CA-11 | README after the change. | It has a `GET /health` section with both bodies, the 1 s bound and the absence of a drain state, and a `GET /stats` section with every D-04 field and its definition, the 503, and the snapshot and `done`-count notes. The old sentence "`GET /health` reports whether the app is up." is gone. | D-08 |

## 11. QA and evidence

All of the following are planned. None have run yet.

| Area/criteria | Setup and procedure | Expected result | Evidence |
| --- | --- | --- | --- |
| Build, lint, unit, regression (CA-01) | `npm run build`, `npm run lint`, `npm test`, `npm run test:e2e`, `git diff --stat` | Exit 0. Only the two `/health` assertions changed in existing tests | Command output, test counts, diff |
| Health up/slow/down/recovery (CA-02–CA-05) | e2e: Mongo up; `ping` failpoint or wrapper; `mongo.stop()` with the worker enabled and disabled | Bodies, status codes, response times, no unhandled rejection | vitest output with timings; failpoint method recorded |
| Stats values (CA-06) | e2e: seeded fixture, empty collection, future-only | Exact counts and ages | vitest output + seeded fixture |
| Stats store down (CA-07) | e2e: `mongo.stop()` | 503 body, one warn | vitest output + captured logs |
| Index use (CA-08) | e2e: `explain` on each query | Claim index, no COLLSCAN, no blocking SORT | Printed winning plans |
| End to end with the worker (CA-09) | e2e: POST, poll `/stats`, two instances | Converges to all `done`, both instances agree | vitest output |
| Privacy (CA-10) | `CaptureLogger`, response bodies | No payload values, only the allowed warn | vitest output |
| Docs (CA-11) | Read `README.md` | Sections present | Diff excerpt |

- Scenarios that don't apply here:
  - Validation, malformed and oversized payloads: neither route takes a body or parameters. `POST /events` is unchanged and rerun in CA-01.
  - Authentication and authorization: none exist (D-07, ingest D-08).
  - Duplicates and idempotency: both routes are read-only. Repeating them has no effect.
  - Ordering: not applicable. `/stats` reports aggregates, and read order is Phase 2.
  - Concurrency: concurrent changes make the counts non-snapshot (section 3). Covered only as agreement once the system is quiet (CA-09). There is no stronger claim to test.
  - Replica-set failover: can't be reproduced on a one-member set. Outage and slowness are simulated with `mongo.stop()` and a failpoint or wrapper (CA-03, CA-04, CA-07).
  - Retry and recovery: `/health` recovery is CA-05. `/stats` recovery after a restart of Mongo isn't automated (the in-memory set isn't restarted in place). Read-only retries are safe by construction.
  - Emitted events and metrics: none produced (PLAN G12).
- Manual QA (optional, planned): `docker compose up --build`; `curl -i localhost:3000/health` → 200 `{"status":"ok","mongo":"up"}`; POST a few events and `curl localhost:3000/stats` until `done` matches; `docker compose stop mongo`; `curl -i localhost:3000/health` → 503 within about 1 s and `docker compose ps` shows the app `unhealthy` after the retries; `docker compose start mongo` → `/health` 200 again and the app `healthy`.
- Record: the environment (Node and MongoDB versions), the failpoint or wrapper method for CA-03/CA-05, the observed response times for CA-03, CA-04 and CA-07, the CA-08 winning plans, and pass/fail/blocked per CA in the implementation report.

## 12. Definition of done and delivery

- [ ] No blocking decisions or required placeholders remain.
- [ ] RF-01 to RF-03 implemented and CA-01 to CA-11 verified with actual results.
- [ ] Negative scenarios covered: Mongo stopped, Mongo slow, recovery, store failure in `/stats`, empty and future-only states.
- [ ] Responsiveness, themes and accessibility: not applicable (no UI).
- [ ] Logs and bodies comply with D-06, D-07 and RNF-03.
- [ ] `npm run build`, `npm run lint`, `npm test` and `npm run test:e2e` executed, with any limitations declared.
- [ ] Changes limited to scope. No dependency, lockfile, index, model, worker, env, compose or Dockerfile changes.
- [ ] Delivery describes the final behaviour, the files, the tests, the superseded `/health` assertions, and the follow-ups for Phase 6.

Expected artifact: code, tests and README changes in this repository.
External actions/publication: none. Commits only when the user requests them.

## 13. References and consistency review

- `PLAN.md`: Phase 5 (scope), G9 (`/stats` fields, `/health` = liveness plus Mongo), P9 (queue depth and lag), G12 (no metrics), Phase 6 (consumer of `/stats`).
- `.ai/.specs/events-ingest-path.md`: D-04 (5 s store bound), D-08 (no auth), the 503 text, CA-15 (startup fails without Mongo), CA-16 (`/health` body, superseded).
- `.ai/.specs/events-data-model.md`: the claim index, CA-10 (`/health` body, superseded).
- `.ai/.specs/events-worker.md`: D-10 log lines, CA-15(b) (`/health` body with Mongo stopped, superseded), CA-22.
- `.ai/.specs/events-crash-safety.md`: D-01 (claim predicates reused by D-04), D-05/D-10 (drain and HTTP order), the "draining state" follow-up (D-02).
- `.ai/.implementations/events-crash-safety.md`: follow-up "Phase 5 may expose reclaim counts/draining state".
- `src/health/*`, `src/app.module.ts`, `src/database/*`, `src/events/events.service.ts`, `src/events/store-errors.ts`, `src/events/event.document.ts`, `src/worker/events-worker.ts`: current routes, client, indexes, error mapping, model and claim.
- `test/app.e2e-spec.ts`, `test/worker-store-down.e2e-spec.ts`, `test/process-signals.e2e-spec.ts`, `test/support/*.ts`, `vitest.config.e2e.ts`, `package.json`: assertions to update, readiness polling, helpers, scripts.
- `docker-compose.yml`: healthcheck (`r.ok`, 3 s timeout).
- `README.md`, `AGENTS.md`.
- Interview answers of 2026-11-02: D-01 (503 when the ping fails), D-02 (no drain state), D-04 (PLAN fields plus `expiredLeases`; lag as the oldest due wait).

Consistency review: RF-01→CA-02–CA-05; RF-02→CA-06, CA-09; RF-03→CA-07; D-01→CA-02–CA-05; D-02 is negative scope (no state to test beyond CA-02/CA-04); D-03→CA-03; D-04→CA-06, CA-09; D-05→CA-08; D-06→CA-04, CA-07, CA-10; D-07/RNF-03→CA-10; D-08→CA-11; D-09→CA-09 (worker enabled and disabled), CA-01; Preserve→CA-01. D-04's `due` and `expiredLeases` use the Phase 4 claim predicates exactly, so `/stats` can't disagree with what the worker considers claimable. D-01 supersedes only the `/health` body and status expectations of earlier phases. Startup still fails without Mongo, so `/health` never runs before a first successful connection. Section 2 lists observed facts, section 5 decisions and assumptions, and section 11 planned, not executed, QA.
