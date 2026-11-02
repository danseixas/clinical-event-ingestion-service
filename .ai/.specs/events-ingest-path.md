# Events ingest path — `POST /events` durably stores each unique event once and answers `202` immediately

## 1. Status and reading contract

- Status: implemented and verified.
- Updated: 2026-11-02.
- Assessment: [`.ai/.assessments/events-ingest-path.md`](../.assessments/events-ingest-path.md) (PASS, 2026-11-02).
- Decision owner: repository owner (decisions recorded from the create-spec interview of 2026-11-02).
- Affected areas/routes: `POST /events` (new), `src/app.module.ts`, new `src/events/` and `src/database/` areas, `test/` e2e suite, `package.json`.
- Audience: upstream clinical systems that send patient events over HTTP and retry on failure; evaluators verifying the "never lost, never counted twice" claims.
- Deliverable type: integrated backend feature (HTTP API + MongoDB persistence). No frontend.
- Related or superseded document: `PLAN.md` Phase 1, decisions G1, G8, P2–P4; Phase 2 (data model) builds on this spec.
- Convention: `RF-xx` for functional requirements; `RNF-xx` for quality requirements; `D-xx` for decisions; `CA-xx` for acceptance criteria.

This spec describes the desired state. Nothing in it has been implemented or verified yet. All requirements are mandatory unless explicitly marked optional.

## 2. Context and problem

Upstream systems send about 1000 events/min, retry on failure and send duplicates. Every event must be stored durably before the sender is told it was accepted (PLAN P2, P4), and a retried or duplicated event must not create a second record (P3). The background processing (Phase 3) needs each stored event to already be in a claimable initial state. Today the service has no ingest endpoint and no database connection.

### Evidence and current state

| Verifiable reference | Observed fact | Implication |
| --- | --- | --- |
| `package.json` | NestJS 12, `class-validator` 0.15, `class-transformer` 0.5, vitest 4, supertest 7, `"type": "module"`. No MongoDB library is installed. | Add the `mongodb` driver (D-01) and `mongodb-memory-server` (D-09). Use `.js` import suffixes (ESM). |
| `src/app.module.ts` | Imports `ConfigModule.forRoot({ isGlobal, cache, validate: validateEnv })` and `HealthModule`. | Register the database and events modules here. |
| `src/config/env.validation.ts` | `MONGO_URI` exists with default `mongodb://localhost:27017/ingest?directConnection=true`. No Mongo timeout settings. | Reuse `MONGO_URI`. Timeouts are code constants (D-04). |
| `src/main.ts` | `NestFactory.create(AppModule)`, then `listen(PORT)`. No global pipes or filters. | Validation and the error mapping must be added (global or scoped to the events controller). |
| `src/health/health.controller.ts` | `GET /health` returns `{ status: 'ok' }`. The Mongo check is deferred to Phase 5. | Preserve the behaviour. Do not add the Mongo check here. |
| `test/app.e2e-spec.ts` | Boots the full `AppModule` and asserts `GET /health` → 200 `{ status: 'ok' }`. | Once AppModule connects to Mongo at init (D-07), this test needs an in-memory Mongo too. |
| `docker-compose.yml` | `mongo:7.0` with `--replSet rs0`. App `MONGO_URI=mongodb://mongo:27017/ingest?replicaSet=rs0`, `restart: unless-stopped`, `depends_on: service_healthy`. | Majority writes are available. A startup failure is recovered by restart. |
| `README.md` | Documents `/health`, configuration and tests. No `/events` documentation. | Add a short `POST /events` usage section. Full architecture docs are Phase 8. |
| `AGENTS.md` | Describes optional NestJS Observe telemetry. `ObserveModule` is not registered. | Not applicable to this phase. No telemetry is added. |

Missing: the endpoint, validation, canonical hashing, the Mongo connection, the `events` collection with its unique index, duplicate handling, and error mapping.

## 3. Objective and expected outcome

- Product outcome: a sender can `POST /events` with `{ patientId, type, ts, data }`. A valid, previously unseen event is stored once with majority durability and answered `202 { id, status: 'pending', duplicate: false }`. Any later POST with the same canonical content (including concurrent ones) is answered `202` with the original `id`, its current `status` and `duplicate: true`. Invalid input gets `400`. If the store can't confirm durability, the sender gets `503`.
- Verifiable success signal: e2e tests against an in-memory MongoDB 7.0 replica set show the response codes and bodies, exactly one document per idempotency key, the stored document shape, the unique index, and the `writeConcern: { w: 'majority' }` on the insert command (see section 11).
- Limits of the claim: this phase doesn't process events (Phase 3), doesn't create the claim or read-order indexes (Phase 2), and doesn't prove throughput at 1000 events/min (Phase 6). The test environment is a single-node replica set, so a multi-node failover is not exercised directly; it is covered by mapping driver errors to `503`.

## 4. Scope

### Included

- `EventsModule` with `POST /events`, the request DTO and validation (RF-01, RF-02).
- Canonical JSON plus a SHA-256 idempotency key (RF-03).
- A `DatabaseModule` with one shared `MongoClient`, created from `MONGO_URI`, closed on app shutdown (RF-05).
- The `events` collection with a unique index on `idempotencyKey`, created at startup (RF-05).
- An insert with `w: 'majority'` that writes the full initial document shape (RF-04).
- Duplicate-key handling that returns the existing record (RF-04).
- `503` mapping for store unavailability (RF-06).
- e2e tests for every scenario in section 11, and the `/health` e2e test moved to an in-memory Mongo.
- A short `POST /events` section in `README.md`.

### Out of scope

- Authentication and authorization (D-08). The README states it as a known limit.
- The worker, claim and lease fields set during processing (`workerId`, `lockedUntil`, `result`, `lastError`, `processedAt`): Phases 3–4.
- The claim index `{ status, nextAttemptAt }` and the read-order index `{ patientId, ts, receivedAt, _id }`: Phase 2.
- `GET /stats` and the Mongo check in `GET /health`: Phase 5.
- An explicit `Idempotency-Key` header: "with more time".
- Load, chaos and verification scripts: Phase 6.
- Metrics, tracing, NestJS Observe.

### Preserve

- `GET /health` → `200 { status: 'ok' }` (liveness only).
- Every existing environment variable, its default and its validation in `env.validation.ts`.
- The Dockerfile and docker-compose behaviour. No new Compose services or environment variables are required.
- The existing unit tests (`src/config/env.validation.spec.ts`) keep passing.

## 5. Decisions, assumptions, and questions

### Adopted decisions

| ID | Concrete decision | Rationale and impact |
| --- | --- | --- |
| D-01 | Use the official `mongodb` Node driver directly, exposed through a small Nest provider. No Mongoose or TypeORM. | Chosen in the interview. Direct control over write concern, indexes, E11000 handling and later atomic claims. |
| D-02 | Phase 1 inserts the full initial document: `_id` (ObjectId), `idempotencyKey`, `patientId`, `type`, `data`, `ts` (BSON Date), `receivedAt` (BSON Date, server time), `status: 'pending'`, `attempts: 0`, `nextAttemptAt` (= `receivedAt`). It creates only the unique `idempotencyKey` index. | Chosen in the interview. Records are immediately claimable by Phase 3 without a backfill. The other indexes stay in Phase 2. |
| D-03 | Idempotency key = lowercase hex SHA-256 of canonical JSON of `{ data, patientId, ts, type }`. Object keys are sorted recursively at every depth, array order is preserved, `ts` is rendered as `Date.toISOString()` (UTC, exactly 3 fraction digits), no whitespace, and strings get no Unicode normalization. | PLAN G1. Formatting differences (key order, offset notation, fraction length) don't create new events. Identical content from separate real events is merged (documented trade-off, G1). |
| D-04 | Mongo timeouts are code constants: `serverSelectionTimeoutMS: 5000` on the client, and `writeConcern: { w: 'majority', wtimeoutMS: 5000 }` on the insert. | Chosen in the interview (503 with a bounded timeout). Constants rather than env vars keep the configuration surface unchanged. They can be promoted to env vars later. |
| D-05 | Unknown top-level fields are rejected with `400` (`whitelist: true, forbidNonWhitelisted: true`). Keys inside `data` are free-form. | Chosen in the interview. Nothing outside the hash is stored, so no content is silently lost or merged. |
| D-06 | `patientId` and `type` are never trimmed or otherwise normalized. Empty or whitespace-only values are rejected. Lengths are counted in UTF-16 code units (`String.prototype.length`). | Chosen in the interview. Identifiers come from systems and must not be changed silently. |
| D-07 | At module init the app connects to Mongo and creates the unique index. If either fails, bootstrap throws and the process exits non-zero. | Chosen in the interview. Events are never accepted without dedup enforced. Compose `restart: unless-stopped` handles recovery. |
| D-08 | No authentication in this deliverable. | Chosen in the interview. Not in PLAN scope. Recorded as a known limit (deploy behind a gateway or mTLS). |
| D-09 | Integration and e2e tests use `mongodb-memory-server` as a single-node replica set (`MongoMemoryReplSet`, one member) pinned to MongoDB 7.0.x, with a fresh database per test file. | Chosen in the interview. Real replica-set semantics without Docker, and matches the Compose image. |
| D-10 | `ts` accepts only the profile `YYYY-MM-DDTHH:mm:ss[.fraction](Z\|±HH:mm)`. The `T` and `Z` are uppercase, the fraction has 1–9 digits, the date and time must exist on the calendar (no Feb 30, no hour 24, no second 60), the offset is from −23:59 to +23:59, and the resulting UTC instant must fall in years 1970–9999. Fractions beyond milliseconds are truncated (not rounded). | Chosen in the interview (strict RFC 3339 profile). Predictable canonicalization. |
| D-11 | Store errors map to `503 { statusCode: 503, message: 'Event store unavailable, retry later', error: 'Service Unavailable' }`. This covers server selection or network errors, a not-connected client, write-concern errors or timeouts, and driver errors labelled `RetryableWriteError` or `TransientTransactionError`. Every other unexpected error stays Nest's default `500`. | Chosen in the interview. Tells senders that retrying is safe. Content hashing makes the retry idempotent. |
| D-12 | On E11000 for `idempotencyKey`, the existing document is read by `idempotencyKey` with `readConcern: 'majority'` from the primary. If it isn't visible yet (the first writer's majority write is still pending), the read is retried up to 5 times, 100 ms apart. If it is still not visible, respond `503` (D-11 body). | Resolved from P4. A duplicate must never be acknowledged unless the original is durable. On a single-node replica set the first read normally succeeds. |
| D-13 | Validation errors use Nest's default `BadRequestException` shape `{ statusCode: 400, message: string[], error: 'Bad Request' }` with the exact messages in section 7. | Consistent with the Nest defaults already in the project. Message strings are fixed so senders and tests can rely on them. |
| D-14 | Logging: neither request bodies nor `patientId`, `type`, `ts` or `data` are ever logged. A `503` logs one `warn` line with the driver error class name and code only. Accepts and duplicates log nothing. | The payloads are clinical data (RNF-03). |
| D-15 | `202` response body is exactly `{ id, status, duplicate }`. `id` is the stored `_id` as a 24-character lowercase hex string, and `status` is the stored document's current `status`. There is no `Location` header. | PLAN G8. |
| D-16 | A malformed JSON body on `POST /events` returns `400 { statusCode: 400, message: 'Malformed JSON body', error: 'Bad Request' }`. The parser's message is replaced, never passed through. | Chosen in the interview (2026-11-02, after plan-spec found that Express/body-parser `SyntaxError` messages quote body fragments). Keeps RNF-03 consistent. |
| D-17 | When D-12 retries run out, the `503` `warn` log line carries the fixed label `DuplicateNotVisible` in place of a driver error class name and code. There is no payload and no idempotency key. | Resolved from D-14: in this path no driver error exists to name. |

### Assumptions to verify

| Assumption | Available evidence | Confirmation / effect if false |
| --- | --- | --- |
| MongoDB 7.0 with the current `mongodb` driver accepts `data` keys that start with `$` or contain `.` on `insertOne` (driver `checkKeys` defaults to false). | MongoDB ≥ 5.0 permits such field names. Not yet confirmed against this driver version. | CA-14 confirms it. If inserts fail, return to `/create-spec` to decide between rejecting with 400 and escaping. Do not decide this during implementation. |
| `mongodb-memory-server` can download and run a MongoDB 7.0.x binary on the developer's platform (darwin) and in CI. | Unconfirmed. | The first `npm run test:e2e` confirms it. If it fails, that is an implementation blocker to report, not a reason to switch test infrastructure silently. |
| Express's default JSON body limit (100 kb) applies, because `NestFactory.create` uses the default body parser. | `src/main.ts` doesn't configure the body parser. | CA-11 confirms it (oversized body → 413). |

### Open questions

None blocking. Non-blocking follow-ups for later phases: promote the Mongo timeouts to env vars if operations need tuning (D-04); add authentication (D-08).

## 6. User journey and states

### Preconditions and entry

- The service is running and connected to a MongoDB replica set. The unique `idempotencyKey` index exists (D-07).
- The sender sends `POST /events` with `Content-Type: application/json`. No credentials are required (D-08).

### Main flow

1. The sender POSTs `{ "patientId": "p-1", "type": "vitals", "ts": "2026-11-02T10:00:00-03:00", "data": { "hr": 72 } }`.
2. The service validates the body, normalizes `ts` to a UTC Date, computes the idempotency key and inserts the initial document with `w: 'majority'`.
3. Once Mongo confirms the write, the service responds `202 { "id": "<24-hex>", "status": "pending", "duplicate": false }`.

### Alternatives and exceptions

- Duplicate (sequential or concurrent): same canonical content → `202 { id: <original>, status: <current>, duplicate: true }`. No new document.
- Equivalent formatting: different key order inside `data`, or the same instant written in another offset or fraction length (`…13:00:00Z` vs `…10:00:00.000-03:00`), counts as a duplicate.
- Validation failure → `400` with messages. Nothing is written.
- Malformed JSON → `400`. Nothing is written.
- Body over 100 kb → `413`. Nothing is written.
- Store unavailable or write not confirmed in time → `503`. The sender retries, and the retry is idempotent.
- Mongo unreachable at startup → the process exits non-zero and Compose restarts it. No requests are served.

| State | Trigger | Response and permitted actions | Exit condition |
| --- | --- | --- | --- |
| Accepted (new) | Valid, unseen content, majority write confirmed | `202 { id, status: 'pending', duplicate: false }` | Document stored with `status: 'pending'` |
| Accepted (duplicate) | Valid content whose key already exists and is majority-visible | `202 { id, status, duplicate: true }` | No write |
| Rejected (invalid) | DTO validation fails, unknown field, or malformed JSON | `400` (section 7) | Sender corrects the request |
| Rejected (too large) | Body > 100 kb | `413` | Sender reduces the payload |
| Unavailable | D-11 errors, or D-12 retries exhausted | `503` with the fixed body | Sender retries later |

## 7. Functional requirements and contracts

### RF-01 — Accept events at `POST /events`

- Trigger: an HTTP `POST /events` request with a JSON body.
- Rules: validate (RF-02) → compute the key (RF-03) → persist (RF-04).
- Output: `202` with the D-15 body, `Content-Type: application/json`.
- Exceptions: `400` (RF-02), `413` (oversized), `503` (RF-06).
- Side effects: at most one document inserted into `events`. Nothing is logged about the payload (D-14).

### RF-02 — Validate the request body

- Trigger: every `POST /events`.
- Rules: the table below, plus D-05 (unknown top-level fields are rejected). A body that isn't a JSON object (array, primitive, missing or non-JSON content type) fails validation because the required fields are absent.
- Output on failure: `400 { statusCode: 400, message: [...], error: 'Bad Request' }`. `message` contains one entry for each violated rule; for each field, only the first failing rule in the table's order is reported. Message order across fields is not part of the contract.
- Malformed JSON: `400 { statusCode: 400, message: 'Malformed JSON body', error: 'Bad Request' }` (D-16). The body parser's own error text is never returned, because it quotes fragments of the body.
- Side effects: none. No write, no log.

#### Data and validation

| Field | Type | Normalization | Rules and limits (in evaluation order) | Exact message |
| --- | --- | --- | --- | --- |
| `patientId` | string, required | none (D-06) | 1. present and a string · 2. `trim()` not empty · 3. `length ≤ 128` | 1. `patientId must be a string` · 2. `patientId must not be blank` · 3. `patientId must be at most 128 characters` |
| `type` | string, required | none (D-06) | 1. present and a string · 2. `trim()` not empty · 3. `length ≤ 64` | 1. `type must be a string` · 2. `type must not be blank` · 3. `type must be at most 64 characters` |
| `ts` | string, required | parsed to a UTC Date and truncated to ms (D-10) | present, a string, matches the D-10 profile, a valid calendar instant within 1970–9999 UTC | `ts must be an ISO 8601 date-time with a timezone offset` |
| `data` | JSON object, required | none (stored as received) | present, not `null`, not an array, a plain object. `{}` is allowed. Nested content is free-form. | `data must be a JSON object` |
| any other top-level key `k` | — | — | rejected | `property k should not exist` |

- Boundaries: `patientId` with 128 characters is accepted and with 129 rejected. `type` with 64 is accepted and with 65 rejected. `'   '` is blank. Non-ASCII text is allowed and counted in UTF-16 code units. `ts` without seconds, without an offset, in lowercase, or as a date only is rejected. `2026-02-30T…` is rejected.
- Source of truth: the DTO class with class-validator decorators (and one custom `ts` validator). There are no duplicate rule sets elsewhere.

### RF-03 — Compute the idempotency key

- Trigger: after validation succeeds.
- Rules: D-03 exactly. The input object is `{ data, patientId, ts: <toISOString of normalized ts>, type }`, serialized with recursively sorted keys and hashed with SHA-256 as lowercase hex (64 characters).
- Output: the `idempotencyKey` string, stored on the document.
- Properties that must hold:
  - Key order at any depth of `data` doesn't change the key.
  - The same instant written with different offsets, or with fractions that truncate to the same millisecond, gives the same key.
  - A change in any value (including array order, or `1` vs `"1"`) gives a different key.

### RF-04 — Persist durably and deduplicate

- Trigger: a valid request with a computed key.
- Rules:
  - `insertOne` the D-02 document into the `events` collection with `writeConcern: { w: 'majority', wtimeoutMS: 5000 }`.
  - `_id` is a new ObjectId. `receivedAt` and `nextAttemptAt` are the same server `Date`. `status: 'pending'`, `attempts: 0`. `data` and `patientId`/`type` are stored exactly as validated, and `ts` is a BSON Date.
  - On E11000 (duplicate key on `idempotencyKey`), apply D-12 and respond with `duplicate: true` plus the stored `_id` and `status`. Never modify the existing document.
- Output: D-15.
- Exceptions: D-11 errors → RF-06.
- Side effects: exactly one document per idempotency key, enforced by the unique index, including under concurrent requests.

### RF-05 — Database connection and index lifecycle

- Trigger: application bootstrap and shutdown.
- Rules:
  - Create one `MongoClient` from `MONGO_URI` with `serverSelectionTimeoutMS: 5000` and connect it during module init.
  - Use the database named in the URI and the collection `events`.
  - Run `createIndex({ idempotencyKey: 1 }, { unique: true, name: 'idempotencyKey_unique' })` before the app starts listening.
  - If the connection or index creation fails, init rejects (D-07).
  - On `app.close()`, close the client.
- Output: a ready collection handle injected into the events service.
- Exceptions: an unreachable Mongo at startup makes bootstrap reject within about 5 s plus overhead.

### RF-06 — Map store unavailability to 503

- Trigger: any D-11 error during the insert or the duplicate read, or D-12 retries exhausted.
- Output: `503 { statusCode: 503, message: 'Event store unavailable, retry later', error: 'Service Unavailable' }`.
- Side effects: one `warn` log line with the driver error class name and code (D-14), or the label `DuplicateNotVisible` when D-12 retries run out (D-17). A `202` is never sent for that request.

### Integrations

| Operation | Confirmed contract | Success | Failures and recovery |
| --- | --- | --- | --- |
| MongoDB `insertOne` on `events` | `mongodb` driver, `writeConcern { w: 'majority', wtimeoutMS: 5000 }`, retryable writes on (driver default) | Acknowledged → `202 duplicate:false` | E11000 → D-12. D-11 errors → `503`. |
| MongoDB `findOne({ idempotencyKey })` | `readConcern: 'majority'`, `readPreference: 'primary'`, projection `{ _id, status }` | Found → `202 duplicate:true` | Not found → retry (D-12) → `503`. D-11 errors → `503`. |
| MongoDB `createIndex` | Unique on `idempotencyKey`, name `idempotencyKey_unique` | Index present | Failure → bootstrap rejects (D-07). |

### Content and actions

Not applicable: an HTTP API with no UI controls. The response copy that matters is fixed in RF-02, RF-06 and D-15.

## 8. Non-functional requirements

### RNF-01 — Visual design, responsiveness, and themes

Not applicable: backend-only API, no user interface.

### RNF-02 — Accessibility

Not applicable: no user interface. The API returns machine-readable JSON with stable messages.

### RNF-03 — Privacy and security

- Sensitive data: `patientId` and `data` are clinical data. They flow only from the request to the `events` collection.
- Persistence: stored indefinitely in `events` (PLAN: nothing is deleted). No other copies.
- Logs: per D-14, never the body, `patientId`, `type`, `ts`, `data` or the idempotency key. Only the error class name and code on `503`.
- Error responses never echo payload values, including on malformed JSON (D-16). Validation messages name the field, not its value (`property k should not exist` echoes only the key name sent by the client).
- Trust boundary: no authentication (D-08). Validation runs server-side.

### RNF-04 — Quality, performance, and compatibility

- Environment: Node 24 (Dockerfile `node:24-alpine`, local v24.21.0), MongoDB 7.0 replica set.
- Performance: no throughput target in this phase (Phase 6 measures 1000/min). Bounded latency under store failure: a `503` within 5 s of server selection or write-concern timeout plus overhead (CA-12 allows ≤ 15 s in tests).
- Reliability: no `202` without a majority-acknowledged write (RF-04, D-12). Exactly one document per key under concurrency (CA-07).
- Dependencies: add `mongodb` (runtime) and `mongodb-memory-server` (dev). Keep `package-lock.json` consistent via `npm install`.
- Code style: ESM `.js` import suffixes, Prettier and oxlint as configured, comment density matching the existing files.

## 9. Technical guidelines and impact

- Applicable instructions: `AGENTS.md` (Observe telemetry not in scope). There is no `CLAUDE.md`.
- Observed stack: NestJS 12, class-validator 0.15, class-transformer 0.5, TypeScript 6, vitest 4, supertest 7, ESM.
- New dependencies: `mongodb` (pin to the current major compatible with MongoDB 7.0), `mongodb-memory-server` (dev).
- Architecture:
  - `DatabaseModule` owns the `MongoClient` lifecycle and index creation, and exports the `events` collection provider.
  - `EventsModule` has the controller (HTTP and validation), a service (key, insert, duplicate read) and the error mapping.
  - Canonical hashing is a pure function, unit-testable without Mongo.
- Reuse: `ConfigService<EnvironmentVariables, true>` for `MONGO_URI`. The existing vitest configs. The e2e pattern in `test/app.e2e-spec.ts`.
- Constraints: no Mongoose or TypeORM (D-01). No new env vars (D-04). No changes to the worker-related configuration semantics. Don't add the claim or read-order indexes (Phase 2).

| File/area | Current state | Expected change | Risk/regression |
| --- | --- | --- | --- |
| `package.json`, `package-lock.json` | No Mongo libraries | Add `mongodb`, dev `mongodb-memory-server` | Lockfile drift. Use `npm install`. |
| `src/app.module.ts` | Config + Health | Import the database and events modules | Boot now requires Mongo (D-07) |
| `src/database/` (suggested) | Absent | Client provider, init and index creation, close on shutdown | Startup failure modes |
| `src/events/` (suggested) | Absent | DTO, `ts` validator, canonical hash, service, controller, 503 mapping | Core behaviour |
| `src/main.ts` | No pipes | Possibly a global `ValidationPipe` (or scoped to the controller) | Must not change `/health` |
| `test/app.e2e-spec.ts` | Boots AppModule without Mongo | Provide an in-memory Mongo via `MONGO_URI` | `/health` test must still pass |
| `test/events.e2e-spec.ts` (suggested) | Absent | Scenario tests from section 11 | Test runtime (binary download on the first run) |
| `src/events/*.spec.ts` (suggested) | Absent | Unit tests for the hash and DTO | — |
| `README.md` | No `/events` docs | Short `POST /events` section: request, 202/400/413/503, note on missing auth | — |

## 10. Traceable acceptance criteria

| ID | Given / when | Then, observable | Requirement |
| --- | --- | --- | --- |
| CA-01 | Empty `events` collection. POST a valid event. | `202`, body has exactly the keys `id` (24 lowercase hex), `status: 'pending'`, `duplicate: false`. One document exists with `_id` = id. | RF-01, RF-04, D-15 |
| CA-02 | After CA-01, read the stored document. | Fields are exactly `_id, idempotencyKey (64 hex), patientId, type, data, ts (Date = normalized ts), receivedAt (Date), status 'pending', attempts 0, nextAttemptAt (= receivedAt)`. `patientId`, `type` and `data` are deep-equal to the request. | D-02, RF-04 |
| CA-03 | After CA-01, POST the identical body again. | `202 { id: <same>, status: 'pending', duplicate: true }`. The collection still has 1 document, unchanged. | RF-04, D-12 |
| CA-04 | POST a body, then POST the same event with the `data` keys reordered (including nested objects) and `ts` written in another offset, with a fraction that truncates to the same millisecond. | The second response is `duplicate: true` with the same id. 1 document. | RF-03, D-03, D-10 |
| CA-05 | POST two events differing only in one of: an array order inside `data`, `1` vs `"1"` in `data`, `ts` by 1 ms, `patientId` `'p1'` vs `' p1'`. | Each pair gives two documents with different `idempotencyKey`, both `duplicate: false`. | RF-03, D-06 |
| CA-06 | Unit: canonical hash function. | Same key for reordered keys at depth ≥ 2 and for equivalent `ts` renderings. Different key for any value change. Output matches `/^[0-9a-f]{64}$/`. | RF-03, D-03 |
| CA-07 | Empty collection. Send 20 identical valid POSTs concurrently. | All 20 respond `202` with the same `id`. Exactly 1 has `duplicate: false` and 19 have `duplicate: true`. The collection has exactly 1 document. | RF-04, RNF-04 |
| CA-08 | POST bodies violating each rule in the RF-02 table: missing or non-string `patientId`/`type`, blank `'   '`, 129-character `patientId`, 65-character `type`, `data` as `null`/array/string/missing, the `ts` variants (no offset, no seconds, date only, lowercase `t`/`z`, `2026-02-30T00:00:00Z`, `T24:00:00Z`, `:60` seconds, year 1969 UTC, non-string). | Each gives `400`, `error: 'Bad Request'`, and `message` contains the exact RF-02 string for the violated rule. The collection stays empty. | RF-02, D-06, D-10, D-13 |
| CA-09 | Boundary values: 128-character `patientId`, 64-character `type`, `data: {}`, non-ASCII `patientId`, `ts` with 9 fraction digits and a `+05:30` offset. | Each gives `202 duplicate:false`. The stored `ts` equals the truncated UTC millisecond instant. | RF-02, D-06, D-10 |
| CA-10 | POST a valid event plus an extra top-level `source: 'x'`. POST a non-object body (`[]`). POST malformed JSON bodies `{"a":` and `{"patientId":p-secret-123}`. | `400` with message `property source should not exist`. `400` for the array. For both malformed bodies, exactly `400 { statusCode: 400, message: 'Malformed JSON body', error: 'Bad Request' }`, and the response text doesn't contain `secret`. The collection stays empty. | RF-02, D-05, D-16, RNF-03 |
| CA-11 | POST a valid-shaped body larger than 100 kb. | `413`. The collection stays empty. | RF-01, RNF-04 |
| CA-12 | App initialised against the in-memory replica set, which is then stopped. POST a valid event. | `503 { statusCode: 503, message: 'Event store unavailable, retry later', error: 'Service Unavailable' }` within 15 s. No `202`. | RF-06, D-04, D-11 |
| CA-13 | Inspect driver command monitoring during CA-01, and `listIndexes` on `events`. | The `insert` command carries `writeConcern.w === 'majority'`. The index `idempotencyKey_unique` exists with `unique: true` on `{ idempotencyKey: 1 }`. No other non-`_id` index exists. | RF-04, RF-05, D-02 |
| CA-14 | POST `data: { "$set": 1, "a.b": 2 }`. | `202 duplicate:false`. The stored `data` deep-equals the input. | RF-04, assumption in §5 |
| CA-15 | `MONGO_URI` points to an unreachable port (for example `mongodb://127.0.0.1:1/x?directConnection=true`). Initialise AppModule. | `app.init()` rejects within 15 s. No HTTP server is served. | RF-05, D-07 |
| CA-16 | Run the full e2e suite. | `GET /health` → `200 { status: 'ok' }`. The existing unit tests pass. | Preserve |
| CA-17 | During CA-01, CA-08 and CA-12, capture logger output. | No log line contains the sent `patientId`, `type`, `ts`, `data` values or the idempotency key. CA-12 produces exactly one `warn` line containing the error class name. | RNF-03, D-14 |
| CA-18 | `npm run lint` and `npm run build`. | Both exit 0. | RNF-04 |

## 11. QA and evidence

All of the following are planned. None have run yet.

| Area/criteria | Setup and procedure | Expected result | Evidence |
| --- | --- | --- | --- |
| Accept new event (CA-01, CA-02, CA-13) | e2e: `MongoMemoryReplSet` (1 member, 7.0.x), AppModule with `MONGO_URI` set to it, `monitorCommands` on the client or a command listener; fictional data `p-test-1` | 202 body; document shape; `insert` writeConcern majority; index list | vitest e2e output; assertions on the DB state and the captured command |
| Duplicates, sequential and equivalent (CA-03, CA-04) | e2e, same setup | `duplicate: true`, same id, count 1 | vitest e2e output + `countDocuments` |
| Distinct content (CA-05) | e2e | 2 documents per pair | vitest e2e output |
| Canonical hash (CA-06) | unit, no Mongo | Deterministic keys | `npm test` output |
| Concurrency (CA-07) | e2e, `Promise.all` of 20 supertest POSTs | 1 new, 19 duplicates, 1 document | vitest e2e output |
| Validation rejection (CA-08, CA-10) | e2e table-driven (`it.each`) + DTO unit tests | Exact messages, empty collection | vitest output |
| Boundaries (CA-09, CA-14) | e2e | 202 and stored values | vitest output + DB reads |
| Oversized payload (CA-11) | e2e, about 150 kb `data` string | 413 | vitest output |
| Store failure (CA-12) | e2e: stop the replica set after init, POST | 503 body within 15 s | vitest output with a timeout of at least 20 s |
| Startup failure (CA-15) | e2e: unreachable `MONGO_URI` | `init()` rejects | vitest output |
| Privacy in logs (CA-17) | Spy on the Nest `Logger` / `console` during the scenarios | No payload values; one warn on 503 | vitest output |
| Regression (CA-16) | `npm test`, `npm run test:e2e` | All pass | command output |
| Technical quality (CA-18) | `npm run lint`, `npm run build` | Exit 0 | command output |

- Not applicable here:
  - Authentication and authorization failures (D-08, out of scope).
  - Ordering: this phase only stores `ts`. Read order is Phase 2/6.
  - Worker retry and recovery: Phases 3–4.
  - Emitted events and metrics: none produced.
- Multi-node replica-set failover is not reproducible with a single-node in-memory set. It is covered indirectly by CA-12 (an error class mapped to 503) and by the driver's retryable writes. Phase 6 chaos testing covers container kills.
- Manual QA (optional, planned): with `docker compose up --build`, `curl -i -XPOST localhost:3000/events -H 'content-type: application/json' -d '{"patientId":"p-demo","type":"vitals","ts":"2026-11-02T10:00:00Z","data":{"hr":72}}'` twice. Expect 202 with `duplicate:false`, then 202 with `duplicate:true`.
- Record: the environment (Node version, mongodb-memory-server MongoDB version) and the pass/fail/blocked status per CA in the implementation report.

## 12. Definition of done and delivery

- [ ] No blocking decisions or required placeholders remain.
- [ ] RF-01 to RF-06 implemented and CA-01 to CA-18 verified with actual results.
- [ ] Negative scenarios covered: validation, malformed, oversized, store down, startup failure, concurrency.
- [ ] Responsiveness, themes and accessibility: not applicable (no UI).
- [ ] Data, logs and persistence comply with D-02, D-14 and RNF-03.
- [ ] `npm test`, `npm run test:e2e`, `npm run lint` and `npm run build` executed, with any limitations declared.
- [ ] Changes limited to scope. `package.json` and `package-lock.json` are consistent.
- [ ] README has the `POST /events` section, including the missing-auth note.

Expected artifact: code, tests and a README section in this repository.
External actions/publication: none. Commits only when the user requests them.

## 13. References and consistency review

- `PLAN.md`: P1–P4, G1, G8, G12 and the Phase 1/2 boundaries define scope and contracts.
- `src/config/env.validation.ts`, `src/main.ts`, `src/app.module.ts`, `src/health/*`: the current stack and behaviour to preserve.
- `docker-compose.yml`, `Dockerfile`: the Mongo 7.0 replica set, restart policy and Node 24.
- `test/app.e2e-spec.ts`, `vitest.config*.ts`: the existing test patterns.
- `README.md`: the current documentation surface.
- `AGENTS.md`: telemetry guidance (not applied in this phase).
- The interview answers of 2026-11-02 (D-01, D-02, D-04/D-11, D-05, D-06, D-07, D-08, D-09, D-10, D-16).
- The plan-spec BLOCKED report of 2026-11-02, which found the malformed-JSON echo conflict (resolved by D-16) and the missing `503` log content for D-12 (resolved by D-17).

Consistency review: every RF and the D-decisions that affect behaviour map to at least one CA. Section 2 lists the observed facts, section 5 lists the decisions and assumptions, and section 11 lists the planned (not executed) QA.
