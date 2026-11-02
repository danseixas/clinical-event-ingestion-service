# Implementation report: events-ingest-path

## 1. Identity and result

- Result: COMPLETE (optional manual QA V-08 not run; see section 6).
- Date: 2026-11-02.
- Spec: `.ai/.specs/events-ingest-path.md`, SHA-256 `6d9c795c2056fff37d961aac3943b9fb186c3a4922230a536d495932524af3a2` (recomputed, matches the plan).
- Plan: `.ai/.plans/events-ingest-path.md`, SHA-256 `15c14aaefc401237b4a1bb9318bd460a72e9404982db634eb399bae603fd2971`.
- Repository: `clinical-event-ingestion-service` only.

## 2. Starting state

- Branch `main`, HEAD `e2aebeb`.
- Pre-existing uncommitted changes: only untracked `.ai/` (spec, template, plan) and `.claude/` (agents and skills). No tracked file was modified. None overlap the planned files.
- Environment: Node v24.21.0, arm64 darwin.

## 3. Task execution

- T-01 completed: `package.json` (`mongodb@^7.8.0`, dev `mongodb-memory-server@^11.3.0`, `config.mongodbMemoryServer` = 7.0.45 with `disablePostinstall`), `package-lock.json` via `npm install`.
- T-02 completed: `src/events/event-timestamp.ts` (+ spec). RF-02, RF-03, D-10.
- T-03 completed: `src/events/idempotency-key.ts` (+ spec). RF-03, D-03, CA-06.
- T-04 completed: `src/events/create-event.dto.ts`, `is-event-timestamp.decorator.ts`, `event-body.pipe.ts` (+ spec). RF-02, D-05, D-06, D-13. Decorator order was set bottom-up and confirmed by the unit tests on the first run.
- T-05 completed: `src/database/database.tokens.ts`, `database.module.ts` (connect and unique index in `onModuleInit`, close in `onApplicationShutdown`), `src/events/event.document.ts`. RF-05, D-01, D-04, D-07.
- T-06 completed: `src/events/store-errors.ts`, `events.service.ts` (+ spec). RF-03, RF-04, RF-06, D-02, D-11, D-12, D-14, D-17.
- T-07 completed: `src/events/events.controller.ts`, `events.module.ts`, `src/app.module.ts` (imports `EventsModule`). RF-01, D-15.
- T-08 completed: `src/app.setup.ts` (`appOptions`, `configureApp`: JSON-only parser with `strict: false`, malformed JSON translated to the fixed 400), `src/main.ts`. D-16.
- T-09 completed: `test/support/mongo.ts`, `app.ts`, `capture-logger.ts`; `test/app.e2e-spec.ts` rewritten to use the in-memory replica set.
- T-10 completed: `test/events.e2e-spec.ts` (CA-01 to CA-05, CA-07 to CA-11, CA-13, CA-14, CA-17 accept/reject parts, extra RF-02 checks).
- T-11 completed: `test/events-store-down.e2e-spec.ts` (CA-12, CA-17), `test/startup-failure.e2e-spec.ts` (CA-15).
- T-12 completed: `README.md` `POST /events` section and the e2e note in Tests.
- T-13 completed: format, lint, build, unit and e2e run (section 6).

## 4. Behavior delivered

`POST /events` validates the body, normalizes `ts`, computes the SHA-256 canonical key and inserts the full initial document with `w: 'majority', wtimeoutMS: 5000`. New events return `202 { id, status: 'pending', duplicate: false }`. E11000 on `idempotencyKey` triggers a majority/primary read (up to 5 retries, 100 ms apart) and returns `duplicate: true`. Validation, malformed JSON, oversize and store-unavailable cases return 400/400/413/503 per the spec. The app connects to Mongo and creates only `idempotencyKey_unique` at init, and fails to start otherwise. `GET /health` is unchanged.

## 5. Deviations

None. Small implementation choices inside the plan: the `express` types are imported with `import type` in `src/app.setup.ts`; the service unit specs replace the private `logger` field with a stub; the e2e events suite calls `app.listen(0)` so supertest reuses one server.

## 6. Verification evidence

Environment: Node v24.21.0; MongoDB memory server binary `mongod-arm64-darwin-7.0.45` (found in `~/.cache/mongodb-binaries`).

Passed:
- `npm test`: 5 files, 97 tests passed (includes unchanged `env.validation.spec.ts`). CA-06, CA-16 (unit), V-01.
- `npm run test:e2e`: 4 files, 44 tests passed. CA-01 to CA-05, CA-07 to CA-15, CA-17, CA-16 (`/health`), V-02 to V-05. CA-14 and the binary download assumptions held.
- `npm run lint`: exit 0, no warnings after one fix (CA-18).
- `npm run build`: exit 0; no spec files in `dist/` (CA-18).
- `npm run format` applied.

Failed: none after repair of my own test fixtures (a wrong `MongoWriteConcernError` fixture and supertest request construction), both within scope.

Not run: V-08 manual QA (`docker compose up --build` and curl); Docker build with the postinstall setting was not exercised.

## 7. Changed-file inventory (this run)

Modified: `package.json`, `package-lock.json`, `src/app.module.ts`, `src/main.ts`, `test/app.e2e-spec.ts`, `README.md`.
Created: `src/app.setup.ts`; `src/database/{database.module,database.tokens}.ts`; `src/events/{create-event.dto,is-event-timestamp.decorator,event-body.pipe,event-timestamp,idempotency-key,store-errors,events.service,events.controller,events.module,event.document}.ts` and specs `event-body.pipe`, `event-timestamp`, `idempotency-key`, `events.service`; `test/events.e2e-spec.ts`, `test/events-store-down.e2e-spec.ts`, `test/startup-failure.e2e-spec.ts`; `test/support/{mongo,app,capture-logger}.ts`; this report.
Nothing deleted, staged or committed. `dist/` was rebuilt (ignored by git).

## 8. Outstanding work and blockers

None. The multi-node failover and the V-08 manual check remain unverified, as the spec allows.

## 9. Assessment handoff

Ready for `/assess-spec`. No acceptance approval is claimed.
