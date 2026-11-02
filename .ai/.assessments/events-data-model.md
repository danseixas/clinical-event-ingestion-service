# Assessment report: events-data-model

## 1. Identity and overall result

- Overall result: **PASS**
- Date: 2026-11-02
- Assessor: spec-assessor (independent; `/assess-spec`)
- Environment: macOS (darwin, arm64), Node v24.21.0, `mongodb` driver ^7.8.0, `mongodb-memory-server` ^11.3.0 running MongoDB 7.0.45 as a one-member replica set, vitest 4.1.12.
- Spec: `.ai/.specs/events-data-model.md`
- Plan: `.ai/.plans/events-data-model.md`
- Implementation report: `.ai/.implementations/events-data-model.md`
- Assessed fingerprints (before the status update):
  - Spec SHA-256 `50c715bad8118e91773ed60d99ed99f8d3ca15d0a784312cc97189ffd883ecc2`
  - Plan SHA-256 `62a89037c5198b6c71fbe734e476f38209349aab0f9a1005b01306e03296f768`
- Repository: `clinical-event-ingestion-service`, branch `main`, HEAD `75542a2`, uncommitted working tree:
  - Modified: `src/database/database.module.ts`, `src/events/event.document.ts`, `test/events.e2e-spec.ts`
  - Untracked: `src/events/event.document.spec.ts`, `src/events/patient-events.ts`, `test/events-data-model.e2e-spec.ts`, `.ai/.specs|.plans|.implementations/events-data-model.md`

## 2. Handoff integrity

| Check | Result |
| --- | --- |
| Spec exists, uniquely named `events-data-model` under `.ai/.specs/` | OK |
| Plan `Spec SHA-256` (plan line 8) equals recomputed spec hash | OK, exact match |
| Implementation report spec and plan hashes (lines 7–8) equal recomputed hashes | OK, exact match |
| Report's changed-file inventory vs `git status --porcelain` | Matches exactly. No other tracked file changed (`git diff HEAD --stat`: 3 files, +69/−8). |
| Report's claim "no dependency/lockfile/config/README changes" | Confirmed. `package.json`, `package-lock.json`, `Dockerfile`, `docker-compose.yml`, `README.md`, `src/config/`, `src/events/events.service.ts` have no diff. |
| Report's test counts (unit 98, e2e 53) | Reproduced independently (section 5). |
| Report's declared deviation (optional extra CA-09 assertion not added) | Plan-optional. The assessor checked the behaviour directly instead (probe P-3). |

## 3. Acceptance matrix

| ID | Result | Setup / action | Expected | Observed | Direct evidence | Requirements |
| --- | --- | --- | --- | --- | --- | --- |
| CA-01 | PASS | `npm run build`, `npm run lint`, `npx tsc --noEmit --incremental false -p tsconfig.json` (covers `src/events/event.document.spec.ts`) | Exit 0. The type check compiles a pending doc without processing fields and a doc with all five. | build exit 0. lint exit 0, no findings. tsc exit 0. The spec file has a `pending` fixture with no processing fields and a `done` fixture with all five (D-05 types), both checked with `satisfies EventDocument`. Three `@ts-expect-error` negatives (null `lockedUntil`, `lastError` without `at`, string `result`) are consumed: an unused one would fail tsc. | T-1, T-2, T-3 | RF-01, D-03, D-05 |
| CA-02 | PASS | Fresh DB, boot app, `listIndexes` | Exactly 4 indexes with the given keys and key order. Only idempotency is unique. None sparse, partial or TTL. | e2e `CA-02 creates exactly the four indexes…` passed. The test also asserts the `createIndexes` command order (idempotency → claim → read order) and that no collection validator exists. Probe P-1 raw output: `{"key":{"_id":1},"name":"_id_"}`, `{"key":{"idempotencyKey":1},"name":"idempotencyKey_unique","unique":true}`, `{"key":{"status":1,"nextAttemptAt":1},"name":"claim_status_nextAttemptAt"}`, `{"key":{"patientId":1,"ts":1,"receivedAt":1,"_id":1},"name":"patient_read_order"}`. No other options. Key directions (all `1`) confirmed by P-1, which the e2e test checks by key names and order only. | T-5, P-1 | RF-02, D-01, D-06, D-02 |
| CA-03 | PASS | Shuffled direct inserts for `p-a`/`p-b` (distinct ts, ts tie with different receivedAt, ts+receivedAt tie with different `_id`, a late event inserted last, statuses pending/processing/done/failed) plus 2 `POST /events`. `findPatientEvents` for `p-a`, `p-b`, `p-none`. | Exact order with the late event first, no cross-patient mixing, POSTed events in ts position, empty result for `p-none` | e2e `CA-03/CA-11 reads a patient…` passed with an exact `_id` array equality. Expected `p-a` sequence is 7, 1, 3, 2, [post ts25], 8, 9, 4, [post ts45], 5, 6. `p-b` = 21, 22, 23. `p-none` = `[]`. P-4 also checked a 200-doc collection against an independent JS sort of (ts, receivedAt, `_id`): `read order matches JS sort: true`. | T-5, P-4 | RF-03, D-07 |
| CA-04 | PASS | CA-03 data, `findPatientEvents(…,'p-a').explain('queryPlanner')` | IXSCAN `patient_read_order`, no SORT | e2e CA-04 passed (recursive walk of `winningPlan`, no `hint`). P-4 on 200 docs: `{"stage":"FETCH","inputStage":{"stage":"IXSCAN","keyPattern":{"patientId":1,"ts":1,"receivedAt":1,"_id":1},"indexName":"patient_read_order"}}` | T-5, P-4 | RF-03, RNF-04 |
| CA-05 | PASS | Pending and processing docs with past and future `nextAttemptAt`. Explain the claim query. | IXSCAN `claim_status_nextAttemptAt`, no SORT. Only due pending docs, ascending. | e2e CA-05 passed. It returns `[2,1,5]`: due pending docs in ascending `nextAttemptAt`, excluding the future one (3) and the processing one (4). No `hint`. P-4: `{"stage":"FETCH","inputStage":{"stage":"IXSCAN","keyPattern":{"status":1,"nextAttemptAt":1},"indexName":"claim_status_nextAttemptAt"}}` | T-5, P-4 | RF-02, D-01, RNF-04 |
| CA-06 | PASS | Boot, POST 2 events, close, boot again on the same DB | Second init resolves. Identical indexes, same count. | e2e CA-06 passed (deep-equal `listIndexes` before/after, equal `countDocuments`, full set re-checked). P-2 also booted twice on one DB with exit 0. | T-5, P-2 | D-06 |
| CA-07 | PASS | Manually created `idempotencyKey_unique` plus three Phase 1-shaped docs (ten fields only), then boot | Init resolves. Full index set. Docs deep-equal before/after and returned by `findPatientEvents`. Duplicate POST gives `duplicate: true`. | e2e CA-07 passed: snapshot deep-equal, `findPatientEvents('p-known')` → `[2,1]` in ts order, duplicate POST → `{id: oid(1), status:'pending', duplicate:true}`, count stays 3 | T-5 | D-03, D-06, Preserve |
| CA-08 | PASS | Fresh DB, `Promise.all([boot(), boot()])` | Both resolve, full index set | e2e CA-08 passed | T-5 | D-06, RNF-04 |
| CA-09 | PASS | Pre-existing `patient_read_order` `{patientId:1}`, then boot. Repeat for `claim_status_nextAttemptAt` `{status:1}`. | Each init rejects. The pre-existing index is unchanged. | e2e CA-09 (both `it.each` cases) passed. P-3 confirms the rejection is the index conflict, not an unrelated error: `MongoServerError code=86 codeName=IndexKeySpecsConflict … existing index: { key: { patientId: 1 }, name: "patient_read_order" }` (and the same for `{ status: 1 }` on the claim index). After the rejection, the conflicting index still has its original key. Earlier indexes in the sequence had been created (expected under the D-06 ordering). | T-5, P-3 | D-06, RF-02 |
| CA-10 | PASS | Full unit and e2e suites | All Phase 1 tests pass with the 4-name assertion. `GET /health` → 200 `{status:'ok'}`. | `npm test`: 6 files, 98 passed. e2e: 5 files, 53 passed, including Phase 1 CA-01…CA-18 cases (`events.e2e-spec.ts`, `events-store-down`, `startup-failure` CA-15) and `/health (GET)`. The `test/events.e2e-spec.ts` diff is limited to the D-09 name list, and the unique-index key/flag assertions are kept. P-2: `HEALTH 200 {"status":"ok"}`. | T-4, T-5, P-2 | Preserve, D-09 |
| CA-11 | PASS | Capture logger output during CA-03 and CA-06. Compare startup logs with Phase 1. | No `patientId`/`data` values in logs. No new log lines vs Phase 1. | e2e CA-03/CA-11 and CA-06/CA-11 assertions passed (no `p-a`, `p-b`, `p-r1`, `p-r2`, `"hr"`, `999`, or new index names in logs). P-2 compared full captured logs (2 boots plus a POST with `p-probe-secret`/`hr: 4242`) between the HEAD (Phase 1) build and the working-tree build: `diff` gave `LOGS IDENTICAL`, and the secret values occurred 0 times. | T-5, P-2 | RNF-03, D-08 |

## 4. Mandatory-requirement coverage

| Requirement | Covered by | Status |
| --- | --- | --- |
| RF-01 | CA-01. The source shows the five optional fields, exported `EventError`, and a doc comment stating D-03 `$unset`, D-04 semantics and the D-05 message rule. | PASS |
| RF-02 | CA-02, CA-05, CA-09, CA-06–CA-08 | PASS |
| RF-03 | CA-03, CA-04. `PATIENT_READ_ORDER` is exported and used by `findPatientEvents` (not copied). Return type `FindCursor<EventDocument>`. No projection, limit or logging. | PASS |
| RNF-01, RNF-02 | Not applicable (no UI), as the spec states | N/A |
| RNF-03 | CA-11. `grep -nE 'Logger\|console\.'` over the three changed/new `src` files found nothing (exit 1). | PASS |
| RNF-04 | CA-04, CA-05, CA-06, CA-08. Node 24 / Mongo 7.0. No dependencies added. Lint clean. | PASS |
| D-01 | CA-02 (no `lockedUntil` index), CA-05 | PASS |
| D-02 | CA-02 (no validator in `listCollections` options) | PASS |
| D-03 | CA-01, CA-07 | PASS |
| D-04 | A recorded contract, not exercised in this phase (spec §3). It is present in the `EventDocument` doc comment. | PASS (as scoped) |
| D-05 | CA-01, `EventError` type and doc comment | PASS |
| D-06 | CA-02 (order), CA-06–CA-09 | PASS |
| D-07 | CA-03. No route was added (P-2 routes: `/health` GET, `/events` POST only). | PASS |
| D-08 | CA-11, source has no read-concern overrides or logging | PASS |
| D-09 | CA-10, `test/events.e2e-spec.ts` diff | PASS |
| D-10 | `README.md` unchanged | PASS |
| D-11 | `IDEMPOTENCY_INDEX_NAME`, `CLAIM_INDEX_NAME`, `PATIENT_READ_ORDER_INDEX_NAME`, `EVENTS_INDEXES` exported from `database.module.ts` and used by the tests | PASS |

## 5. Technical checks

| ID | Command / procedure | Result | Supports |
| --- | --- | --- | --- |
| T-1 | `npm run build` | exit 0 | CA-01 |
| T-2 | `npm run lint` (`oxlint --type-aware src/ test/`) | exit 0, no findings | CA-01, RNF-04 |
| T-3 | `npx tsc --noEmit --incremental false -p tsconfig.json` | exit 0 | CA-01 |
| T-4 | `npm test` | 6 files, 98 tests passed | CA-01, CA-10 |
| T-5 | `npx vitest run --config ./vitest.config.e2e.ts --reporter=verbose` | exit 0, 5 files, 53 tests passed, including all 9 cases of `test/events-data-model.e2e-spec.ts` | CA-02–CA-11 |
| P-1 | Assessor probe (`scratchpad/probe.mjs <dist> indexes`) against a fresh 7.0.45 replica set, raw `listIndexes` JSON | 4 indexes, exact keys and options (section 3) | CA-02 |
| P-2 | Probe `logs` mode run on the working-tree `dist` and on a `git archive HEAD` build in the scratchpad (with node_modules symlinked), then `diff` of the captured logs | `LOGS IDENTICAL`. POST 202. Health 200. 0 occurrences of payload values. | CA-06, CA-10, CA-11 |
| P-3 | Probe `conflict:<name>` for both indexes | Rejected with `IndexKeySpecsConflict` (code 86). The conflicting index is unchanged afterwards. | CA-09 |
| P-4 | Probe `explain` on 200 seeded docs | Both winning plans are FETCH→IXSCAN on the named index with no SORT. Read order equals an independent JS sort. | CA-03–CA-05 |

The probe script lives only in the assessor scratchpad. No repository files were changed by the probes. The `dist/` directory was regenerated by `npm run build` (a build output; Phase 1 practice).

## 6. Manual and tool-assisted checks

- The spec's optional manual QA (`docker compose up` on an existing `mongo-data` volume, then listing index names) was not performed. It is marked optional in spec §11 and is not tied to any CA. CA-07 covers the existing-data scenario directly. It does not affect the verdict.
- Viewport, theme, browser and accessibility checks: not applicable (no UI).

## 7. Findings

No failing or blocked findings.

Observations (not defects against this spec):

- The e2e CA-02 helper checks index key names and order but not directions. Probe P-1 confirmed every direction is `1`.
- After a CA-09 rejection, the indexes earlier in the D-06 order remain created. This is consistent with D-06 (sequential creation, rejection on failure) and the spec does not require a rollback.

## 8. Regression and side-effect review

- `POST /events` behaviour, responses and initial document shape are unchanged. `events.service.ts` has no diff. All Phase 1 e2e cases pass. The CA-07 duplicate path still deduplicates.
- Startup semantics are unchanged (connect, then indexes, errors propagate). Phase 1 CA-15 (Mongo unreachable) passes.
- Startup and request log output is byte-identical to Phase 1 (P-2).
- No new routes (P-2 route map). No dependency, lockfile, env, Dockerfile, Compose or README changes.
- Data: no documents are modified by index creation (CA-07 deep-equal).

## 9. Verdict rationale

- Criteria: 11 PASS, 0 FAIL, 0 BLOCKED (CA-01 to CA-11).
- Mandatory requirements: all RF, RNF and D items are covered. RNF-01 and RNF-02 are not applicable, as the spec states.
- Rule: every criterion has direct passing evidence and all mandatory requirements are covered → **PASS**.

## 10. Spec status update

- Assessed (pre-update) spec SHA-256: `50c715bad8118e91773ed60d99ed99f8d3ca15d0a784312cc97189ffd883ecc2`
- Metadata-only changes in `.ai/.specs/events-data-model.md` §1: `Status` set to `implemented and verified.`, `Updated` set to `2026-11-02.`, and an `Assessment` line linking this report was added. No requirement text changed.
- Final (post-update) spec SHA-256: `f65e0b044fa2f87d0987a2d6f589bca3ab6ded55ac116ab6559b5717de472073`
