# Plan: Events data model (`events` document type, claim and read-order indexes)

## 1. Identity

- Plan status: PLANNED. Ready for implementation. Nothing in this plan has been executed.
- Date: 2026-11-02.
- Spec: `.ai/.specs/events-data-model.md`
- Spec SHA-256: `50c715bad8118e91773ed60d99ed99f8d3ca15d0a784312cc97189ffd883ecc2`
- Affected repositories: `clinical-event-ingestion-service` only (branch `main`, HEAD `75542a2`). The spec file is untracked in the working tree.
- Planning sources read:
  - The spec, `PLAN.md` (G2 to G5, section 3, Phase 2), `AGENTS.md`. There is no `CLAUDE.md` and no `.ai/docs/`.
  - Phase 1 artifacts: `.ai/.specs/events-ingest-path.md` (referenced), `.ai/.plans/events-ingest-path.md`, `.ai/.implementations/events-ingest-path.md`, `.ai/.assessments/events-ingest-path.md` (CA-13 evidence).
  - Manifests and config: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`, `vitest.config.ts`, `vitest.config.e2e.ts`, `.oxlintrc.json`, `.prettierrc`, `.gitignore`, `docker-compose.yml`.
  - Source: `src/events/event.document.ts`, `src/database/database.module.ts`, `src/database/database.tokens.ts`, `src/events/events.service.ts`, `src/events/events.module.ts`, `src/events/idempotency-key.ts`, `src/app.module.ts`, `src/app.setup.ts`, `src/main.ts`, `src/config/env.validation.ts`.
  - Tests: `test/events.e2e-spec.ts`, `test/app.e2e-spec.ts`, `test/startup-failure.e2e-spec.ts`, `test/events-store-down.e2e-spec.ts`, `test/support/app.ts`, `test/support/mongo.ts`, `test/support/capture-logger.ts`.
  - Installed packages: `mongodb` 7.8.0 (`mongodb.d.ts`: `Collection.find` overloads, `FindCursor.explain(verbosity)`), `@nestjs/config` (`dist/config.module.js` `forRoot`), `typescript` 6.0.3, `oxlint` 1.90.0. Local Node `v24.21.0`.

## 2. Readiness check

- Status line: "ready for implementation", updated 2026-11-02. Section 5 "Open questions": none blocking. The non-blocking follow-ups belong to Phases 3, 4 and 8.
- RF-01 to RF-03 each have a trigger, rules, output, exceptions and side effects. RNF-01 and RNF-02 are explicitly not applicable. RNF-03 and RNF-04 are concrete.
- D-01 to D-11 are concrete. None leaves a choice open that would change behaviour or acceptance meaning.
- CA-01 to CA-11 are observable, and the spec's section 13 maps each RF and behaviour-affecting decision to a CA.
- Both assumptions in section 5 have a defined confirmation point (CA-04/CA-05 and CA-08) and defined stop behaviour if false.
- Consistency checked across sections. The index set agrees between section 3, RF-02, D-06, D-09 and CA-02. The read order agrees between section 3, D-07, RF-03 and CA-03. The file table in section 9 matches section 4. D-09 supersedes only the Phase 1 CA-13 "no other index" clause, and `test/events.e2e-spec.ts` lines 113 to 119 hold that assertion.
- Repository facts that need specific handling (these are not contradictions, and section 4 resolves them inside the spec's outcomes):
  1. `ConfigModule.forRoot` validates `process.env` when `src/app.module.ts` is first imported. Within one vitest file the module graph is cached, so every `createTestApp` call in a file uses the first `MONGO_URI`. The new e2e file can't use a different database per scenario through the URI. Resolution: one replica set and one database per file, reset with `dropDatabase()` before each scenario (R-01).
  2. `Collection<EventDocument>.find(filter)` returns `FindCursor<WithId<EventDocument>>`. The overload `find<T>(filter, options)` returns `FindCursor<T>`. Resolution: R-03.
  3. `npm run build` excludes `**/*spec.ts`, and vitest strips types without checking them. Neither command type-checks a test file, so the CA-01 "type check compiles" evidence needs `tsc` (R-04).
  4. When `app.init()` rejects, Nest doesn't run `onApplicationShutdown`, so the connected `MongoClient` from CA-09 would stay open. Resolution: R-02.
- Conclusion: implementation-ready. No blocking ambiguity.

## 3. Observed implementation context

Facts about the current state:

- Stack: NestJS 12, `mongodb` 7.8.0 (no Mongoose), TypeScript 6.0.3 with `strict: true`, ESM (`"type": "module"`, `module: nodenext`, `.js` import suffixes), Node 24, vitest 4, `mongodb-memory-server` 11.3 pinned to MongoDB `7.0.45` via `package.json` `config.mongodbMemoryServer.version`.
- `src/events/event.document.ts` exports `EventStatus` and `EventDocument` with ten required fields. There are no doc comments.
- `src/database/database.module.ts` provides `MONGO_CLIENT` (`serverSelectionTimeoutMS: 5000`) and `EVENTS_COLLECTION` (`client.db().collection<EventDocument>('events')`). `onModuleInit` calls `client.connect()` and then a single `createIndex({ idempotencyKey: 1 }, { unique: true, name: 'idempotencyKey_unique' })`. Errors propagate. `onApplicationShutdown` closes the client. A comment references Phase 1 D-07.
- `src/database/database.tokens.ts` exports `MONGO_CLIENT`, `EVENTS_COLLECTION` and `EVENTS_COLLECTION_NAME = 'events'`.
- `src/events/events.service.ts` inserts the ten-field initial document with `w: 'majority'` and doesn't touch any processing field. It is out of scope for changes.
- `src/events/idempotency-key.ts` exports `computeIdempotencyKey({ data, patientId, ts: Date, type })`. CA-07 can reuse it to seed a document whose content a later POST duplicates.
- Tests:
  - `vitest.config.ts` runs `**/*.spec.ts` (unit tests live next to the code in `src/`). `vitest.config.e2e.ts` runs `**/*.e2e-spec.ts`. Both use `globals: true`.
  - `test/support/mongo.ts` `startMongo(dbName)` starts a one-member `MongoMemoryReplSet` and returns `{ uri, version, stop }`.
  - `test/support/app.ts` `createTestApp({ mongoUri, logger?, configure? })` sets `MONGO_URI`, dynamically imports `AppModule`, applies `configure` to the `TestingModuleBuilder`, calls `app.useLogger(logger)` and then `app.init()`.
  - `test/support/capture-logger.ts` `CaptureLogger` exposes `lines` and `all`.
  - `test/events.e2e-spec.ts` overrides `MONGO_CLIENT` with `builder.overrideProvider(MONGO_CLIENT).useFactory({ factory })` to attach command monitoring. Lines 113 to 119 assert that the sorted index names (`localeCompare`) are exactly `['_id_', 'idempotencyKey_unique']`, then check the unique flag and key.
- Scripts: `build` (`nest build` with `tsconfig.build.json`, `src` only, specs excluded), `lint` (`oxlint --type-aware src/ test/`), `test`, `test:e2e` and `format` (Prettier: `singleQuote`, `trailingComma: all`). `typescript` is a devDependency, so `npx tsc` is available without adding anything.
- `docker-compose.yml` keeps Mongo data in the `mongo-data` volume, and the app runs with `restart: unless-stopped`.
- Applicable instructions: `AGENTS.md` (NestJS Observe) doesn't apply, because `ObserveModule` isn't registered and the spec excludes telemetry.

Reusable: `EVENTS_COLLECTION` and `MONGO_CLIENT` tokens, `startMongo`, `createTestApp` with `configure`, `CaptureLogger`, `computeIdempotencyKey`, and the command-monitoring override pattern from `test/events.e2e-spec.ts`.

## 4. Implementation strategy

- Boundaries:
  - `DatabaseModule` remains the only owner of the client lifecycle and of index creation.
  - The read path is a pure function module, `src/events/patient-events.ts`. It isn't a Nest provider and isn't wired into any module (D-07, spec section 9).
  - The type changes are compile-time only.
  - No HTTP, configuration, dependency, Dockerfile, Compose or README change (D-10).
- Control flow at startup: `client.connect()`, then `createIndex` for each entry of an ordered, module-level index list, awaited one at a time: `idempotencyKey_unique`, then `claim_status_nextAttemptAt`, then `patient_read_order`. There is no `try/catch`, so any rejection propagates and `app.init()` / bootstrap rejects (D-06). Index creation stays idempotent: with identical specs, `createIndex` is a server-side no-op.
- Compatibility: existing documents need no migration (D-03). Existing deployments get the two new indexes built on first start. The Phase 1 insert and responses don't change.
- Resolved low-risk technical details:
  - R-01 (test isolation): the new e2e file starts one replica set (`startMongo('events_data_model')`) and opens a raw test client. Before each scenario it calls `testClient.db().dropDatabase()`, so each scenario starts with a "fresh database". This is required because the `ConfigModule` env snapshot fixes `MONGO_URI` per file (section 2, fact 1). `dropDatabase` succeeds whether or not the database exists.
  - R-02 (client capture): every app the new file boots uses `configure` to override `MONGO_CLIENT` with a factory that builds `new MongoClient(mongo.uri, { serverSelectionTimeoutMS: 5000, monitorCommands: true })`. This mirrors `test/events.e2e-spec.ts`. The factory records the client and its `commandStarted` events. `afterEach` closes every app that started and every recorded client, ignoring errors from clients that are already closed. This releases the client left open by the rejected inits in CA-09 and lets CA-02 assert the order of the `createIndexes` commands.
  - R-03 (helper type): `findPatientEvents` calls `collection.find<EventDocument>({ patientId }).sort(PATIENT_READ_ORDER)` and declares the return type `FindCursor<EventDocument>`, which is the exact type D-07 and RF-03 specify. `EventDocument._id` is already required, so `WithId<EventDocument>` and `EventDocument` describe the same shape. No runtime difference.
  - R-04 (type-level check): CA-01's type check lives in a colocated unit spec, `src/events/event.document.spec.ts`. It is checked with `npx tsc --noEmit --incremental false -p tsconfig.json` (the root `tsconfig.json` has no `include`, so it covers `src` and `test`). `--incremental false` stops a `.tsbuildinfo` from being written (it is gitignored anyway). The file also holds one trivial runtime `it`, so vitest doesn't fail on a file with no tests.
  - R-05 (constant placement, D-11): the index names, keys and options are exported module-level constants in `src/database/database.module.ts`, the file that creates the indexes. The `patient_read_order` key is written out as a literal, `{ patientId: 1, ts: 1, receivedAt: 1, _id: 1 }`. It isn't derived from `PATIENT_READ_ORDER`, which keeps the key specs in the creating file as D-11 says. The e2e test checks that the two stay consistent (CA-04 shows the index serves the sort).
  - R-06 (CA-11 "no new log lines"): no task adds a `Logger` or `console` call. The tests assert that captured lines contain no seeded `patientId` or `data` values and no index names (`claim_status_nextAttemptAt`, `patient_read_order`). A diff review confirms that no logging was added under `src/`.
  - R-07 (plan inspection helper): the new e2e file holds a local recursive walker over `explain().queryPlanner.winningPlan`. It visits every nested object and array (this covers `inputStage`, `inputStages` and an SBE `queryPlan` wrapper), collects `stage` values and the `indexName` of `IXSCAN` stages, and asserts on them.
- Sequencing rationale: types first, because the helper and the tests compile against them. The index code and the read helper are independent. The Phase 1 assertion update and the new e2e file depend on the index constants and the helper. Full verification runs last.
- Rejected alternatives:
  - A separate e2e file per database scenario: more replica-set startups and slower, with no gain over R-01.
  - Overriding `MONGO_URI` per app: impossible after the first `AppModule` import (fact 1).
  - Deriving the index key from `PATIENT_READ_ORDER`: rejected per R-05.
  - Adding a `typecheck` npm script: rejected because it changes `package.json`, and the spec requires no dependency or manifest changes.
  - A `try/catch` or retry around `createIndex`: forbidden by D-06 and by the CA-08 assumption ("do not add retries silently").

## 5. Ordered tasks

### T-01 — Complete the `EventDocument` type

- Outcome: `EventDocument` has five optional processing fields, and `EventError` is exported (RF-01).
- IDs: RF-01, D-03, D-04, D-05, RNF-03.
- Dependencies: none.
- Area: `src/events/event.document.ts`.
- Changes:
  - Add `export interface EventError { code: string; message: string; at: Date }`.
  - Add these optional fields to `EventDocument`: `lockedUntil?: Date`, `workerId?: string`, `result?: Record<string, unknown>`, `lastError?: EventError`, `processedAt?: Date`.
  - Add a doc comment on `EventDocument` stating:
    - The D-04 presence rules: `lockedUntil` and `workerId` only while `processing`. `result` only when `done`. `processedAt` when `done` or `failed`. `lastError` holds the most recent failed attempt, may be present in `pending` or `failed`, and is kept as history after success.
    - The D-03 rule: fields are absent until set and are cleared with `$unset`, never `null`.
  - Add a doc comment on `EventError` stating the D-05 rule: `code` is a fixed machine label, and `message` never contains `patientId`, `type`, `ts`, `data` or the idempotency key.
- Invariants:
  - The ten existing fields, their types and the `EventStatus` union stay unchanged.
  - Nothing changes at runtime.
  - No `| null` in any new field type.
- Edge cases: none at runtime. `exactOptionalPropertyTypes` is off, so `undefined` is assignable, which matches "absent".
- Completion evidence: `npm run build` exit 0. T-02's type check compiles.

### T-02 — Type-level check for CA-01

- Outcome: the type contract is checked by the compiler (CA-01).
- IDs: CA-01, RF-01, D-03, D-05.
- Dependencies: T-01.
- Area: new `src/events/event.document.spec.ts` (colocated unit spec, R-04).
- Changes:
  - A pending document with only the ten Phase 1 fields, checked with `satisfies EventDocument`.
  - A document with `status: 'done'` that sets all five processing fields with the D-05 types (`lastError: { code: 'timeout', message: 'Processing timed out', at: new Date() }`), also checked with `satisfies EventDocument`.
  - `// @ts-expect-error` negative cases:
    - `lockedUntil: null`, which shows that `null` isn't the clearing value (D-03).
    - `lastError` without `at`.
    - `result: 'x'`.
  - One `it` asserting a trivial runtime property, for example that the done fixture's `lastError.code` is a string, so vitest collects the file.
  - All values are fictional and contain no realistic patient data.
- Invariants: no runtime import of product code beyond types and `ObjectId`. The file is excluded from `dist` by `tsconfig.build.json`.
- Edge cases: an unused `@ts-expect-error` is itself a compile error, so the negative cases only pass when the type actually rejects them.
- Completion evidence: `npx tsc --noEmit --incremental false -p tsconfig.json` reports no error in this file. `npm test` collects the file and it passes.

### T-03 — Patient read-order helper

- Outcome: a single definition of the patient read order and a cursor-returning helper (RF-03).
- IDs: RF-03, D-07, D-08, RNF-03.
- Dependencies: T-01.
- Area: new `src/events/patient-events.ts` (the file name the spec suggests).
- Changes:
  - `export const PATIENT_READ_ORDER = { ts: 1, receivedAt: 1, _id: 1 } as const`, typed so the driver accepts it as a `Sort`. If `as const` doesn't satisfy `Sort`, use `satisfies Sort` without `as const`. Key order matters.
  - `export function findPatientEvents(collection: Collection<EventDocument>, patientId: string): FindCursor<EventDocument>`, returning `collection.find<EventDocument>({ patientId }).sort(PATIENT_READ_ORDER)` (R-03).
  - A short doc comment covering the order, the tie-breaks, that every status is included, the default read concern and preference, and that the function must not log (it returns clinical data).
- Invariants:
  - Exact-match filter `{ patientId }`, with no trimming or case folding.
  - No projection, limit, `readConcern` or `readPreference` options (D-08).
  - No logging.
  - `PATIENT_READ_ORDER` is referenced, not copied.
  - Not registered as a Nest provider.
- Edge cases: an unknown patient returns an empty cursor. Driver errors propagate unchanged.
- Completion evidence: build and lint exit 0. T-06 scenarios CA-03 and CA-04.

### T-04 — Ensure the three indexes at startup

- Outcome: `onModuleInit` ensures exactly the RF-02 index set, in order (RF-02).
- IDs: RF-02, D-01, D-02, D-06, D-11, RNF-04.
- Dependencies: none (it uses only existing imports). It may run in parallel with T-01 to T-03.
- Area: `src/database/database.module.ts`.
- Changes:
  - Export module-level name constants:
    - `IDEMPOTENCY_INDEX_NAME = 'idempotencyKey_unique'`
    - `CLAIM_INDEX_NAME = 'claim_status_nextAttemptAt'`
    - `PATIENT_READ_ORDER_INDEX_NAME = 'patient_read_order'`
  - Export an ordered, read-only `EVENTS_INDEXES` list of `{ key, options }` entries:
    1. `{ idempotencyKey: 1 }`, `{ unique: true, name: IDEMPOTENCY_INDEX_NAME }`
    2. `{ status: 1, nextAttemptAt: 1 }`, `{ name: CLAIM_INDEX_NAME }`
    3. `{ patientId: 1, ts: 1, receivedAt: 1, _id: 1 }`, `{ name: PATIENT_READ_ORDER_INDEX_NAME }`
  - In `onModuleInit`, after `await this.client.connect()`, run a `for … of` loop that does `await this.events.createIndex(index.key, index.options)`.
  - Update the existing comment so it says a refused index (including a name conflict) stops bootstrap.
- Invariants:
  - The unique index keeps the same name, key and flag.
  - No `sparse`, `partialFilterExpression`, `expireAfterSeconds`, `collation` or `background` options on any index.
  - No `lockedUntil` index (D-01).
  - No `createCollection`, `collMod` or validator (D-02).
  - No `try/catch` and no retry.
  - Sequential awaits (not `Promise.all`), so the order is deterministic.
  - `MONGO_CLIENT` and `EVENTS_COLLECTION` providers and `onApplicationShutdown` stay unchanged.
- Edge cases:
  - Existing identical indexes: `createIndex` is a no-op (CA-06, CA-08).
  - An existing index with the same name and a different key: the server rejects and bootstrap fails, leaving that index untouched (CA-09).
  - Existing documents: the index builds over them (CA-07).
- Completion evidence: build and lint exit 0. T-06 scenarios CA-02 and CA-05 to CA-09.

### T-05 — Update the Phase 1 index-list assertion

- Outcome: the Phase 1 suite expects the new index set (D-09).
- IDs: D-09, CA-10.
- Dependencies: T-04.
- Area: `test/events.e2e-spec.ts`, the CA-13 block (currently lines 113 to 119).
- Changes: replace the expected array with `['_id_', 'claim_status_nextAttemptAt', 'idempotencyKey_unique', 'patient_read_order']`, keeping the existing `localeCompare` sort. Underscore sorts before letters under `localeCompare`, as the current passing assertion shows, so this order is the sorted order. Optionally reference the T-04 name constants instead of string literals (D-11).
- Invariants:
  - The majority-insert assertion and the `unique`/`key` assertions on `idempotencyKey_unique` stay as they are.
  - No other line of the file changes.
  - Update the test title's CA-13 reference only if needed to avoid confusion. The default is no change.
- Edge cases: none.
- Completion evidence: `npm run test:e2e` passes this test (CA-10).

### T-06 — New data-model e2e suite

- Outcome: every scenario from spec section 11 is automated (CA-02 to CA-09, CA-11).
- IDs: CA-02, CA-03, CA-04, CA-05, CA-06, CA-07, CA-08, CA-09, CA-11. It also covers RF-02, RF-03, D-01, D-02, D-03, D-06, D-07, D-08 and RNF-03/RNF-04.
- Dependencies: T-01, T-03, T-04.
- Area: new `test/events-data-model.e2e-spec.ts` (the file name the spec suggests).
- Fixture layout:
  - `beforeAll`: `startMongo('events_data_model')` with a 180 s timeout, as in existing suites, plus a raw `MongoClient` test client.
  - `beforeEach`: `dropDatabase()` (R-01).
  - Local `boot(logger?)` helper: calls `createTestApp` with the R-02 `MONGO_CLIENT` override, records the app and client for cleanup, and returns `{ app, commands }`.
  - `afterEach`: closes recorded apps and clients.
  - `afterAll`: closes the test client and stops Mongo with a 60 s timeout.
  - The R-07 plan walker.
  - Typed test collection: `testClient.db().collection<EventDocument>('events')`.
- Scenarios:
  1. CA-02, plus D-01/D-02/D-06 order:
     - Boot once, then `listIndexes`. Assert exactly 4 indexes by name.
     - For each index, assert `key` with `toEqual` and also `Object.keys(key)` against the expected array, so key order is checked.
     - Assert `unique === true` only on `idempotencyKey_unique`, and that `claim_status_nextAttemptAt` and `patient_read_order` have `unique`, `sparse`, `partialFilterExpression` and `expireAfterSeconds` all `undefined`.
     - Assert that the captured `createIndexes` commands name the indexes in the order idempotency, claim, read order.
     - Assert that `listCollections({ name: 'events' })` returns options without `validator` (D-02).
  2. CA-03 and CA-11 (read path):
     - Boot with a `CaptureLogger`.
     - `insertMany` (`ordered: true`) seeds fictional `p-a` and `p-b` documents in shuffled order, using fixed `ObjectId.createFromHexString(...)` values, fixed `ts` and `receivedAt`, and distinct 64-hex `idempotencyKey` values (required by the unique index).
     - The `p-a` set includes:
       - distinct `ts` values
       - two documents with equal `ts` and different `receivedAt`
       - two with equal `ts` and `receivedAt` and different `_id`
       - statuses `pending`, `processing` (with `lockedUntil` and `workerId`), `done` (with `result` and `processedAt`) and `failed` (with `lastError` and `processedAt`)
     - Add `p-b` documents whose `ts` values interleave with `p-a`'s.
     - Then `insertOne` a late `p-a` event with the earliest `ts`.
     - Then `POST /events` two `p-a` events (supertest on `app.getHttpServer()`), with `ts` values that fall between seeded values and differ from them. Take their ids from the responses.
     - Assert:
       - `findPatientEvents(col, 'p-a').toArray()` `_id` hex sequence equals the precomputed expected sequence, with the late event first and the POSTed events in their `ts` positions.
       - No `p-b` document appears.
       - The `p-b` sequence is correct.
       - `p-none` returns `[]`.
     - CA-11: `logger.all` contains no seeded or posted `patientId` or `data` values, and no index name (R-06).
  3. CA-04: use the same seed (a shared seeding function), then `findPatientEvents(col, 'p-a').explain('queryPlanner')`. The walker must find an `IXSCAN` with `indexName: 'patient_read_order'` and no `SORT` stage.
  4. CA-05:
     - Seed pending documents with past and future `nextAttemptAt`, and processing documents with past `nextAttemptAt`.
     - With `now = new Date()`, run `find({ status: 'pending', nextAttemptAt: { $lte: now } }).sort({ nextAttemptAt: 1 })`.
     - `explain('queryPlanner')`: `IXSCAN` on `claim_status_nextAttemptAt` and no `SORT`.
     - `toArray()` returns exactly the due pending ids in ascending `nextAttemptAt`.
  5. CA-06 and CA-11:
     - Boot with a `CaptureLogger`, seed or POST two fictional documents, record `listIndexes` and `countDocuments`, then close the app.
     - Boot again with a new `CaptureLogger`. The second `boot` resolves, the index list deep-equals the first, and the count is unchanged.
     - CA-11 assertions on both loggers.
  6. CA-07:
     - Before booting, create `{ idempotencyKey: 1 }` `{ unique: true, name: 'idempotencyKey_unique' }` with the raw client.
     - Insert Phase 1-shaped documents (exactly the ten fields), one of them with `idempotencyKey` from `computeIdempotencyKey` for a known fictional `{ patientId, type, ts, data }`. Snapshot them with `find().sort({ _id: 1 }).toArray()`.
     - Boot. Assert the CA-02 index set, then deep-equal the documents with the snapshot.
     - Assert `findPatientEvents` returns the seeded documents for their patient.
     - POST the known content: `202 { id: <seeded _id hex>, status: 'pending', duplicate: true }`, and the count is unchanged.
  7. CA-08: `Promise.all([boot(), boot()])` on the fresh database. Both resolve and the CA-02 index set holds. If this rejects, it is a blocker to report (spec section 5). Do not add retries.
  8. CA-09:
     - Two cases, in one `it.each` or two `it`s.
     - Case one: pre-create `{ patientId: 1 }` named `patient_read_order`. `await expect(boot()).rejects.toThrow()`. Afterwards, `listIndexes` shows `patient_read_order` with key `{ patientId: 1 }`, unchanged.
     - Case two: pre-create `{ status: 1 }` named `claim_status_nextAttemptAt` and assert the same way. `patient_read_order` should also be absent, consistent with the D-06 order. This extra assertion isn't required by the CA and may be dropped if it proves flaky.
     - `afterEach` closes the clients that were left open (R-02).
- Invariants:
  - Only fictional identifiers (`p-a`, `p-b`, `p-none`, and fictional `data` such as `{ hr: 72 }`).
  - No `hint` by default. If CA-04 or CA-05 needs `hint`, follow spec section 5: keep the unhinted assertion's failure visible, add a hinted check that still asserts no `SORT`, and name it explicitly in the test title and the implementation report. If even a hinted plan contains `SORT`, stop and return to `/create-spec`.
  - Timeouts follow existing suites (180 s setup, 60 s teardown). Per-test timeouts are raised for the boot-heavy scenarios only if needed.
- Edge cases covered: ties on `ts`, ties on `ts` and `receivedAt`, a late event, patient isolation, an unknown patient, all statuses, a non-empty collection, a restart, a concurrent start, and name conflicts on both new indexes.
- Completion evidence: `npm run test:e2e` shows every scenario passing (CA-02 to CA-09, CA-11).

### T-07 — Format, static checks and full regression

- Outcome: the change meets the project's style rules and every suite passes (CA-01, CA-10).
- IDs: CA-01, CA-10, RNF-04, D-10.
- Dependencies: T-01 to T-06.
- Area: whole repository (commands only, no new files).
- Changes: run `npm run format`, then the section 6 commands. Fix only defects inside the files touched by T-01 to T-06.
- Invariants:
  - No changes to `package.json`, `package-lock.json`, `README.md`, the Dockerfile, `docker-compose.yml`, `src/config`, `src/events/events.service.ts`, the controller or the DTOs.
  - No commits (spec section 12).
- Completion evidence: the section 6 command outputs, recorded with the environment (Node version, MongoDB binary version), CA status and any use of `hint` in the implementation report.

## 6. Verification plan

All checks are planned. None has been executed.

| ID | Command or procedure | Criteria | Expected evidence |
| --- | --- | --- | --- |
| V-01 | `npm run build` | CA-01, RF-01 | Exit 0, and no `*.spec.ts` output in `dist/`. |
| V-02 | `npm run lint` | CA-01, RNF-04 | Exit 0, with no `no-floating-promises` findings in the new tests. |
| V-03 | `npx tsc --noEmit --incremental false -p tsconfig.json` | CA-01, D-03, D-05 | No diagnostics in `src/events/event.document.spec.ts` (every `@ts-expect-error` is used and the `satisfies` checks pass). If unrelated errors already exist in untouched files, record them as a limitation and don't fix them. |
| V-04 | `npm test` | CA-01, CA-10 | All unit specs pass, including the new type-level spec. |
| V-05 | `npm run test:e2e` | CA-02 to CA-11 | All files pass: the new data-model suite, `events.e2e-spec.ts` with the D-09 list, `app.e2e-spec.ts` (`GET /health` 200 `{ status: 'ok' }`), `startup-failure.e2e-spec.ts` (Phase 1 CA-15) and `events-store-down.e2e-spec.ts`. |
| V-06 | Diff review: `git diff --stat` and `git status --porcelain` | D-02, D-08, D-10, RNF-03, RNF-04, scope | Only the T-01 to T-06 files changed or were added. There are no changes to the manifest, lockfile or README, and the `src/` diff adds no `Logger`/`console`, `collMod`, `validator` or `lockedUntil` index. |
| V-07 (optional manual) | `docker compose up --build` on an existing `mongo-data` volume, then `docker compose exec mongo mongosh ingest --quiet --eval 'db.events.getIndexes().map(i => i.name)'` | CA-07 (real Compose data), RF-02 | The four names are listed and the app becomes healthy. It needs Docker, and its outcome is recorded as not run if Docker is unavailable. |

Setup: Node 24 and the `mongodb-memory-server` 7.0.45 binary. The Phase 1 report found it cached in `~/.cache/mongodb-binaries`. If it isn't cached, the first e2e run downloads it.

Limitations, per the spec:
- `explain()` on a small collection proves the planner choice, not performance at volume.
- A failover during the index build can't be reproduced on a one-member replica set.
- The D-04 invariants aren't exercised in this phase.

## 7. Risk and recovery

- Regression surface:
  - Startup now runs three `createIndex` calls, which adds a little to boot time. A conflicting pre-existing index now stops startup (intended, D-06).
  - Every insert maintains three secondary indexes (accepted, RNF-04).
  - The Phase 1 index-list assertion changes (D-09).
- Existing data: on a populated Compose volume, the first start builds two indexes over the existing documents. Startup time grows with collection size, and the Compose `start_period` stays unchanged (RNF-04). No document is modified, and no migration is needed.
- Concurrency: identical concurrent index builds are expected to succeed (CA-08 confirms). If they fail, report it as a blocker rather than adding retries.
- Planner assumption: if the planner picks another plan on the test data, follow the `hint` rule in T-06. If a hinted plan still sorts in memory, stop and return to `/create-spec`.
- Destructive or external actions that need separate authority: none are planned. Dropping a conflicting index in a real database is an operator action and out of scope. `dropDatabase` in T-06 touches only the in-memory test server.
- Rollback: revert the code changes. Indexes already built in a real database stay in place, and the Phase 1 code tolerates them (it only ensures `idempotencyKey_unique`). Removing them would need an explicit operator `dropIndex`, which this plan doesn't authorise.
- Test-suite risks: the rejected inits in CA-09 could leak a client. R-02 closes it. The test runtime grows by one replica-set startup.

## 8. Coverage matrix

| ID | Tasks | Checks |
| --- | --- | --- |
| RF-01 | T-01, T-02 | V-01, V-02, V-03, V-04 (CA-01) |
| RF-02 | T-04, T-05, T-06 | V-05 (CA-02, CA-05, CA-06, CA-07, CA-08, CA-09), V-07 |
| RF-03 | T-03, T-06 | V-05 (CA-03, CA-04, CA-07) |
| RNF-01 | Not applicable: no UI (spec section 8) | Not applicable |
| RNF-02 | Not applicable: no UI (spec section 8) | Not applicable |
| RNF-03 | T-01 (doc comment), T-03 (no logging), T-06 (log assertions) | V-05 (CA-11), V-06 |
| RNF-04 | T-04, T-06, T-07 | V-02, V-05 (CA-04, CA-05, CA-06, CA-08), V-06 (no dependencies) |
| D-01 | T-04 | V-05 (CA-02, CA-05), V-06 |
| D-02 | T-04 | V-05 (CA-02 `listCollections` check), V-06 |
| D-03 | T-01, T-02 | V-03 (CA-01), V-05 (CA-07) |
| D-04 | T-01 (doc comment only; not exercised, per spec section 3) | V-06 (comment present on review) |
| D-05 | T-01, T-02 | V-03 (CA-01), V-06 |
| D-06 | T-04, T-06 | V-05 (CA-02 order, CA-06, CA-07, CA-08, CA-09) |
| D-07 | T-03, T-06 | V-05 (CA-03, CA-04), V-06 (no route added) |
| D-08 | T-03 | V-05 (CA-11), V-06 |
| D-09 | T-05 | V-05 (CA-10) |
| D-10 | T-07 | V-06 (README unchanged) |
| D-11 | T-04, T-05, T-06 | V-01, V-05, V-06 |
| CA-01 | T-01, T-02, T-07 | V-01, V-02, V-03, V-04 |
| CA-02 | T-04, T-06 | V-05 |
| CA-03 | T-03, T-06 | V-05 |
| CA-04 | T-03, T-06 | V-05 |
| CA-05 | T-04, T-06 | V-05 |
| CA-06 | T-04, T-06 | V-05 |
| CA-07 | T-04, T-06 | V-05, V-07 |
| CA-08 | T-04, T-06 | V-05 |
| CA-09 | T-04, T-06 | V-05 |
| CA-10 | T-05, T-07 | V-04, V-05 |
| CA-11 | T-03, T-06 | V-05, V-06 |

Every mandatory RF, RNF, D and CA identifier is mapped.

## 9. Implementation handoff

- Prerequisites: Node 24, installed `node_modules` (no install changes), and the MongoDB 7.0.45 memory-server binary (cached or downloadable). Docker only for the optional V-07.
- Permitted scope:
  - Modify `src/events/event.document.ts`, `src/database/database.module.ts` and `test/events.e2e-spec.ts` (only the index-list assertion).
  - Create `src/events/patient-events.ts`, `src/events/event.document.spec.ts` and `test/events-data-model.e2e-spec.ts`.
  - Write the implementation report. No other files. No dependency, lockfile, README, configuration or route changes. No commits.
- Known non-blocking risks:
  - The planner choice on small collections (`hint` fallback rule).
  - Concurrent identical index builds (CA-08 confirms, else blocker).
  - Possible unrelated diagnostics from the whole-project `tsc` run (V-03, record as a limitation).
  - Longer first startup on large existing collections.
  - Extra write cost per insert, measured in Phase 6.
- Follow-ups outside this plan: Phases 3 and 4 verify the D-04 invariants and the reclaim query plan (D-01). Phase 8 documents the indexes (D-10).
- Confirmation: no blocking ambiguity remains. Every decision this plan takes (R-01 to R-07) is a reversible technical detail that leaves product scope, externally visible behaviour, data handling and acceptance meaning unchanged.
