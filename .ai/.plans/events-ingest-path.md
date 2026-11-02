# Plan: Events ingest path (`POST /events`)

## 1. Identity

- Plan status: PLANNED — ready for implementation. Nothing in this plan has been executed.
- Date: 2026-11-02.
- Spec: `.ai/.specs/events-ingest-path.md`
- Spec SHA-256: `6d9c795c2056fff37d961aac3943b9fb186c3a4922230a536d495932524af3a2`
- Affected repositories: `clinical-event-ingestion-service` (this repository only, branch `main`, HEAD `e2aebeb`).
- Planning sources read:
  - The spec, `PLAN.md`, `README.md`, `AGENTS.md` (no `CLAUDE.md` exists; no `.ai/docs/` exists).
  - `package.json`, `package-lock.json` (presence), `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`, `vitest.config.ts`, `vitest.config.e2e.ts`, `.oxlintrc.json`, `.prettierrc`, `.dockerignore`, `.gitignore`, `Dockerfile`, `docker-compose.yml`.
  - `src/main.ts`, `src/app.module.ts`, `src/config/env.validation.ts`, `src/config/env.validation.spec.ts`, `src/health/health.controller.ts`, `src/health/health.module.ts`, `test/app.e2e-spec.ts`.
  - Installed framework sources: `@nestjs/core` 12.3.2 (`router/routes-resolver.js`, `router/router-proxy.js`, `nest-application.js`), `@nestjs/platform-express` (`adapters/express-adapter.js`: `mapException`, `registerParserMiddleware`, `useBodyParser`), `@nestjs/common` (`pipes/validation.pipe.js`, `utils/strip-proto-keys.util.js`), `@nestjs/config` 12.0.1 (`dist/config.module.js` `forRoot`), `body-parser` 2.4.0 (`lib/types/json.js`), `class-validator` 0.15.1 (`ValidationExecutor` `stopAtFirstError`), `express` 5.3.0, `vite` 8.3.5, `vitest` 4.1.12.
  - npm registry metadata: `mongodb` latest `7.8.0` (engines `node >=20.19.0`, `MIN_SUPPORTED_SERVER_VERSION = '4.4'`, `WriteConcernOptions.wtimeoutMS` present, error classes `MongoServerSelectionError`, `MongoNetworkError`, `MongoNotConnectedError`, `MongoTopologyClosedError`, `MongoClientClosedError`, `MongoWriteConcernError`, `MongoErrorLabel` present). `mongodb-memory-server` latest `11.3.0` (default binary `8.2.6`; reads `package.json` `config.mongodbMemoryServer`; postinstall downloads a binary unless `DISABLE_POSTINSTALL`, exits 0 on failure).
  - MongoDB release metadata (`downloads.mongodb.org/full.json`): newest 7.0 patch is `7.0.45`, published for `macos arm64`, `macos x86_64`, `ubuntu2204` and `debian12`. The local `mongo:7.0` Docker image reports `MONGO_VERSION=7.0.45`.
  - Local environment: Node `v24.21.0`, `arm64`, no MongoDB binary cache (`~/.cache/mongodb-binaries` absent).

## 2. Readiness check

- Status line: "ready for implementation", updated 2026-11-02. Section 5 "Open questions": none blocking.
- Every RF (RF-01 to RF-06) has rules, outputs and exceptions; RNF-01/RNF-02 are explicitly not applicable; RNF-03/RNF-04 are concrete.
- Decisions D-01 to D-17 are concrete. The two gaps found by the earlier plan-spec run are closed by D-16 (malformed JSON body) and D-17 (`DuplicateNotVisible` log label).
- Every acceptance criterion CA-01 to CA-18 is observable and maps to a requirement or decision.
- Assumptions in section 5 have defined confirmation points (CA-14, first `npm run test:e2e`, CA-11) and defined stop behaviour if false; none requires a decision now.
- Internal consistency checked: scope (section 4) vs file table (section 9) vs CAs (section 10) vs QA (section 11) agree. The index set (only `idempotencyKey_unique`) agrees between D-02, RF-05 and CA-13. The 503 body agrees between D-11, D-12 and RF-06.
- Framework facts that make some spec statements true only with specific wiring (not contradictions; resolved in section 4 below, all within the spec's stated outcomes):
  1. Nest's default parser stack also registers `express.urlencoded({ extended: true })`. A urlencoded body such as `patientId=p&type=t&ts=…&data[hr]=72` would parse into a valid-looking object and get `202`, contradicting RF-02 ("non-JSON content type fails validation because the required fields are absent"). Resolution: register only the JSON parser (R-01).
  2. `body-parser` strict mode turns primitive JSON bodies (`"x"`, `1`) into a `SyntaxError`, and Nest's `ValidationPipe` answers an array body with `Validation failed (object is expected)`. RF-02 says arrays and primitives fail validation because the required fields are absent. Resolution: `strict: false` and a body pipe that validates `{}` for non-object bodies (R-02).
  3. Nest maps body-parser `SyntaxError`s to `new BadRequestException(error.message)` (express-adapter `mapException`), which echoes body fragments. D-16 requires a fixed message. Resolution: translate `entity.parse.failed` errors before Nest's error handler (R-03).
  4. Nest's `ValidationPipe` calls `stripProtoKeys` on the request body in place, deleting `__proto__`, `prototype` and `constructor` keys at every depth, including inside `data`. RF-02 says `data` is "stored as received" and D-05 says unknown top-level fields are rejected. Resolution: validate a clone and keep the original body (R-04).
  5. `ConfigModule.forRoot` reads and validates `process.env` when `src/app.module.ts` is first imported. E2e tests must set `MONGO_URI` before importing `AppModule` (R-07).
- Conclusion: implementation-ready. No blocking ambiguity.

## 3. Observed implementation context

Facts (current state):

- Runtime/stack: NestJS 12 (`@nestjs/core` 12.3.2, `@nestjs/config` 12.0.1), Express 5.3.0 with `body-parser` 2.4.0, `class-validator` 0.15.1, `class-transformer` 0.5.1, TypeScript 6, ESM (`"type": "module"`, `module: nodenext`, `.js` import suffixes), Node 24.
- `src/main.ts`: `NestFactory.create(AppModule)` with default options, reads `PORT` via `ConfigService<EnvironmentVariables, true>`, `listen`. No pipes, filters, shutdown hooks. Top-level `await bootstrap()`, so a rejected bootstrap terminates the process non-zero.
- `src/app.module.ts`: `ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv })` and `HealthModule`.
- `src/config/env.validation.ts`: `MONGO_URI` default `mongodb://localhost:27017/ingest?directConnection=true`; all worker settings already exist. No Mongo timeout variables (D-04 keeps it that way).
- `src/health/*`: `GET /health` → `{ status: 'ok' }`; module naming pattern `<area>/<area>.controller.ts`, `<area>.module.ts`.
- Tests: `vitest.config.ts` includes `**/*.spec.ts` (unit, colocated in `src/`); `vitest.config.e2e.ts` includes `**/*.e2e-spec.ts` (in `test/`). Both `globals: true`. `test/app.e2e-spec.ts` statically imports `AppModule` and uses `Test.createTestingModule` + `createNestApplication` + supertest.
- Build: `tsconfig.build.json` compiles `src` only and excludes `test` and `**/*spec.ts`. `.dockerignore` excludes `test`. Lint: `oxlint --type-aware src/ test/` with `no-floating-promises: error`.
- Compose: `mongo:7.0` (7.0.45) single-node replica set `rs0`; app `MONGO_URI=mongodb://mongo:27017/ingest?replicaSet=rs0`, `restart: unless-stopped`.
- Dockerfile build stage runs `npm ci` (dev dependencies included, so any devDependency postinstall runs there) on `node:24-alpine`.
- Framework behaviour relevant to this feature (verified in installed sources):
  - `NestApplication.init()` registers the JSON and urlencoded parsers unless `bodyParser: false`; parser errors reach `RoutesResolver.registerExceptionHandler`, which calls `ExpressAdapter.mapException`: `SyntaxError` → `BadRequestException(error.message)`; http-errors < 500 (for example 413 `PayloadTooLargeError`) → `HttpException(message, status)`; anything else unchanged. Global filters apply.
  - `app.use(...)` before `init()` adds the middleware to the Express stack immediately, ahead of the routes and Nest's error handler, which are added during `init()`.
  - `TestingModule.createNestApplication(options?)` accepts `NestApplicationOptions` (including `bodyParser`).
  - `ValidationPipe` with `stopAtFirstError` stops per property after the first failing constraint; the evaluation order follows class-validator's metadata registration order.
- Nothing exists yet for Mongo, `src/events/`, `src/database/` or an events e2e suite.

Applicable instructions: `AGENTS.md` (NestJS Observe telemetry) does not apply; the spec excludes telemetry. No `CLAUDE.md`.

Reusable: `ConfigService<EnvironmentVariables, true>` for `MONGO_URI`; the e2e supertest pattern; existing vitest configs unchanged.

## 4. Implementation strategy

### Boundaries

- New `src/database/` (`DatabaseModule`): owns the `MongoClient`, connection, the unique index and client shutdown. Exports injection tokens for the client and the `events` collection.
- New `src/events/` (`EventsModule`): pure helpers (timestamp parsing, canonical JSON and key), DTO, body pipe, store-error classification, service, controller.
- New `src/app.setup.ts`: the single place that defines the HTTP application options and body-parser wiring, used by both `src/main.ts` and every e2e test so production and tests behave the same.
- Tests: colocated unit specs in `src/events/`; e2e files in `test/` with shared helpers in `test/support/`.

### Control flow for `POST /events`

1. Express JSON parser (`strict: false`, default 100 kb limit). Oversized → 413 via Nest's mapping. Parse failure (`type === 'entity.parse.failed'`) → translated to `BadRequestException('Malformed JSON body')`.
2. `EventBodyPipe` on `@Body()`: validates against `CreateEventDto` (class-validator decorators are the only rule set), returns the original, untouched body on success, or throws the D-13 `BadRequestException`.
3. `EventsController.create` (`@HttpCode(202)`) → `EventsService.ingest(body)`.
4. Service: `parseEventTimestamp(ts)` → `Date`; `computeIdempotencyKey({ data, patientId, ts, type })`; build the D-02 document; `insertOne` with `writeConcern { w: 'majority', wtimeoutMS: 5000 }`.
5. Success → `{ id: _id.toHexString(), status: 'pending', duplicate: false }`.
6. E11000 on `idempotencyKey` → majority/primary `findOne` with up to 5 retries 100 ms apart → `{ id, status, duplicate: true }`, or `503` + `DuplicateNotVisible` warn.
7. D-11 errors → one warn line (`name` and `code` only) → `ServiceUnavailableException('Event store unavailable, retry later')`. Anything else is rethrown (Nest default 500).

### Resolved low-risk technical details (with rationale)

- R-01 Only the JSON parser is registered (`NestFactory.create(..., { bodyParser: false })` then `app.useBodyParser('json', { strict: false })`). Rationale: required for RF-02's statement that non-JSON content types fail validation; Nest's default urlencoded parser would let a form body reach `202`. No route in the app accepts form bodies (only `GET /health` exists). Default 100 kb limit is unchanged, so the section 5 assumption and CA-11 still hold.
- R-02 `strict: false` plus a pipe rule "a body that is not a plain object (array, primitive, `null`, `undefined`) is validated as `{}`". Rationale: RF-02 says arrays, primitives, missing bodies and non-JSON content types fail validation because the required fields are absent, so the response is the D-13 shape with the first-rule message of each of the four fields (`patientId must be a string`, `type must be a string`, `ts must be an ISO 8601 date-time with a timezone offset`, `data must be a JSON object`). Strict mode would turn primitives into "malformed JSON", and Nest's pipe would answer arrays with `Validation failed (object is expected)`.
- R-03 Malformed JSON translation is a four-argument Express error middleware registered in `configureApp` right after the JSON parser: `err.type === 'entity.parse.failed'` → `next(new BadRequestException('Malformed JSON body'))`, otherwise `next(err)`. A `BadRequestException` passes through `mapException` unchanged, so Nest's default filter renders exactly `{ statusCode: 400, message: 'Malformed JSON body', error: 'Bad Request' }`. It applies to every route, which is harmless because no other route reads a body. Rejected: a global `@Catch(BadRequestException)` filter (cannot tell a parse error from other string-message 400s, because `mapException` drops the original error), and subclassing `ExpressAdapter` (overrides framework internals).
- R-04 `EventBodyPipe` (custom `PipeTransform`) wraps `new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, stopAtFirstError: true, expectedType: CreateEventDto })`:
  - It validates a `structuredClone` of the body (or `{}` per R-02), so Nest's in-place `stripProtoKeys` never mutates the request's `data`.
  - Because `stripProtoKeys` also hides top-level keys named `__proto__`, `constructor` or `prototype` from the whitelist check, the pipe adds `property <k> should not exist` for each such own key of the original body (these names can never be DTO fields, so this is not a second rule set). Messages from the delegate and these extras are merged into one D-13 `BadRequestException`.
  - On success it returns the original body object, typed as `CreateEventDto`.
  - `expectedType` makes validation independent of emitted `design:paramtypes` metadata.
- R-05 Validation rules use built-in decorators where they match exactly (`@IsString`, `@Matches(/\S/)`, `@MaxLength`, `@IsObject`, each with the exact RF-02 message) plus one custom `ts` decorator (`@IsEventTimestamp`) that calls `parseEventTimestamp`. Decorator order on each property is chosen so `stopAtFirstError` reports the first rule in RF-02 order; unit tests pin this (class-validator's evaluation order follows decorator registration, which is bottom-up in source), so the implementer arranges decorators by test result, not by assumption.
- R-06 Timestamp parsing is one pure function `parseEventTimestamp(value: unknown): Date | null`, used by the decorator (validation) and by the service (normalization), so the D-10 profile exists once. Regex `^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$`, then explicit calendar checks (month 1–12, Gregorian leap years, day within month, hour ≤ 23, minute ≤ 59, second ≤ 59, offset hours ≤ 23, offset minutes ≤ 59). Milliseconds are the first three fraction digits right-padded with zeros (truncation). The instant is computed without `Date.UTC`'s two-digit-year mapping (use `setUTCFullYear` or an equivalent), so years `0000`–`0099` never map to 1900–1999. Accept only instants in `[1970-01-01T00:00:00.000Z, 9999-12-31T23:59:59.999Z]`.
- R-07 E2e tests set `process.env.MONGO_URI` and then load `AppModule` with a dynamic `await import('../src/app.module.js')`, because `ConfigModule.forRoot` snapshots the environment at import time (verified in `config.module.js`). Vitest isolates the module graph per test file. Scenarios that need a different `MONGO_URI` (CA-15) or destroy the database (CA-12) live in their own files.
- R-08 The test MongoDB version is pinned once in `package.json`: `"config": { "mongodbMemoryServer": { "version": "7.0.45", "disablePostinstall": "1" } }`. 7.0.45 is the newest 7.0 patch and matches the Compose `mongo:7.0` image. Postinstall is disabled so `npm ci` in the Docker build stage (Alpine, devDependencies installed) does not try to download a MongoDB binary; the binary is downloaded on the first e2e run instead (spec section 5 already designates that run as the confirmation point).
- R-09 Dependency versions: `mongodb@^7.8.0` (current major, supports MongoDB ≥ 4.4, so 7.0 is covered; supports `wtimeoutMS`) and dev `mongodb-memory-server@^11.3.0`. Install with `npm install` so `package-lock.json` stays consistent.
- R-10 The client closes in `onApplicationShutdown` (runs on `app.close()`). Rationale: the Phase 4 graceful drain will run in `beforeApplicationShutdown` and still needs the client. `enableShutdownHooks` is not added (Phase 4).
- R-11 D-11's "not-connected client" covers `MongoNotConnectedError`, `MongoTopologyClosedError` and `MongoClientClosedError` (the driver's errors for an operation on a client that is not, or no longer, connected). "Write-concern errors or timeouts" = `MongoWriteConcernError` (the driver's error for `wtimeout` failures). Network = `MongoNetworkError` (includes `MongoNetworkTimeoutError`). Server selection = `MongoServerSelectionError`. Labels = `MongoError#hasErrorLabel('RetryableWriteError' | 'TransientTransactionError')`. The E11000 check runs before classification.
- R-12 D-12 retry count: one initial read plus up to five retries, waiting 100 ms before each retry (`setTimeout` from `node:timers/promises`), so at most six reads and about 500 ms of waiting.
- R-13 Canonical JSON serializes directly to a string, never by rebuilding objects: `null`/booleans/numbers/strings via `JSON.stringify(value)`, arrays in order, objects as `{` + keys from `Object.keys(obj).sort()` (default UTF-16 code-unit order) each as `JSON.stringify(key) + ':' + value` + `}`, no whitespace. Reading values with `obj[key]` on own keys keeps keys such as `__proto__` and `constructor` safe. The key order rule is fixed from now on, because changing it would change stored keys.
- R-14 Warn line format (D-14/D-17): `Event store unavailable: <error.name>` plus ` (code <code>)` only when the error has a `code`; for exhausted retries `Event store unavailable: DuplicateNotVisible`. Logger: `new Logger(EventsService.name)`. Never the message, the payload or the key.
- R-15 Injection uses explicit string/symbol tokens for `MONGO_CLIENT` and `EVENTS_COLLECTION` and factory `inject: [ConfigService]`, so provider wiring is not affected by how the test transformer emits decorator metadata; CA-13 swaps the client with `overrideProvider(MONGO_CLIENT)` for one built with `monitorCommands: true`, without adding test hooks to production code. Rejected: the driver's internal `monitorCommands` setter (not in the public types).

### Compatibility

- `GET /health` keeps returning `200 { status: 'ok' }`. Boot now requires a reachable Mongo (D-07), which Compose already provides (`depends_on: service_healthy`).
- No env variables added or changed; no Compose or Dockerfile edits.
- The body parser change (R-01/R-02) only affects request bodies, which only `POST /events` reads.

### Sequencing rationale

Dependencies first, then pure helpers with unit tests (fast feedback, no Mongo), then the database module and service, then HTTP wiring and app setup, then e2e infrastructure and suites, then README, then the full quality gate.

## 5. Ordered tasks

### T-01 — Add dependencies and pin the test MongoDB version

- Outcome: `mongodb` and `mongodb-memory-server` installed and locked; test binary version pinned to 7.0.45 without install-time downloads.
- IDs: D-01, D-09, RNF-04.
- Depends on: none.
- Files: `package.json`, `package-lock.json`.
- Changes:
  1. Add to `package.json`: `"config": { "mongodbMemoryServer": { "version": "7.0.45", "disablePostinstall": "1" } }` (R-08) before installing.
  2. `npm install mongodb@^7.8.0` and `npm install --save-dev mongodb-memory-server@^11.3.0` (R-09).
- Invariants: no other dependency added; no Mongoose/TypeORM; existing scripts unchanged.
- Edge cases: if the registry is unreachable, stop and report the blocker (no substitute packages).
- Evidence: `package.json` diff shows exactly the two dependencies and the config block; `npm ls mongodb mongodb-memory-server` resolves.

### T-02 — Timestamp parser

- Outcome: `parseEventTimestamp(value: unknown): Date | null` implementing D-10 exactly (R-06).
- IDs: RF-02, RF-03, D-10.
- Depends on: none.
- Candidate files: `src/events/event-timestamp.ts`, `src/events/event-timestamp.spec.ts`.
- Changes: the regex, calendar and offset checks, truncation, safe UTC computation, 1970–9999 range.
- Invariants: returns `null` for any non-string; never rounds; uppercase `T`/`Z` only.
- Edge cases (unit-tested): no offset; no seconds; date only; lowercase `t`/`z`; `2026-02-30T00:00:00Z`; `2024-02-29T00:00:00Z` accepted, `2023-02-29…` rejected; `T24:00:00Z`; `:60` seconds; offset `+24:00` and `+23:60` rejected, `-23:59`/`+23:59` accepted; 10 fraction digits rejected; `1969-12-31T23:59:59.999Z` rejected; `1970-01-01T00:00:00Z` accepted; `1970-01-01T00:30:00+01:00` rejected (UTC 1969); `0070-01-01T00:00:00Z` rejected; `9999-12-31T23:59:59.999Z` accepted; `9999-12-31T23:00:00-05:00` rejected; `.1239` → `.123`; `2026-11-02T13:00:00Z` equals `2026-11-02T10:00:00.000-03:00`; 9 digits with `+05:30` truncated correctly.
- Evidence: `npm test` passes these cases (planned).

### T-03 — Canonical JSON and idempotency key

- Outcome: `canonicalJson(value)` and `computeIdempotencyKey({ data, patientId, ts: Date, type }): string` per D-03 and R-13, hashing with `node:crypto` `createHash('sha256').update(json, 'utf8').digest('hex')`.
- IDs: RF-03, D-03, CA-06.
- Depends on: T-02 (tests combine parsing and hashing for equivalent `ts` renderings).
- Candidate files: `src/events/idempotency-key.ts`, `src/events/idempotency-key.spec.ts`.
- Changes: the hash input is exactly `{ data, patientId, ts: ts.toISOString(), type }` serialized with sorted keys.
- Invariants: no Unicode normalization; array order preserved; output `/^[0-9a-f]{64}$/`.
- Edge cases (unit-tested, CA-06): reordered keys at depth ≥ 2 give the same key; equivalent `ts` renderings (via T-02) give the same key; different key for array order, `1` vs `"1"`, `ts` +1 ms, `'p1'` vs `' p1'`, any `type`/`data` value change; `{}` data; non-ASCII strings; keys named `constructor`/`__proto__` inside `data` serialize as normal keys.
- Evidence: `npm test` (planned).

### T-04 — DTO and body pipe

- Outcome: `CreateEventDto` as the single source of validation rules, and `EventBodyPipe` producing the D-13 error shape and returning the untouched body (R-02, R-04, R-05).
- IDs: RF-02, D-05, D-06, D-13, D-16 (scope boundary only), RNF-03, CA-08 (unit part), CA-10 (unit part).
- Depends on: T-02.
- Candidate files: `src/events/create-event.dto.ts`, `src/events/is-event-timestamp.decorator.ts` (or inside the DTO file), `src/events/event-body.pipe.ts`, `src/events/event-body.pipe.spec.ts`.
- Changes:
  - DTO fields `patientId`, `type`, `ts`, `data` with the RF-02 messages: `patientId must be a string` / `must not be blank` / `must be at most 128 characters`; same for `type` with 64; `ts must be an ISO 8601 date-time with a timezone offset`; `data must be a JSON object`.
  - Pipe as in R-04, including the R-02 non-object rule and the reserved top-level key rule.
- Invariants: no trimming or normalization of any value (D-06); `MaxLength` counts `String.prototype.length` (UTF-16 code units); messages never contain values except the client-sent key name in `property k should not exist` (RNF-03); returned object is the same reference as the input body.
- Edge cases (unit-tested): each RF-02 rule produces exactly its message and only the first failing rule per field (for example `patientId: 7` → only `patientId must be a string`; a 129-character whitespace string → only `must not be blank`); 128/64 accepted, 129/65 rejected; `'   '` blank; `data` `null`/array/string/missing; `ts` non-string; `[]`, `"x"`, `1`, `null`, `undefined` bodies → the four first-rule messages; extra `source` → `property source should not exist`; top-level `constructor` → `property constructor should not exist`; a valid body with `data: { constructor: 1, prototype: { x: 1 } }` passes and the returned `data` still deep-equals the input.
- Evidence: `npm test` (planned).

### T-05 — Database module

- Outcome: one shared `MongoClient`, connected at init, unique index created before listening, closed on `app.close()`.
- IDs: RF-05, D-01, D-04, D-07.
- Depends on: T-01.
- Candidate files: `src/database/database.tokens.ts` (`MONGO_CLIENT`, `EVENTS_COLLECTION`, `EVENTS_COLLECTION_NAME = 'events'`), `src/database/database.module.ts`, `src/database/database.lifecycle.ts` (or the module class itself implementing the hooks), `src/events/event.document.ts` (the `EventDocument` type and `EventStatus` union `'pending' | 'processing' | 'done' | 'failed'` from PLAN Phase 2, of which this phase writes only `'pending'`).
- Changes:
  - `MONGO_CLIENT` factory: `new MongoClient(config.get('MONGO_URI', { infer: true }), { serverSelectionTimeoutMS: 5000 })` with a code constant and a short comment (D-04).
  - `EVENTS_COLLECTION` factory: `client.db().collection<EventDocument>('events')` (database from the URI).
  - `onModuleInit`: `await client.connect()`; `await collection.createIndex({ idempotencyKey: 1 }, { unique: true, name: 'idempotencyKey_unique' })`. Errors propagate so `app.init()`/`listen()` rejects (D-07).
  - `onApplicationShutdown`: `await client.close()` (R-10).
  - Export both tokens; import `DatabaseModule` in `EventsModule` (or make it global; either keeps one client).
- Invariants: no other index created (no claim or read-order indexes); no new env variables; no `enableShutdownHooks`.
- Edge cases: unreachable URI rejects within about 5 s (CA-15); an existing conflicting index makes init fail (accepted D-07 behaviour).
- Evidence: CA-13 and CA-15 e2e (planned).

### T-06 — Store-error classification and events service

- Outcome: `EventsService.ingest(body)` implementing RF-03, RF-04, RF-06, D-02, D-11, D-12, D-14, D-15, D-17.
- IDs: RF-03, RF-04, RF-06, D-02, D-11, D-12, D-14, D-15, D-17, RNF-03, RNF-04.
- Depends on: T-02, T-03, T-05.
- Candidate files: `src/events/store-errors.ts` (`isDuplicateIdempotencyKey(err)`, `isStoreUnavailable(err)`), `src/events/events.service.ts`, `src/events/events.service.spec.ts`.
- Changes:
  - Build the document: `_id: new ObjectId()`, `idempotencyKey`, `patientId`, `type`, `data` (original references), `ts` (parsed `Date`), `receivedAt = nextAttemptAt = new Date()` (same instance value), `status: 'pending'`, `attempts: 0`. No other fields.
  - `insertOne(doc, { writeConcern: { w: 'majority', wtimeoutMS: 5000 } })` (constants with comment, D-04).
  - Duplicate: `err instanceof MongoServerError && err.code === 11000` and the key pattern/value names `idempotencyKey`; then `findOne({ idempotencyKey }, { readConcern: { level: 'majority' }, readPreference: 'primary', projection: { _id: 1, status: 1 } })` with R-12 retries; return `{ id, status, duplicate: true }`. Never update the existing document.
  - Unavailable: R-11 classification, R-14 warn line, throw `ServiceUnavailableException('Event store unavailable, retry later')` (renders the D-11 body). Retries exhausted: `DuplicateNotVisible` warn, same exception. Any other error is rethrown unchanged (default 500).
  - No logging on accept or duplicate.
- Invariants: no `202` unless the insert was acknowledged with majority, or the duplicate was read with majority read concern from the primary; `id` is `toHexString()` (24 lowercase hex); response object has exactly `id`, `status`, `duplicate`.
- Edge cases (unit-tested with a fake collection and a capturing logger): E11000 then found on first read; E11000 then found after two `null` reads; E11000 then six `null` reads → 503 with one warn `…DuplicateNotVisible`; insert throws each R-11 class or a labelled `MongoError` → 503 with one warn containing the class name and no payload/key; findOne throws `MongoServerSelectionError` → 503; E11000 on a different key or a generic `Error` → rethrown (500); write-concern error message never logged.
- Evidence: `npm test` (planned); e2e CA-01 to CA-07, CA-12 (planned).

### T-07 — Controller and module wiring

- Outcome: `POST /events` served with `202` and the D-15 body.
- IDs: RF-01, D-15.
- Depends on: T-04, T-05, T-06.
- Candidate files: `src/events/events.controller.ts`, `src/events/events.module.ts`, `src/app.module.ts`.
- Changes: `@Controller('events')`, `@Post()`, `@HttpCode(202)`, `create(@Body(EventBodyPipe) body: CreateEventDto)` returning the service result; `EventsModule` imports `DatabaseModule`, provides `EventsService`; `AppModule` imports `EventsModule` (and `DatabaseModule` if global). No `Location` header.
- Invariants: `HealthModule` and `ConfigModule` registration unchanged; `/health` untouched.
- Evidence: e2e CA-01, CA-16 (planned).

### T-08 — Shared application setup (body parser, malformed JSON)

- Outcome: identical HTTP wiring in production and tests; D-16 behaviour; non-JSON content types fail validation.
- IDs: RF-01, RF-02, D-16, RNF-03, RNF-04 (100 kb limit), CA-10, CA-11.
- Depends on: none (can be done in parallel with T-05/T-06; must be done before T-09).
- Candidate files: `src/app.setup.ts`, `src/main.ts`.
- Changes:
  - Export `appOptions: NestApplicationOptions = { bodyParser: false }` and `configureApp(app: NestExpressApplication): void` which calls `app.useBodyParser('json', { strict: false })` and then `app.use(<R-03 error middleware>)`.
  - `src/main.ts`: `NestFactory.create<NestExpressApplication>(AppModule, appOptions)`, `configureApp(app)`, then the existing `listen(PORT)`.
- Invariants: no global `ValidationPipe` (validation is scoped to the events body via `EventBodyPipe`); no body `limit` option (keeps Express's 100 kb default); the parser error message is never forwarded for `entity.parse.failed`.
- Edge cases: `{"a":` and `{"patientId":p-secret-123}` → fixed 400; > 100 kb → 413 (Nest maps `PayloadTooLargeError`); `Content-Type: application/x-www-form-urlencoded` or `text/plain` → body not parsed → four first-rule messages.
- Evidence: e2e CA-10, CA-11 and the extra RF-02 checks (planned).

### T-09 — E2e test support and `/health` migration

- Outcome: reusable in-memory replica-set helpers; the `/health` e2e test runs against Mongo.
- IDs: D-09, CA-16, RF-05.
- Depends on: T-01, T-07, T-08.
- Candidate files: `test/support/mongo.ts` (start a one-member `MongoMemoryReplSet`, version from the `package.json` config, return `{ uri, stop }`; `getUri('<per-file db name>')`), `test/support/app.ts` (set `process.env.MONGO_URI`, dynamic-import `AppModule`, build the testing module with optional provider overrides, `createNestApplication<NestExpressApplication>(appOptions)`, `configureApp`, optional `useLogger`, `init`), `test/support/capture-logger.ts` (a `LoggerService` that records `level` and the serialized message), `test/app.e2e-spec.ts`.
- Changes: rewrite `test/app.e2e-spec.ts` to start the replica set in `beforeAll` (hook timeout ≥ 120 s for the first binary download), build the app via the helper, and keep the assertion `GET /health` → `200 { status: 'ok' }`; stop the app and replica set in `afterAll`.
- Invariants: no change to `vitest.config*.ts`; timeouts are per hook/test; helpers are not `*.spec.ts` so they are not collected as tests; ESM `.js` import suffixes.
- Edge cases: parallel test files each start their own mongod (fresh database per file, D-09); a failed binary download is reported as a blocker (spec section 5), not worked around.
- Evidence: `npm run test:e2e` (planned).

### T-10 — Events e2e suite

- Outcome: e2e coverage of the ingest contract against a real 7.0.45 replica set.
- IDs: RF-01 to RF-05, D-02, D-03, D-05, D-06, D-10, D-13, D-15, D-16, RNF-03, RNF-04; CA-01 to CA-11, CA-13, CA-14, CA-17 (CA-01/CA-08 parts).
- Depends on: T-09.
- Candidate file: `test/events.e2e-spec.ts`.
- Setup: one replica set and app per file; the app built with `overrideProvider(MONGO_CLIENT)` using `new MongoClient(uri, { serverSelectionTimeoutMS: 5000, monitorCommands: true })` and a `commandStarted` listener (R-15); a capture logger; `deleteMany({})` on `events` before each test (index kept); a separate test client for DB assertions; fictional data (`p-test-1`).
- Scenarios:
  - CA-01: 202, body keys exactly `id`/`status`/`duplicate`, `id` matches `/^[0-9a-f]{24}$/`, document with that `_id` exists.
  - CA-02: stored keys exactly the D-02 set; `idempotencyKey` 64 hex; `ts` equals the normalized `Date`; `receivedAt` is a `Date`; `nextAttemptAt` equals `receivedAt`; `status 'pending'`; `attempts 0`; `patientId`/`type`/`data` deep-equal the request.
  - CA-03: identical repost → `{ id: same, status: 'pending', duplicate: true }`; count 1; stored document deep-equal before/after.
  - CA-04: nested key reorder plus `ts` in another offset with a fraction truncating to the same ms → duplicate, same id, count 1.
  - CA-05: four pairs (array order, `1` vs `"1"`, `ts` +1 ms, `'p1'` vs `' p1'`) → two documents each, different keys, both `duplicate: false`.
  - CA-07: 20 concurrent identical POSTs → all 202, same id, exactly one `duplicate: false`, count 1.
  - CA-08: `it.each` over every RF-02 rule and the listed `ts` variants → 400, `error: 'Bad Request'`, `message` contains the exact string; collection empty.
  - CA-09: boundary values → 202 `duplicate:false`; stored `ts` equals the truncated UTC ms instant.
  - CA-10: extra `source` → 400 with `property source should not exist`; `[]` → 400; both malformed bodies → exactly the D-16 body and response text without `secret`; collection empty.
  - CA-11: about 150 kb `data` string → 413; collection empty.
  - CA-13: the captured `insert` command has `writeConcern.w === 'majority'`; `listIndexes` returns `_id_` and `idempotencyKey_unique` (`unique: true`, key `{ idempotencyKey: 1 }`) only.
  - CA-14: `data: { "$set": 1, "a.b": 2 }` → 202 `duplicate:false`, stored `data` deep-equals the input. If the insert fails, stop and report (spec section 5: return to `/create-spec`); do not escape or reject.
  - CA-17 (parts): during CA-01 and CA-08 no captured log line contains the sent `patientId`, `type`, `ts`, any `data` value or the stored idempotency key.
  - Extra RF-02 checks: urlencoded body and `text/plain` body → 400 with the four first-rule messages, collection empty; JSON primitive body `"x"` → same; top-level `constructor` key → 400 `property constructor should not exist`; `data: { constructor: 1, prototype: { x: 1 } }` → 202 and stored `data` deep-equal.
- Evidence: `npm run test:e2e` (planned).

### T-11 — Store-down and startup-failure e2e

- Outcome: proof of 503 mapping, warn-only logging, and fail-fast bootstrap.
- IDs: RF-05, RF-06, D-04, D-07, D-11, D-14, RNF-03, RNF-04; CA-12, CA-15, CA-17 (CA-12 part).
- Depends on: T-09.
- Candidate files: `test/events-store-down.e2e-spec.ts`, `test/startup-failure.e2e-spec.ts`.
- Changes:
  - Store down: start the replica set, build and `init` the app with a capture logger, stop the replica set, POST a valid event; assert exactly the D-11 body with status 503, elapsed ≤ 15 s (test timeout ≥ 20 s), no 202, exactly one `warn` line containing a driver error class name (`Mongo…Error`) and none containing payload values; then `app.close()`.
  - Startup failure: set `MONGO_URI=mongodb://127.0.0.1:1/x?directConnection=true` before the dynamic import; assert `app.init()` rejects within 15 s; no `listen` is called; `app.close()` in `finally` so no handle leaks.
- Evidence: `npm run test:e2e` (planned).

### T-12 — README section

- Outcome: short `POST /events` documentation.
- IDs: RF-01, RF-02, RF-06, D-08, D-15, D-16.
- Depends on: T-07, T-08 (documents the implemented contract).
- File: `README.md`.
- Changes: new section after "Running" or before "Tests": request shape and example, `202` (new and duplicate, with the content-hash dedup note from D-03/G1), `400` (validation and malformed JSON), `413` (> 100 kb), `503` (retry later, retries are idempotent), known limit "no authentication; deploy behind a gateway or mTLS" (D-08). Update the `Tests` section only if wording becomes wrong (e2e now downloads MongoDB 7.0.45 on first run).
- Invariants: existing sections (configuration table, MongoDB 7.0 note) unchanged; no architecture docs (Phase 8).
- Evidence: README diff.

### T-13 — Quality gate

- Outcome: format, lint, build and all tests pass.
- IDs: CA-16, CA-18, RNF-04.
- Depends on: T-01 to T-12.
- Changes: run `npm run format` (existing script) and fix any lint/type findings within scope.
- Evidence: exit codes and output of `npm test`, `npm run test:e2e`, `npm run lint`, `npm run build` (planned), recorded in the implementation report with Node and MongoDB versions.

## 6. Verification plan

All checks are planned. None has been executed.

| Check | Command / procedure | Criteria | Expected evidence |
| --- | --- | --- | --- |
| V-01 Unit tests | `npm test` | CA-06, CA-08 (DTO/pipe), CA-10 (pipe), CA-16 (existing `env.validation.spec.ts`), D-10, D-11, D-12, D-17 | All suites pass, including `env.validation.spec.ts` unchanged |
| V-02 Events e2e | `npm run test:e2e` (`test/events.e2e-spec.ts`) | CA-01 to CA-11, CA-13, CA-14, CA-17 (CA-01/CA-08) | Pass; assertions on HTTP responses, DB state, captured `insert` command, `listIndexes`, logger capture |
| V-03 Store-down e2e | `npm run test:e2e` (`test/events-store-down.e2e-spec.ts`) | CA-12, CA-17 (CA-12) | 503 D-11 body within 15 s; one warn line with class name |
| V-04 Startup failure e2e | `npm run test:e2e` (`test/startup-failure.e2e-spec.ts`) | CA-15 | `init()` rejects within 15 s |
| V-05 Health regression | `npm run test:e2e` (`test/app.e2e-spec.ts`) | CA-16 | `GET /health` → 200 `{ status: 'ok' }` |
| V-06 Lint | `npm run lint` | CA-18 | Exit 0 |
| V-07 Build | `npm run build` | CA-18 | Exit 0; `dist/` has no test files |
| V-08 Optional manual QA | `docker compose up --build`, then twice `curl -i -XPOST localhost:3000/events -H 'content-type: application/json' -d '{"patientId":"p-demo","type":"vitals","ts":"2026-11-02T10:00:00Z","data":{"hr":72}}'` | RF-01, RF-04, D-08 (no credentials needed) | `202 … "duplicate":false`, then `202 … "duplicate":true`; Docker build still succeeds with postinstall disabled |

Setup and limitations:

- The first `npm run test:e2e` downloads MongoDB 7.0.45 for the host platform (network access to `fastdl.mongodb.org`). A failure is an implementation blocker to report (spec section 5).
- Multi-node failover is not reproducible on a single-node replica set; CA-12 and the D-11 unit tests cover the mapping (spec section 11).
- V-08 requires Docker and is optional per the spec; if skipped, record it as not run.
- Record the Node version, the MongoDB version reported by the memory server, and pass/fail/blocked per CA in the implementation report.

## 7. Risk and recovery

- Regression surface:
  - Boot now requires Mongo (D-07); local `npm run start:dev` without `docker compose up -d mongo` fails fast. Accepted by the spec; README already documents starting Mongo first.
  - The body-parser wiring (R-01/R-02/R-03) changes parsing for every route: urlencoded bodies are no longer parsed and JSON primitives are accepted by the parser. Only `POST /events` reads bodies.
  - Every e2e file now starts a mongod; e2e runtime grows and the first run downloads a binary.
- Data: creates the `events` collection and `idempotencyKey_unique` index on first start in whatever database `MONGO_URI` names (the Compose `mongo-data` volume persists them). No migration. Rolling back the code leaves the collection and index in place; dropping them is a destructive action that needs separate authority and is not part of this plan.
- Compatibility: no env, Compose or Dockerfile changes. The pinned key derivation (D-03, R-13) becomes a stored-data contract; changing it later would break dedup against existing documents.
- Driver behaviour: a retryable write retried after a network error during failover could return E11000 for the request's own first write, reporting `duplicate: true` with no `duplicate: false` sibling. Not reproducible on one node; not covered by CA-07 conditions.
- Unexpected (non-D-11) errors keep Nest's default 500 handling, which logs the error message and stack; a driver message could in principle include values (for example a dup-key message on a different index). The handled E11000 path never logs.
- External actions: `npm install` (registry) and the MongoDB binary download (test runtime). No publication, no commits (spec section 12: commits only on user request).
- Recovery: `git restore`/`git revert` of the implementation commits; `npm install` restores the previous lockfile state.

## 8. Coverage matrix

| ID | Tasks | Checks |
| --- | --- | --- |
| RF-01 | T-07, T-08, T-12 | V-02 (CA-01, CA-11), V-08 |
| RF-02 | T-02, T-04, T-08, T-10 | V-01, V-02 (CA-08, CA-09, CA-10, extra RF-02 checks) |
| RF-03 | T-02, T-03, T-06 | V-01 (CA-06), V-02 (CA-04, CA-05) |
| RF-04 | T-06, T-10 | V-02 (CA-01, CA-02, CA-03, CA-07, CA-13, CA-14) |
| RF-05 | T-05, T-09, T-11 | V-02 (CA-13), V-04 (CA-15), V-05 |
| RF-06 | T-06, T-11, T-12 | V-01, V-03 (CA-12) |
| RNF-01 | Not applicable — backend-only API, no UI (spec) | Not applicable |
| RNF-02 | Not applicable — no UI (spec) | Not applicable |
| RNF-03 | T-04, T-06, T-08, T-10, T-11 | V-02 (CA-10, CA-17), V-03 (CA-17) |
| RNF-04 | T-01, T-06, T-08, T-13 | V-02 (CA-07, CA-11), V-03, V-06, V-07 |
| D-01 | T-01, T-05 | V-06, V-07, V-02 |
| D-02 | T-05, T-06 | V-02 (CA-02, CA-13) |
| D-03 | T-03 | V-01 (CA-06), V-02 (CA-04) |
| D-04 | T-05, T-06 | V-03 (CA-12), V-04 (CA-15) |
| D-05 | T-04 | V-01, V-02 (CA-10) |
| D-06 | T-04 | V-01, V-02 (CA-05, CA-08, CA-09) |
| D-07 | T-05 | V-04 (CA-15) |
| D-08 | T-12 | V-08 (no credentials), README diff |
| D-09 | T-01, T-09 | V-02 to V-05 |
| D-10 | T-02, T-04 | V-01, V-02 (CA-04, CA-08, CA-09) |
| D-11 | T-06 | V-01, V-03 (CA-12) |
| D-12 | T-06 | V-01, V-02 (CA-03, CA-07) |
| D-13 | T-04 | V-01, V-02 (CA-08) |
| D-14 | T-06 | V-01, V-02 (CA-17), V-03 (CA-17) |
| D-15 | T-06, T-07 | V-02 (CA-01, CA-03) |
| D-16 | T-08 | V-02 (CA-10) |
| D-17 | T-06 | V-01 |
| CA-01 | T-06, T-07, T-10 | V-02 |
| CA-02 | T-06, T-10 | V-02 |
| CA-03 | T-06, T-10 | V-02 |
| CA-04 | T-02, T-03, T-10 | V-02 |
| CA-05 | T-03, T-10 | V-02 |
| CA-06 | T-03 | V-01 |
| CA-07 | T-06, T-10 | V-02 |
| CA-08 | T-02, T-04, T-10 | V-01, V-02 |
| CA-09 | T-02, T-04, T-10 | V-02 |
| CA-10 | T-04, T-08, T-10 | V-01, V-02 |
| CA-11 | T-08, T-10 | V-02 |
| CA-12 | T-06, T-11 | V-03 |
| CA-13 | T-05, T-06, T-10 | V-02 |
| CA-14 | T-06, T-10 | V-02 |
| CA-15 | T-05, T-11 | V-04 |
| CA-16 | T-09, T-13 | V-01, V-05 |
| CA-17 | T-06, T-10, T-11 | V-02, V-03 |
| CA-18 | T-13 | V-06, V-07 |

## 9. Implementation handoff

- Prerequisites: npm registry access; network access for the MongoDB 7.0.45 binary on the first e2e run; Node 24. Docker only for optional V-08.
- Permitted scope: `package.json`, `package-lock.json`, `src/app.module.ts`, `src/main.ts`, new `src/app.setup.ts`, new files under `src/database/` and `src/events/`, `test/app.e2e-spec.ts`, new files under `test/` (`test/support/`, events e2e files), `README.md`. Not permitted: `src/config/*`, `src/health/*`, `Dockerfile`, `docker-compose.yml`, `vitest.config*.ts`, `.oxlintrc.json`, the spec, telemetry (`AGENTS.md` Observe), worker/claim/read-order features, commits.
- Known non-blocking risks:
  - CA-14 (`$`/`.` keys in `data`) and the binary download are assumption checks; if either fails, stop and report as the spec directs.
  - Decorator order under `stopAtFirstError` (R-05) must be set by unit-test result.
  - Test transformer decorator metadata: production DI uses `tsc` metadata; tests run through Vite 8/rolldown, which supports `emitDecoratorMetadata` from tsconfig. Explicit tokens (R-15) and `expectedType` (R-04) limit exposure; class-typed injection of `EventsService` into the controller relies on metadata and is exercised by every e2e test.
  - Failover-time duplicate reporting and default-500 logging (section 7).
- Interpretations recorded (low-risk, within the spec's stated outcomes): R-01 to R-04 (parser wiring and body pipe), R-08 (test version 7.0.45, postinstall disabled), R-11 (closed-client errors count as "not connected"), R-12 (one read plus five retries), R-13 (UTF-16 key sort), R-14 (warn line format).
- Confirmation: no blocking ambiguity remains. The spec is the source of truth; if implementation evidence contradicts it, stop and route back to `/create-spec`.
