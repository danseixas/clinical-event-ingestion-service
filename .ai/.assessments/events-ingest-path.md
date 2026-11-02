# Assessment report: events-ingest-path

## 1. Identity and overall result

- Overall result: **PASS**
- Date: 2026-11-02
- Assessor: spec-assessor (independent; `/assess-spec`)
- Environment: macOS (darwin, arm64), Node v24.21.0, `mongodb` driver 7.8.0, `mongodb-memory-server` 11.3.0 running MongoDB 7.0.45 as a one-member replica set; Docker 29.7.2 with `mongo:7.0` for the container check.
- Spec: `.ai/.specs/events-ingest-path.md`
- Plan: `.ai/.plans/events-ingest-path.md`
- Implementation report: `.ai/.implementations/events-ingest-path.md`
- Assessed fingerprints (before the status update):
  - Spec SHA-256 `6d9c795c2056fff37d961aac3943b9fb186c3a4922230a536d495932524af3a2`
  - Plan SHA-256 `15c14aaefc401237b4a1bb9318bd460a72e9404982db634eb399bae603fd2971`
- Repository: `clinical-event-ingestion-service` only. Branch `main`, HEAD `e2aebeb`, nothing committed. The change set is all in the working tree: modified `README.md`, `package.json`, `package-lock.json`, `src/app.module.ts`, `src/main.ts`, `test/app.e2e-spec.ts`; untracked `src/app.setup.ts`, `src/database/`, `src/events/`, `test/events.e2e-spec.ts`, `test/events-store-down.e2e-spec.ts`, `test/startup-failure.e2e-spec.ts`, `test/support/`, `.ai/`, `.claude/`.

## 2. Handoff integrity

| Check | Result | Evidence |
| --- | --- | --- |
| Spec fingerprint in plan matches the current spec | PASS | `shasum -a 256` gave `6d9c795c…f3a2`; plan line 8 records the same value |
| Spec and plan fingerprints in the implementation report match | PASS | Implementation report lines 7–8 match both recomputed values |
| Artifacts complete | PASS | All three files exist and are well-formed |
| Changed-file inventory (report §7) vs. working tree | PASS | `git status --porcelain` and `git diff --stat` list exactly the files in the inventory. `src/config/`, `src/health/`, `Dockerfile` and `docker-compose.yml` are unchanged (`git diff --quiet HEAD -- …` exit 0) |
| Reported test counts | Confirmed by re-running | Unit 5 files / 97 tests; e2e 4 files / 44 tests (§5) |
| Reported "no deviations" | No contradicting evidence found | Source matches the spec contracts (§3, §8) |
| Applicable instructions | Checked | `AGENTS.md` (Observe telemetry, out of scope; nothing added). There is no `CLAUDE.md` |

## 3. Acceptance matrix

Legend: "E2E" is `npm run test:e2e` (verbose) run by the assessor. "Probe" is the assessor's own black-box script `probe.mjs`, which started `dist/main.js` as a real process against a fresh in-memory replica set and used `fetch`. "Docker" is the isolated container run (§6).

| ID | Result | Setup / action | Expected | Observed | Direct evidence | Requirements |
| --- | --- | --- | --- | --- | --- | --- |
| CA-01 | PASS | Empty collection; POST a valid event | 202, keys exactly `id` (24 hex) / `status: 'pending'` / `duplicate: false`; 1 doc with `_id` = id | E2E asserts all of these. Probe: `202 application/json; charset=utf-8 location=null {"id":"6ae8d27f2354d15499198268","status":"pending","duplicate":false}` | E2E `CA-01/CA-02/CA-13 …` ✓; probe log | RF-01, RF-04, D-15 |
| CA-02 | PASS | Read the stored doc | Exact field set, 64-hex key, `ts` Date = normalized, `receivedAt` Date, pending, attempts 0, `nextAttemptAt` = `receivedAt`, values deep-equal | E2E asserts the exact sorted key list and each value. Probe: `keys=_id,attempts,data,idempotencyKey,nextAttemptAt,patientId,receivedAt,status,ts,type ts=2026-11-02T13:00:00.000Z tsIsDate=true status=pending attempts=0 nextEqRecv=true keyHex64=true` | E2E ✓; probe log | D-02, RF-04 |
| CA-03 | PASS | Repost the identical body | 202 same id, `duplicate: true`, still 1 doc, unchanged | E2E compares the whole collection before and after. Probe: second POST `{"id":"6ae8d27f…8268","status":"pending","duplicate":true}` | E2E `CA-03` ✓; probe | RF-04, D-12 |
| CA-04 | PASS | Reordered nested `data` keys; another offset; fraction truncating to the same ms | Duplicate, same id, 1 doc | E2E: `…13:00:00Z` vs `…10:00:00.0009-03:00` with keys reordered at depth ≥ 2 → duplicate, count 1. Probe: `13:00:00.0001Z` with reordered keys → duplicate with the same id | E2E `CA-04` ✓; probe | RF-03, D-03, D-10 |
| CA-05 | PASS | Pairs differing by array order, `1` vs `"1"`, ts +1 ms, `'p1'` vs `' p1'` | 2 docs per pair with different keys, both `duplicate: false` | All 4 `it.each` cases pass and assert 2 docs with different `idempotencyKey` | E2E `CA-05 …` ×4 ✓ | RF-03, D-06 |
| CA-06 | PASS | Unit test of the canonical hash | Same key for depth ≥ 2 reorder and equivalent ts; differs for any value change; `/^[0-9a-f]{64}$/` | `idempotency-key.spec.ts`: 13/13 pass. Assessor cross-check: SHA-256 of a hand-written canonical string `{"data":{"hr":72,"zz":{"a":[3,"q"],"b":1}},"patientId":"p-probe-77","ts":"2026-11-02T13:00:00.000Z","type":"vitals-probe"}` equals `computeIdempotencyKey(...)` for the unsorted input (`true 13cfa4be…2f43`) | vitest verbose output; node cross-check | RF-03, D-03 |
| CA-07 | PASS | 20 concurrent identical POSTs | All 202, same id, 1 new + 19 dup, 1 doc | E2E asserts each item. Probe: `statuses=202 ids=1 new=1 dup=19 docs=1` | E2E `CA-07` ✓; probe | RF-04, RNF-04 |
| CA-08 | PASS | Each RF-02 violation (23 cases, including every listed ts variant and non-strings) | 400, `error: 'Bad Request'`, exact message, collection empty | All 23 `it.each` cases pass with an exact-string `toContain` and `countDocuments() === 0`. Probe with several violations at once: `["property source should not exist","patientId must not be blank","type must be at most 64 characters","ts must be an ISO 8601 date-time with a timezone offset","data must be a JSON object"]`, one message per field, first rule only | E2E `CA-08 rejects …` ×23 ✓; probe | RF-02, D-06, D-10, D-13 |
| CA-09 | PASS | 128-char patientId, 64-char type, `{}`, non-ASCII patientId, 9-digit fraction with `+05:30` | 202 `duplicate:false`; stored ts truncated | All pass. `10:00:00.123456789+05:30` stored as `2026-11-02T04:30:00.123Z` | E2E `CA-09 …` ×5 ✓ | RF-02, D-06, D-10 |
| CA-10 | PASS | Extra `source`; `[]`; malformed `{"a":` and `{"patientId":p-secret-123}` | 400s; exact malformed body; no `secret` in the response; collection empty | E2E asserts all of it. Probe: `400 {"message":"Malformed JSON body","error":"Bad Request","statusCode":400}` | E2E `CA-10` ✓; probe | RF-02, D-05, D-16, RNF-03 |
| CA-11 | PASS | Valid-shaped body of about 150 kb | 413; collection empty | E2E 413 and count 0. Probe: `oversized: 413` | E2E `CA-11` ✓; probe | RF-01, RNF-04 |
| CA-12 | PASS | App initialized, replica set stopped, POST | Exact 503 body within 15 s; no 202 | E2E: 503 with the exact body, 5794 ms. Probe on the real process: `503 elapsedMs=5005 {"message":"Event store unavailable, retry later","error":"Service Unavailable","statusCode":503}` | E2E `CA-12/CA-17` ✓; probe | RF-06, D-04, D-11 |
| CA-13 | PASS | Command monitoring during CA-01; `listIndexes` | `insert.writeConcern.w === 'majority'`; `idempotencyKey_unique` unique on `{idempotencyKey:1}`; no other non-`_id` index | E2E asserts the captured `insert` command and that the index names are exactly `['_id_','idempotencyKey_unique']`. Probe: `[{"name":"_id_",…},{"name":"idempotencyKey_unique","key":{"idempotencyKey":1},"unique":true}]` | E2E ✓; probe | RF-04, RF-05, D-02 |
| CA-14 | PASS | `data: {"$set":1,"a.b":2}` | 202 `duplicate:false`; stored deep-equal | E2E passes. Probe: `202 … stored={"$set":1,"a.b":2}`. This confirms the §5 assumption | E2E `CA-14` ✓; probe | RF-04, §5 assumption |
| CA-15 | PASS | `MONGO_URI=mongodb://127.0.0.1:1/x?directConnection=true` | `init()` rejects within 15 s; no HTTP server | E2E: rejects in 5200 ms. Probe, real process `node dist/main.js`: `exit=1 elapsedMs=5484 servedHttp=false` (`/health` polled every 200 ms until exit) | E2E `CA-15` ✓; probe | RF-05, D-07 |
| CA-16 | PASS | Full e2e suite and unit tests | `/health` 200 `{status:'ok'}`; existing unit tests pass | E2E `/health (GET)` ✓; `npm test` 5 files / 97 tests including `env.validation.spec.ts`, exit 0. Docker: `/health` → `{"status":"ok"}` | command output | Preserve |
| CA-17 | PASS | Capture logs during CA-01, CA-08 and CA-12 | No payload values or key in logs; exactly 1 `warn` with the error class on 503 | E2E asserts no values or key on accept, and no values on reject. It also asserts exactly 1 warn matching `/Mongo\w*Error/` and no values on 503. Probe (real stdout, the whole process lifetime including accept, duplicate, concurrent, invalid, malformed and 503): the only new line on 503 is `WARN [EventsService] Event store unavailable: MongoServerSelectionError`. A search for `p-probe-77`, `vitals-probe`, `7319`, `p-secret`, `p-down-55`, `p-conc`, `2026-11-02` and the stored key found nothing: `[]` | E2E ✓; probe log | RNF-03, D-14 |
| CA-18 | PASS | `npm run lint`, `npm run build` | Both exit 0 | lint exit 0 (`oxlint --type-aware src/ test/`, no diagnostics); build exit 0; no `*spec*` files in `dist/` | command output | RNF-04 |

## 4. Mandatory-requirement coverage

| Requirement | Covered by | Result |
| --- | --- | --- |
| RF-01 | CA-01, CA-11; 202 with `application/json` (probe) | PASS |
| RF-02 | CA-08, CA-09, CA-10; e2e non-JSON content types and primitives (four first-rule messages); `constructor` key rejection | PASS |
| RF-03 | CA-04, CA-05, CA-06; assessor's independent hash cross-check | PASS |
| RF-04 | CA-01, CA-02, CA-03, CA-07, CA-13, CA-14 | PASS |
| RF-05 | CA-13, CA-15. `close-probe.mjs` on the built app showed `serverSelectionTimeoutMS 5000`, `db closeprobe` (the database from the URI), and `topologyClosed` emitted after `app.close()`, after which a ping failed with `MongoNotConnectedError` | PASS |
| RF-06 | CA-12; unit tests for D-11 classes and D-17 | PASS |
| RNF-01, RNF-02 | Not applicable (no UI), as the spec states | N/A |
| RNF-03 | CA-10, CA-17 | PASS |
| RNF-04 | CA-07, CA-11, CA-18; `npx prettier --check src test` passes; every relative import uses `.js`; `npm ci` succeeds in the Docker build (lockfile consistent) | PASS |
| D-01 | `package.json` adds only `mongodb@^7.8.0` (runtime). No Mongoose or TypeORM | PASS |
| D-02 | CA-02, CA-13 | PASS |
| D-03 | CA-04, CA-06, hash cross-check | PASS |
| D-04 | `serverSelectionTimeoutMS 5000` observed at runtime; insert options `{ w:'majority', wtimeoutMS:5000 }` asserted by the unit test; `w:'majority'` on the wire (CA-13); 503 at about 5 s (CA-12); no new env vars (`src/config` unchanged) | PASS |
| D-05 | CA-10 (`property source should not exist`) | PASS |
| D-06 | CA-05 (`' p1'` distinct), CA-08 blank, CA-09 boundaries | PASS |
| D-07 | CA-15 (e2e and real process exit 1) | PASS |
| D-08 | README "Known limit: there is no authentication…" | PASS |
| D-09 | `test/support/mongo.ts` runs `MongoMemoryReplSet` with `count: 1` and version 7.0.45 from `package.json`; each test file uses a different database name | PASS |
| D-10 | CA-08 ts variants, CA-09 truncation | PASS |
| D-11 | CA-12 (server selection → 503). Unit `maps %s on insert to 503`: MongoServerSelectionError, MongoNetworkError, MongoNotConnectedError, MongoWriteConcernError and the RetryableWriteError label all give the exact 503 body with 1 safe warn. Generic errors are rethrown (→ 500). Driver 7.8.0 `write_concern.js:96` confirms that write-concern failures throw `MongoWriteConcernError` | PASS |
| D-12 | Unit tests: majority/primary read options asserted; retries until visible (3 calls); exhaustion after 6 reads → 503. CA-03 and CA-07 cover the live path | PASS (multi-node visibility lag is not reproducible, as the spec accepts) |
| D-13 | CA-08 and the probe body shape `{statusCode:400, message:[…], error:'Bad Request'}` | PASS |
| D-14 | CA-17 | PASS |
| D-15 | CA-01 (exact keys), probe `location=null` | PASS |
| D-16 | CA-10 | PASS |
| D-17 | Unit `answers 503 with DuplicateNotVisible…`: one warn, exactly `Event store unavailable: DuplicateNotVisible` | PASS |
| Preserve items | `/health` (CA-16, Docker); env validation unchanged; Dockerfile and Compose unchanged, and the image builds and runs (§6); existing unit tests pass | PASS |

## 5. Technical checks

All run by the assessor from `/Users/danilosouza/workspace/clinical-event-ingestion-service` on 2026-11-02.

| Command / procedure | Exit / result | Output summary | Supports |
| --- | --- | --- | --- |
| `shasum -a 256` on the spec and plan | — | Values in §1 | Handoff |
| `npm test` | 0 | 5 files, 97 tests passed | CA-06, CA-16, D-11, D-12, D-17 |
| `npm run test:e2e -- --reporter=verbose` | 0 | 4 files, 44 tests passed; individual names listed in §3 | CA-01–05, CA-07–17 |
| `npm run lint` | 0 | No diagnostics | CA-18 |
| `npm run build` | 0 | `dist/` has no spec files | CA-18 |
| `npx prettier --check src test` | 0 | "All matched files use Prettier code style!" | RNF-04 |
| `grep -rnE "from '\.\.?/" src test \| grep -v "\.js';"` | no output | All relative imports use `.js` | RNF-04 |
| `npx vitest run src/events/idempotency-key.spec.ts --reporter=verbose` | 0 | 13/13 | CA-06 |
| Node hash cross-check (hand-written canonical JSON vs `dist/events/idempotency-key.js`) | `true` | `13cfa4becd2346ecaa42a4b72de038cdd44f418c7d8a124a3fd326aa4db22f43` | RF-03, D-03 |
| `probe.mjs` (scratchpad): black-box run of `dist/main.js` | completed | Outputs quoted in §3 | CA-01–04, 07, 08, 10–15, 17 |
| `close-probe.mjs` (scratchpad): built AppModule init/close | completed | `serverSelectionTimeoutMS 5000`, `db closeprobe`, `topologyClosed … true`, ping after close → `MongoNotConnectedError` | RF-05, D-04 |
| Inspected `node_modules/mongodb/lib/write_concern.js` | — | `throwIfWriteConcernError` throws `MongoWriteConcernError` | D-11 |

## 6. Manual and tool-assisted checks

- The spec's optional manual QA (§11) was run in an isolated Docker setup so the user's running `clinical-event-ingestion-service` Compose stack was not touched. The setup was a temporary network `assess-net-eip`, a `mongo:7.0` container with `--replSet rs0` (initiated as `mongo:27017`), and an image built from the working-tree Dockerfile (`docker build`, exit 0) running on host port 3911 with `MONGO_URI=mongodb://mongo:27017/ingest?replicaSet=rs0`.
  - `GET /health` → `{"status":"ok"}`.
  - The spec's curl body, sent twice → `HTTP/1.1 202 Accepted {"id":"6ae8d2cf864a4b0d521618a6","status":"pending","duplicate":false}`, then `HTTP/1.1 202 Accepted {"id":"6ae8d2cf864a4b0d521618a6","status":"pending","duplicate":true}`.
  - The production image has `mongodb` and no `mongodb-memory-server`, so dev dependencies are pruned and `disablePostinstall` caused no build problem.
  - The temporary containers, network and image were removed afterwards.
- Viewport, theme, browser and accessibility checks: not applicable (backend API, no UI).

## 7. Findings

No failing or blocked findings.

Observations (not failures, no remediation required by the spec):

- Low: in RF-04 and D-12, multi-node majority-visibility lag and failover can't be reproduced on a one-member replica set. Unit tests with a stubbed collection cover the D-12 retry and exhaustion paths. The spec accepts this limit explicitly (§3, §11).
- Info: on SIGTERM the process exits from the signal without running Nest shutdown hooks (`main.ts` has no `enableShutdownHooks`). RF-05 only requires the client to close on `app.close()`, and the probe confirmed that. Graceful shutdown belongs to a later phase (`SHUTDOWN_TIMEOUT_MS` in Compose).

## 8. Regression and side-effect review

- `GET /health` behavior is unchanged (e2e and Docker).
- `src/config/env.validation.ts`, `src/health/*`, `Dockerfile` and `docker-compose.yml` are unchanged. No new env vars.
- `main.ts` now disables Nest's default body parsers and registers only JSON (`strict: false`, default 100 kb limit). The intended effect, that urlencoded or text bodies fail validation with the four first-rule messages, is covered by e2e. `/health` (GET) is unaffected.
- No telemetry was added (`AGENTS.md` scope respected).
- Logs: no payload values or idempotency keys appeared in the process log across all probe scenarios.
- Dependencies: `mongodb@^7.8.0` (runtime) and `mongodb-memory-server@^11.3.0` (dev), plus `config.mongodbMemoryServer`. The lockfile is consistent (`npm ci` passes in Docker).
- Assessor side effects: scratch files only in the session scratchpad; temporary in-memory Mongo instances, and Docker resources that were removed. `dist/` was rebuilt by `npm run build` (git-ignored). No product code, tests, fixtures, dependencies or configuration were modified.

## 9. Verdict rationale

- CA results: 18 PASS, 0 FAIL, 0 BLOCKED.
- Mandatory RF, RNF and D items: all covered with passing evidence. RNF-01 and RNF-02 are not applicable, as the spec states.
- Rule: every criterion has passing evidence and every mandatory requirement is covered → overall **PASS**.

## 10. Spec status update

- Assessed (pre-update) spec SHA-256: `6d9c795c2056fff37d961aac3943b9fb186c3a4922230a536d495932524af3a2`
- Metadata-only changes to `.ai/.specs/events-ingest-path.md` §1: `Status` set to `implemented and verified`, `Updated` set to `2026-11-02`, and an `Assessment` line added that links this report. No requirement text was changed.
- Final (post-update) spec SHA-256: `f50c9d0147e367cd457e6d6fa404fc3b70e62ec95b5aefe36d242c87ca899709`
