# Events data model — the `events` collection has its complete document type and the claim and read-order indexes

## 1. Status and reading contract

- Status: implemented and verified.
- Updated: 2026-11-02.
- Assessment: [`.ai/.assessments/events-data-model.md`](../.assessments/events-data-model.md) (PASS, 2026-11-02).
- Decision owner: repository owner (decisions recorded from the create-spec interview of 2026-11-02).
- Affected areas/routes: `src/events/event.document.ts`, `src/database/database.module.ts`, a new read-order query helper in `src/events/`, `test/events.e2e-spec.ts` (index assertion), a new e2e test file for the data model. No HTTP route is added or changed.
- Audience: the Phase 3–4 worker code (claims, completion, retries and lease reclaim) and the Phase 6 verification script, which read and write this model. Indirectly, evaluators checking that order is rebuilt at read time (PLAN P7).
- Deliverable type: integrated backend change (persistence model and indexes). No frontend.
- Related or superseded document: `PLAN.md` Phase 2, decisions G2, G4, G5 and §3 (claim query). It builds on `.ai/.specs/events-ingest-path.md` (Phase 1, implemented and verified) and supersedes only that spec's CA-13 clause "No other non-`_id` index exists" (see D-09).
- Convention: `RF-xx` for functional requirements; `RNF-xx` for quality requirements; `D-xx` for decisions; `CA-xx` for acceptance criteria.

This spec describes the desired state. Nothing in it has been implemented or verified yet. All requirements are mandatory unless explicitly marked optional.

## 2. Context and problem

Phase 1 stores each event with its initial fields and a unique `idempotencyKey` index. The worker (Phase 3) will claim due pending events oldest first, and consumers will rebuild each patient's sequence by sorting on `ts` (PLAN G2). Without a claim index, every claim at 100 concurrent workers per process scans the collection. Without a read-order index, every patient read sorts in memory. The fields the worker writes (`lockedUntil`, `workerId`, `result`, `lastError`, `processedAt`) have no agreed types, so Phases 3–6 would each guess.

### Evidence and current state

| Verifiable reference | Observed fact | Implication |
| --- | --- | --- |
| `src/events/event.document.ts` | `EventDocument` has `_id, idempotencyKey, patientId, type, data, ts, receivedAt, status, attempts, nextAttemptAt`. `EventStatus = 'pending' \| 'processing' \| 'done' \| 'failed'`. | Add the five processing fields as optional (D-03). Keep the existing fields and status union unchanged. |
| `src/database/database.module.ts` | `onModuleInit` connects, then `createIndex({ idempotencyKey: 1 }, { unique: true, name: 'idempotencyKey_unique' })`. Errors propagate and stop bootstrap (Phase 1 D-07). | Create the two new indexes in the same place with the same failure semantics (D-06). |
| `src/events/events.service.ts` | Inserts `{ …, status: 'pending', attempts: 0, nextAttemptAt: receivedAt }` with `w: 'majority'`. No processing fields are written. | Pending documents already match D-03 (fields absent). No change to the insert. |
| `test/events.e2e-spec.ts` lines 113–119 | Asserts the index names are exactly `['_id_', 'idempotencyKey_unique']`. | This assertion must be updated to the new set (D-09). |
| `test/support/mongo.ts`, `test/support/app.ts` | `startMongo(dbName)` starts a one-member `MongoMemoryReplSet` pinned to 7.0.45. `createTestApp({ mongoUri })` boots AppModule the way `main.ts` does. | Reuse them for the new e2e tests. |
| `package.json` | `mongodb` ^7.8.0, `mongodb-memory-server` ^11.3.0, vitest 4. Scripts: `test`, `test:e2e`, `lint`, `build`. | No new dependencies. |
| `src/config/env.validation.ts` | `WORKER_CONCURRENCY` defaults to 100 and `LEASE_MS` to 30000. | Bounds the number of `processing` documents, which is the basis for D-01. |
| `PLAN.md` §3 | Claim: `findOneAndUpdate({ status: pending, nextAttemptAt <= now })` sorted by `nextAttemptAt`. Expired leases are reclaimed by also matching `status: processing, lockedUntil < now`. | The claim index serves the pending branch. The reclaim branch is covered by D-01. |
| `docker-compose.yml` | Mongo data lives in the `mongo-data` volume, so a Compose database may already hold Phase 1 documents. | Index creation must succeed on a non-empty collection, and existing documents need no migration (D-03, CA-07). |
| `AGENTS.md` | Optional NestJS Observe telemetry. `ObserveModule` isn't registered. | Not applicable to this phase. |

Missing: the processing-field types, the claim index, the read-order index, and a single definition of the patient read order.

## 3. Objective and expected outcome

- Product outcome: at startup the app ensures exactly three secondary indexes on `events`: the existing unique `idempotencyKey_unique`, plus `claim_status_nextAttemptAt` on `{ status: 1, nextAttemptAt: 1 }` and `patient_read_order` on `{ patientId: 1, ts: 1, receivedAt: 1, _id: 1 }`. `EventDocument` describes every field from PLAN Phase 2 with fixed types. `findPatientEvents(collection, patientId)` returns one patient's events in `ts`, then `receivedAt`, then `_id` order, served by the read-order index.
- Verifiable success signal: e2e tests against the in-memory 7.0 replica set show the exact index list and options, `explain()` plans that use each index with no in-memory `SORT` stage, the order returned for crafted ties and late events, idempotent and concurrent startup, and the startup failure on a conflicting index (section 11).
- Limits of the claim: this phase doesn't write the processing fields (Phases 3–4), doesn't measure claim contention under load (Phase 6), and doesn't prove the field invariants in D-04 (they become a contract that Phase 3–4 tests must verify). An `explain()` on a small test collection shows that the planner picks the index, not that performance holds at production volume.

## 4. Scope

### Included

- Optional processing fields on `EventDocument` with the D-03/D-05 types, plus an exported `EventError` type (RF-01).
- Creating the claim and read-order indexes at startup, next to the unique index (RF-02).
- `PATIENT_READ_ORDER` (sort spec) and `findPatientEvents` (RF-03).
- Updating the Phase 1 index assertion, and new e2e tests for every scenario in section 11.

### Out of scope

- Any code that writes `lockedUntil`, `workerId`, `result`, `lastError` or `processedAt`, and the claim, completion, retry and reclaim queries themselves: Phases 3–4.
- An index for the lease-reclaim branch (D-01).
- A MongoDB `$jsonSchema` validator (D-02).
- Any HTTP read endpoint for patient events (D-07).
- `GET /stats` and the Mongo check in `GET /health`: Phase 5.
- README changes: the data model and indexes are documented in Phase 8 (D-10).
- Data migration or backfill (D-03 makes it unnecessary).

### Preserve

- `POST /events` behaviour, responses, the stored initial document shape (Phase 1 D-02, CA-02) and the `w: 'majority'` insert.
- The `idempotencyKey_unique` index: the same name, key and `unique: true`.
- Startup semantics: connect, then create indexes, and any failure rejects bootstrap (Phase 1 D-07).
- `GET /health` → `200 { status: 'ok' }`, all environment variables, the Dockerfile and docker-compose.
- All existing unit and e2e tests keep passing, apart from the one index-list assertion that D-09 updates.

## 5. Decisions, assumptions, and questions

### Adopted decisions

| ID | Concrete decision | Rationale and impact |
| --- | --- | --- |
| D-01 | The only claim index is `{ status: 1, nextAttemptAt: 1 }`, named `claim_status_nextAttemptAt`. No index on `lockedUntil`. | Chosen in the interview. At most `WORKER_CONCURRENCY` × replicas documents are `processing` at any time, so the `status` prefix already narrows the reclaim branch to a few hundred documents. Phases 3–4 check their real query with `explain()` and may propose an index through a new spec if it falls short. |
| D-02 | No MongoDB collection validator. The data model is enforced by the TypeScript type and tests. | Chosen in the interview. Avoids a schema mistake rejecting ingest writes, and keeps the startup privileges (no `collMod`) unchanged. |
| D-03 | `lockedUntil`, `workerId`, `result`, `lastError` and `processedAt` are optional and absent until set. Code that clears one (for example on return to `pending`) uses `$unset`, never `null`. | Chosen in the interview. Phase 1 inserts and CA-02 stay valid, and existing Compose documents need no backfill. "The field exists" always means "it is set". |
| D-04 | Field semantics (contract for Phases 3–4; not exercised in this phase): `lockedUntil: Date` and `workerId: string` are present only while `status: 'processing'`. `processedAt: Date` and `result` are present only when `status: 'done'`. `processedAt` is also set when `status: 'failed'`. `lastError` holds the most recent failed attempt and may be present in `pending` (waiting to retry) or `failed`. A successful completion leaves any earlier `lastError` in place as history. | Resolves how the PLAN fields relate to `status` so Phases 3–6 agree. Recorded in a doc comment on `EventDocument`. |
| D-05 | `result: Record<string, unknown>` (an opaque plain object produced by the Phase 3 processor). `lastError: EventError`, where `EventError = { code: string; message: string; at: Date }`. `code` is a fixed machine label (for example `timeout`, `simulated_failure`). `message` must never contain `patientId`, `type`, `ts`, `data` or the idempotency key. | Chosen in the interview. Failures can be counted by `code` for `/stats` and the Phase 6 report. The privacy rule follows Phase 1 D-14 / RNF-03. |
| D-06 | `onModuleInit` creates the indexes in this order: `idempotencyKey_unique` (unchanged), `claim_status_nextAttemptAt`, `patient_read_order`. None is unique, sparse, partial or TTL. Any failure, including an existing index with the same name and a different key or options, rejects bootstrap. Creation is idempotent: restarting against an existing database succeeds and changes nothing. | Same pattern and failure semantics as Phase 1 D-07. Events are never accepted unless the full index set is in place. |
| D-07 | The read path is a query helper with no HTTP route: an exported `PATIENT_READ_ORDER = { ts: 1, receivedAt: 1, _id: 1 }` and `findPatientEvents(collection, patientId)`, which returns a `FindCursor<EventDocument>` for `{ patientId }` sorted by `PATIENT_READ_ORDER`, with no projection or limit and every status included. It is exported from `src/events/` (suggested file `patient-events.ts`). | Chosen in the interview. The order is defined once (Phase 6 reuses it) and no clinical data is exposed without authentication. A cursor avoids loading an unbounded history into memory. It includes every status because a patient's history is all of its events (PLAN G4). |
| D-08 | `findPatientEvents` uses the collection's default read concern and read preference, and logs nothing. | Low-risk and reversible. Callers that need majority reads (Phase 6) can open the collection with those options. It returns clinical data, so logging is prohibited (RNF-03). |
| D-09 | The Phase 1 assertion in `test/events.e2e-spec.ts` changes to expect exactly `['_id_', 'claim_status_nextAttemptAt', 'idempotencyKey_unique', 'patient_read_order']`. The rest of Phase 1 CA-13 (majority insert, unique index key and flag) is kept. | Phase 1 CA-13 described the Phase 1 state. This spec deliberately extends the index set. |
| D-10 | No README changes in this phase. | PLAN Phase 8 owns architecture and decision documentation. Nothing in the user-facing HTTP contract changes. |
| D-11 | Index names and key specs are module-level constants in the code that creates them, so tests and later phases can refer to them by name. | Low-risk organisation choice. Avoids repeating string literals in tests. |

### Assumptions to verify

| Assumption | Available evidence | Confirmation / effect if false |
| --- | --- | --- |
| On MongoDB 7.0 the planner chooses `patient_read_order` for `find({ patientId }).sort(PATIENT_READ_ORDER)`, and `claim_status_nextAttemptAt` for `find({ status: 'pending', nextAttemptAt: { $lte: now } }).sort({ nextAttemptAt: 1 })`, with no `SORT` stage. | The equality prefix plus sort-key order matches the standard ESR rule. Not yet confirmed. | CA-04 and CA-05 confirm it. If the planner picks another plan on a small collection, the test may pass `hint` only to confirm the index can serve the query with no `SORT`, and must say so. If even a hinted plan sorts in memory, stop and return to `/create-spec`. |
| Two app instances calling `createIndex` with identical specs at the same time both succeed on 7.0. | MongoDB documents identical concurrent index builds as allowed. Unconfirmed here. | CA-08 confirms it. If it fails, that is a blocker to report. Do not add retries silently. |

### Open questions

None blocking. Non-blocking follow-ups: Phases 3–4 verify the D-04 invariants and check the reclaim query plan (D-01). Phase 8 documents the indexes (D-10).

## 6. User journey and states

### Preconditions and entry

- The app starts against a MongoDB replica set given by `MONGO_URI`. The `events` collection may be absent, empty, or already contain Phase 1 documents and indexes.
- Callers of `findPatientEvents` are in-process code (tests, and later the Phase 6 verification script). There are no HTTP clients.

### Main flow

1. Bootstrap connects the client (unchanged).
2. `onModuleInit` ensures `idempotencyKey_unique`, then `claim_status_nextAttemptAt`, then `patient_read_order`.
3. The app starts serving. `POST /events` behaves exactly as in Phase 1.
4. A caller runs `findPatientEvents(events, 'p-1')` and iterates the cursor. It gets every `p-1` event ordered by `ts`, then `receivedAt`, then `_id`, whatever the arrival order.

### Alternatives and exceptions

- Restart against a database that already has all three indexes: creation is a no-op and startup succeeds (CA-06).
- A collection that already has Phase 1 documents and only `idempotencyKey_unique`: the two indexes are built over the existing data and startup succeeds (CA-07).
- Two replicas starting at the same time: both succeed (CA-08).
- An index named `claim_status_nextAttemptAt` or `patient_read_order` already exists with a different key: startup rejects and the HTTP server never listens (CA-09). An operator must drop the conflicting index.
- Mongo unreachable at startup: unchanged from Phase 1 (its CA-15).
- `findPatientEvents` for an unknown patient: an empty cursor (CA-03).
- A late event (earlier `ts`, arrived later): sorted into its `ts` position (CA-03, PLAN G3).

| State | Trigger | Observable behaviour | Exit condition |
| --- | --- | --- | --- |
| Starting | Process boot | Connect, then create the 3 indexes in order. No HTTP listener yet. | All succeed → Ready. Any failure → Failed. |
| Ready | Index creation complete | `POST /events` as in Phase 1. Indexes listed exactly as in RF-02. | Shutdown |
| Failed | Connection or index error | `app.init()` / bootstrap rejects and the process exits non-zero. Compose restarts it. | Operator fixes Mongo or the conflicting index |

## 7. Functional requirements and contracts

### RF-01 — Complete `EventDocument` type

- Trigger: compile time.
- Rules: `EventDocument` keeps its ten required fields unchanged and adds these optional fields: `lockedUntil?: Date`, `workerId?: string`, `result?: Record<string, unknown>`, `lastError?: EventError`, `processedAt?: Date`. `EventError` is exported with `code: string`, `message: string`, `at: Date`. A doc comment states the D-04 semantics, the D-03 `$unset` rule and the D-05 privacy rule for `lastError.message`.
- Output: the types compile and are used by the `events` collection provider (already `Collection<EventDocument>`).
- Exceptions: none at runtime. No validator is added (D-02).
- Side effects: none. Inserts don't change.

#### Data model

| Field | BSON type | Present when | Written by |
| --- | --- | --- | --- |
| `_id` | ObjectId | always | Phase 1 insert |
| `idempotencyKey` | string (64 lowercase hex) | always | Phase 1 insert |
| `patientId` | string | always | Phase 1 insert |
| `type` | string | always | Phase 1 insert |
| `data` | object | always | Phase 1 insert |
| `ts` | Date (UTC ms) | always | Phase 1 insert |
| `receivedAt` | Date | always | Phase 1 insert |
| `status` | string: `pending` \| `processing` \| `done` \| `failed` | always | Phase 1 insert; Phases 3–4 |
| `attempts` | int (≥ 0) | always | Phase 1 insert (0); claim increments |
| `nextAttemptAt` | Date | always | Phase 1 insert (= `receivedAt`); retry backoff |
| `lockedUntil` | Date | only while `processing` | claim (Phases 3–4) |
| `workerId` | string | only while `processing` | claim (Phases 3–4) |
| `result` | object | only when `done` | completion (Phase 3) |
| `lastError` | object `{ code: string, message: string, at: Date }` | after any failed attempt | failure (Phase 3) |
| `processedAt` | Date | when `done` or `failed` | completion or final failure (Phase 3) |

### RF-02 — Ensure the index set at startup

- Trigger: `DatabaseModule.onModuleInit`, after `client.connect()`.
- Rules: create, in order and awaiting each one:
  1. `{ idempotencyKey: 1 }`, `{ unique: true, name: 'idempotencyKey_unique' }` (unchanged).
  2. `{ status: 1, nextAttemptAt: 1 }`, `{ name: 'claim_status_nextAttemptAt' }`.
  3. `{ patientId: 1, ts: 1, receivedAt: 1, _id: 1 }`, `{ name: 'patient_read_order' }`.
- Output: `listIndexes` on `events` returns exactly `_id_` and these three, with exactly these keys (and key order). Only `idempotencyKey_unique` has `unique: true`. None has `sparse`, `partialFilterExpression` or `expireAfterSeconds`.
- Exceptions: any rejected `createIndex` (connection loss, conflicting name or options) propagates and bootstrap rejects (D-06).
- Side effects: an index build on existing documents. No documents are modified.

### RF-03 — Read a patient's events in order

- Trigger: a call to `findPatientEvents(collection, patientId)`.
- Rules: `collection.find({ patientId }).sort(PATIENT_READ_ORDER)`, where `PATIENT_READ_ORDER = { ts: 1, receivedAt: 1, _id: 1 }` is exported and used, not copied. Exact string match on `patientId`, no normalization (consistent with Phase 1 D-06). Every status is included. No projection, no limit, no logging.
- Output: a `FindCursor<EventDocument>` that yields the documents in ascending `ts`. Ties on `ts` are broken by ascending `receivedAt`, and remaining ties by ascending `_id`.
- Exceptions: driver errors surface to the caller unchanged (there's no HTTP mapping, since there's no route).
- Side effects: none.

### Integrations

| Operation | Confirmed contract | Success | Failures and recovery |
| --- | --- | --- | --- |
| MongoDB `createIndex` × 3 | `mongodb` driver 7.x against server 7.0, the specs in RF-02 | Index present (or already present with an identical spec) | Rejection → bootstrap fails (D-06). Recovery: fix Mongo or drop the conflicting index, then restart. |
| MongoDB `find` + `sort` | `{ patientId }`, sort `PATIENT_READ_ORDER` | Cursor in read order, served by `patient_read_order` | Driver error passed to the caller |

### Content and actions

Not applicable: no UI and no HTTP response changes.

## 8. Non-functional requirements

### RNF-01 — Visual design, responsiveness, and themes

Not applicable: backend-only, no user interface.

### RNF-02 — Accessibility

Not applicable: no user interface.

### RNF-03 — Privacy and security

- Sensitive data: `patientId` and `data` are clinical data. The new indexes copy `patientId`, `ts` and `status` into index structures inside the same database. They create no new copy outside Mongo.
- `findPatientEvents` returns full clinical documents to in-process callers only. It is not reachable over HTTP (D-07) and logs nothing (D-08).
- `lastError.message` must never contain payload values or the idempotency key (D-05). Phase 3 enforces and tests this. This phase records it in the type's doc comment.
- Logs: this phase adds no log lines. Index-creation failures propagate as Nest bootstrap errors carrying the driver's message, which names indexes and keys, never document values.
- Trust boundary: unchanged (no authentication, Phase 1 D-08).

### RNF-04 — Quality, performance, and compatibility

- Environment: Node 24, MongoDB 7.0 replica set (Compose and `mongodb-memory-server` 7.0.45).
- Performance: no numeric target in this phase. The required property is structural: the claim and patient-read query shapes are served by an `IXSCAN` with no in-memory `SORT` (CA-04, CA-05). Throughput and claim contention are measured in Phase 6.
- Reliability: index creation is idempotent and safe across concurrently starting replicas (CA-06, CA-08). The startup index build over existing data adds startup time proportional to collection size. That is accepted, and the Compose app health check's `start_period` isn't changed.
- Write cost: each insert and status change now maintains three secondary indexes instead of one. Accepted, and measured in Phase 6.
- Dependencies: none added.
- Code style: ESM `.js` import suffixes, Prettier and oxlint as configured, comment density matching the existing files.

## 9. Technical guidelines and impact

- Applicable instructions: `AGENTS.md` (Observe telemetry not in scope). There is no `CLAUDE.md`.
- Observed stack: NestJS 12, `mongodb` ^7.8.0, TypeScript 6, vitest 4, `mongodb-memory-server` ^11.3.0 (MongoDB 7.0.45), ESM.
- New dependencies: none.
- Architecture: `DatabaseModule` keeps sole ownership of the client lifecycle and index creation. The read helper is a pure function over a `Collection<EventDocument>`, not a Nest provider (no consumer needs injection yet).
- Reuse: `EVENTS_COLLECTION` provider, `startMongo`, `createTestApp`, `CaptureLogger`.
- Constraints: no Mongoose, no collection validator, no new environment variables, no new routes. Don't change `EventsService` or the Phase 1 insert.

| File/area | Current state | Expected change | Risk/regression |
| --- | --- | --- | --- |
| `src/events/event.document.ts` | 10 required fields | Add 5 optional fields, `EventError`, and a doc comment (RF-01) | Type-only. No runtime change. |
| `src/database/database.module.ts` | Creates 1 index | Create 3 indexes in order with named constants (RF-02, D-11) | Startup failure on conflict. Extra write cost. |
| `src/events/patient-events.ts` (suggested) | Absent | `PATIENT_READ_ORDER`, `findPatientEvents` (RF-03) | — |
| `test/events.e2e-spec.ts` | Expects 2 index names | Expect 4 names (D-09) | Must stay otherwise unchanged |
| `test/events-data-model.e2e-spec.ts` (suggested) | Absent | Scenarios CA-02 to CA-09 | Test runtime (several replica sets) |

## 10. Traceable acceptance criteria

| ID | Given / when | Then, observable | Requirement |
| --- | --- | --- | --- |
| CA-01 | `npm run build` and `npm run lint`. A type-level check (for example a test file that assigns objects to `EventDocument`) compiles with a pending document without processing fields, and with a document that sets all five processing fields with the D-05 types. | Both commands exit 0. The type check compiles. | RF-01, D-03, D-05 |
| CA-02 | A fresh database. Initialise the app, then `listIndexes` on `events`. | Exactly 4 indexes: `_id_`; `idempotencyKey_unique` with key `{ idempotencyKey: 1 }` and `unique: true`; `claim_status_nextAttemptAt` with key `{ status: 1, nextAttemptAt: 1 }`; `patient_read_order` with key `{ patientId: 1, ts: 1, receivedAt: 1, _id: 1 }` (key order checked). The latter two have no `unique`, `sparse`, `partialFilterExpression` or `expireAfterSeconds`. | RF-02, D-01, D-06 |
| CA-03 | Insert documents directly for patients `p-a` and `p-b` (fictional) in shuffled order: distinct `ts`; two with equal `ts` and different `receivedAt`; two with equal `ts` and `receivedAt` and different `_id`; one late event (earliest `ts`, inserted last); mixed statuses including `failed`. Also POST two events via `POST /events`. Call `findPatientEvents` for `p-a`, for `p-b`, and for `p-none`. | `p-a` returns exactly its documents (all statuses) in `ts`, `receivedAt`, `_id` ascending order, with the late event first. `p-b`'s documents are never mixed in. The POSTed events appear in `ts` position. `p-none` returns an empty array. | RF-03, D-07, PLAN G2/G3 |
| CA-04 | With CA-03's data, `explain('queryPlanner')` on `findPatientEvents(…, 'p-a')`. | The winning plan contains an `IXSCAN` with `indexName: 'patient_read_order'` and no `SORT` stage. | RF-03, RNF-04 |
| CA-05 | Insert pending and processing documents with various `nextAttemptAt` values. `explain('queryPlanner')` on `find({ status: 'pending', nextAttemptAt: { $lte: new Date() } }).sort({ nextAttemptAt: 1 })`. | The winning plan contains an `IXSCAN` with `indexName: 'claim_status_nextAttemptAt'` and no `SORT` stage. The query returns only due pending documents in ascending `nextAttemptAt`. | RF-02, D-01, RNF-04 |
| CA-06 | Initialise the app, close it, and initialise it again on the same database. | The second init resolves. `listIndexes` is identical to CA-02. The document count is unchanged. | D-06 |
| CA-07 | A database with Phase 1-shaped documents and only `idempotencyKey_unique` created manually. Initialise the app. | Init resolves. CA-02's index set holds. The existing documents are unchanged (deep-equal before and after) and returned by `findPatientEvents`. A duplicate `POST /events` of an existing document's content still returns `duplicate: true`. | D-03, D-06, Preserve |
| CA-08 | A fresh database. Initialise two app instances concurrently (`Promise.all`). | Both inits resolve and CA-02's index set holds. | D-06, RNF-04 |
| CA-09 | A database where an index named `patient_read_order` already exists with key `{ patientId: 1 }`. Initialise the app. Repeat with `claim_status_nextAttemptAt` on key `{ status: 1 }`. | Each `app.init()` rejects, and the pre-existing index remains as it was. | D-06, RF-02 |
| CA-10 | Run the full existing suites with the D-09 update. | All Phase 1 unit and e2e tests pass, including CA-01–CA-18 of `events-ingest-path`, with the index-list assertion now expecting the 4 names. `GET /health` → `200 { status: 'ok' }`. | Preserve, D-09 |
| CA-11 | Capture logger output during CA-03 and CA-06. | No log line contains any inserted `patientId` or `data` value. No new log lines appear compared with Phase 1 startup. | RNF-03, D-08 |

## 11. QA and evidence

All of the following are planned. None have run yet.

| Area/criteria | Setup and procedure | Expected result | Evidence |
| --- | --- | --- | --- |
| Types (CA-01) | `npm run build`, `npm run lint`, type-level test file | Exit 0 | Command output |
| Index set (CA-02) | e2e: `startMongo`, `createTestApp`, `listIndexes` | Exact 4 indexes and options | vitest e2e output |
| Read order, ties, late events, isolation (CA-03) | e2e: direct `insertMany` with fixed `ts`/`receivedAt`/`_id` values (fictional `p-a`, `p-b`), plus 2 `POST /events` | Exact `_id` sequence | vitest e2e output + array equality on `_id`s |
| Query plans (CA-04, CA-05) | e2e: `cursor.explain('queryPlanner')`, recursive search of `winningPlan` for stages | `IXSCAN` on the named index, no `SORT` | vitest e2e output (stage names asserted). If `hint` is used, the test says so (§5 assumption). |
| Restart idempotency (CA-06) | e2e: init, close, init | Same indexes, same count | vitest e2e output |
| Existing data (CA-07) | e2e: seed with the raw driver before boot | Unchanged docs, duplicate still detected | vitest e2e output + deep-equal |
| Concurrent replicas (CA-08) | e2e: two `createTestApp` in `Promise.all` | Both resolve | vitest e2e output |
| Conflicting index (CA-09) | e2e: pre-create conflicting index, expect `createTestApp` to reject | Rejection, index untouched | vitest e2e output |
| Regression (CA-10) | `npm test`, `npm run test:e2e` | All pass | Command output |
| Privacy in logs (CA-11) | `CaptureLogger` during CA-03/CA-06 | No payload values | vitest e2e output |

- Scenarios that don't apply here:
  - Accepted/validation/malformed/oversized requests: no HTTP contract changes. Covered by the Phase 1 tests rerun in CA-10.
  - Authentication and authorization: none exist (Phase 1 D-08).
  - Duplicates and idempotency of POSTs: unchanged. CA-07 and CA-10 confirm the unique index still deduplicates.
  - Ordering: covered by CA-03 (read side). Processing order is not a concern by design (PLAN G2).
  - Concurrency: covered for startup by CA-08. Claim races are Phase 3 (they need the claim query).
  - Dependency failure: Mongo unreachable at startup is unchanged (Phase 1 CA-15, rerun in CA-10). An index conflict is covered by CA-09. A failover during the index build can't be reproduced on a one-member replica set, and bootstrap rejection plus the Compose restart is the recovery.
  - Retry and recovery of processing: Phases 3–4.
  - Emitted events and metrics: none produced.
- Manual QA (optional, planned): after `docker compose up --build` on an existing `mongo-data` volume, `docker compose exec mongo mongosh ingest --quiet --eval 'db.events.getIndexes().map(i => i.name)'` lists the 4 names.
- Record: the environment (Node version, MongoDB version) and the pass/fail/blocked status per CA in the implementation report, noting any use of `hint` in CA-04/CA-05.

## 12. Definition of done and delivery

- [ ] No blocking decisions or required placeholders remain.
- [ ] RF-01 to RF-03 implemented and CA-01 to CA-11 verified with actual results.
- [ ] Negative scenarios covered: conflicting index, restart, existing data, concurrent startup.
- [ ] Responsiveness, themes and accessibility: not applicable (no UI).
- [ ] Data and logs comply with D-03, D-05, D-08 and RNF-03.
- [ ] `npm test`, `npm run test:e2e`, `npm run lint` and `npm run build` executed, with any limitations declared.
- [ ] Changes limited to scope. No dependency or lockfile changes.

Expected artifact: code and tests in this repository.
External actions/publication: none. Commits only when the user requests them.

## 13. References and consistency review

- `PLAN.md`: Phase 2 (fields and indexes), §3 (claim query), G2–G5 (read-side ordering, outcome on each event, one collection), Phases 3–6 (consumers of this model).
- `.ai/.specs/events-ingest-path.md` and its assessment: the Phase 1 document shape, D-07 startup semantics, D-14 privacy rules, and CA-13 (extended by D-09).
- `src/events/event.document.ts`, `src/database/database.module.ts`, `src/database/database.tokens.ts`, `src/events/events.service.ts`: the current model, index creation and insert.
- `src/config/env.validation.ts`: `WORKER_CONCURRENCY` and `LEASE_MS` (the basis for D-01).
- `test/events.e2e-spec.ts`, `test/support/*.ts`, `vitest.config.e2e.ts`, `package.json`: the test infrastructure and scripts.
- `docker-compose.yml`: the persistent `mongo-data` volume (existing-data scenario).
- `AGENTS.md`: telemetry guidance (not applied).
- The interview answers of 2026-11-02: D-01, D-02, D-03, D-05, D-07.

Consistency review: every RF and every behaviour-affecting decision maps to a CA (RF-01→CA-01; RF-02→CA-02, CA-05, CA-09; RF-03→CA-03, CA-04; D-03→CA-01, CA-07; D-06→CA-06–CA-09; D-08→CA-11; D-09→CA-10). D-04 is a recorded contract that this phase doesn't exercise, as stated in §3. Section 2 lists the observed facts, section 5 the decisions and assumptions, and section 11 the planned (not executed) QA.
