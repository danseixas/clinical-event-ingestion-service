# Implementation report: events-data-model

## 1. Identity and result

- Result: COMPLETE
- Date: 2026-11-02
- Spec: `.ai/.specs/events-data-model.md`, SHA-256 `50c715bad8118e91773ed60d99ed99f8d3ca15d0a784312cc97189ffd883ecc2`
- Plan: `.ai/.plans/events-data-model.md`, SHA-256 `62a89037c5198b6c71fbe734e476f38209349aab0f9a1005b01306e03296f768`
- Repository: `clinical-event-ingestion-service` only.

## 2. Starting state

- Branch `main`, HEAD `75542a2`.
- Pre-existing uncommitted changes (not from this run): untracked `.ai/.plans/events-data-model.md` and `.ai/.specs/events-data-model.md`. No overlap with planned files.

## 3. Task execution

- T-01 completed: `src/events/event.document.ts` adds `EventError`, five optional fields and doc comments (RF-01, D-03, D-04, D-05).
- T-02 completed: new `src/events/event.document.spec.ts` with `satisfies` fixtures, three `@ts-expect-error` negatives and one runtime `it` (CA-01).
- T-03 completed: new `src/events/patient-events.ts` with `PATIENT_READ_ORDER` and `findPatientEvents` (RF-03, D-07, D-08).
- T-04 completed: `src/database/database.module.ts` exports the three name constants and `EVENTS_INDEXES`; `onModuleInit` creates them sequentially with no try/catch (RF-02, D-06, D-11).
- T-05 completed: `test/events.e2e-spec.ts` index-list assertion now expects the four names (D-09).
- T-06 completed: new `test/events-data-model.e2e-spec.ts` covering CA-02 to CA-09 and CA-11 (CA-09 as two cases via `it.each`).
- T-07 completed: Prettier run on touched files, then the verification commands below.

## 4. Behavior delivered

- Startup ensures `idempotencyKey_unique`, `claim_status_nextAttemptAt` and `patient_read_order`, in that order. Any rejection fails bootstrap.
- `findPatientEvents(collection, patientId)` returns a cursor in `ts`, `receivedAt`, `_id` order. It is not wired to any route or provider.
- No change to `POST /events`, `EventsService`, config, dependencies or README. No documents are modified.

## 5. Deviations

- The plan's optional extra assertion in CA-09 case two (`patient_read_order` absent) was not added.
- Otherwise none. No `hint` was used in CA-04 or CA-05.

## 6. Verification evidence

Environment: Node v24.21.0, MongoDB 7.0.45 (mongodb-memory-server, one-member replica set).

Passed:
- `npm run build`: exit 0; `dist` contains no spec files (CA-01).
- `npm run lint`: no findings (CA-01, RNF-04).
- `npx tsc --noEmit --incremental false -p tsconfig.json`: exit 0, so all `@ts-expect-error` are used (CA-01).
- `npm test`: 6 files, 98 tests passed (CA-01, CA-10).
- `npm run test:e2e`: 5 files, 53 tests passed, including the new suite (CA-02 to CA-09, CA-11), the updated Phase 1 index assertion and the health and startup-failure suites (CA-10). This includes CA-04 and CA-05 (IXSCAN on the named index, no SORT) and CA-08 (concurrent startup succeeded).

Not run:
- V-07 manual `docker compose` check on an existing volume.
- V-06 was a manual `git status` review only; no `git diff --stat` was captured. Status showed only the files listed below changed.
- A grep-based audit for `Logger`/`console` in `src/` was not run; the new `src/` code has none by inspection.

## 7. Changed-file inventory

- Modified: `src/events/event.document.ts`, `src/database/database.module.ts`, `test/events.e2e-spec.ts` (index assertion only).
- Created: `src/events/event.document.spec.ts`, `src/events/patient-events.ts`, `test/events-data-model.e2e-spec.ts`, `.ai/.implementations/events-data-model.md`.

## 8. Outstanding work and blockers

None.

## 9. Assessment handoff

Ready for `/assess-spec`. No acceptance approval is claimed.
