# Assessment report: events-worker

## 1. Identity and overall result

- Overall result: **FAIL**
- Date: 2026-11-02
- Environment: macOS (Darwin 27.0.0), Node v24.21.0, vitest 4.1.12, MongoDB 7.0.45 via `mongodb-memory-server` (one-member replica set). The Docker CLI was used only for `docker compose config`, with no containers started.
- Spec: `.ai/.specs/events-worker.md`, SHA-256 `c6afc6c45f90d24919cc36633d2b87fff7426b700ffa082277e4e5384ebd99f5`
- Plan: `.ai/.plans/events-worker.md`, SHA-256 `276dba99a8a907fe92e99a2d6d6361e8e1c84d1685ecf7de5f1d149a02d6e309`
- Implementation report: `.ai/.implementations/events-worker.md`
- Repository: `clinical-event-ingestion-service`, branch `main`, HEAD `cc34e12`, with uncommitted working-tree changes (12 modified and 14 untracked paths, listed in section 2). Nothing was committed.

## 2. Handoff integrity

- I recomputed both fingerprints with `shasum -a 256`. The spec is `c6afc6c4…bd99f5`, which matches the plan's recorded `Spec SHA-256` and the implementation report's spec fingerprint. The plan is `276dba99…6e309`, which matches the implementation report's plan fingerprint. No artifact is stale.
- All three artifacts are present and well-formed.
- I checked the implementation report's claims against the working tree:
  - Changed-file inventory: `git status --short` matches it exactly. The modified files are README, docker-compose, app.module, env.validation(+spec), five existing e2e suites and test/support/app and mongo. The untracked files are `src/worker/`, `test/support/worker.ts`, nine `test/worker-*.e2e-spec.ts` files and the three `.ai` artifacts.
  - "No changes to EventsService, database, main, health, Dockerfile, package files": `git diff --stat -- src/events src/database src/main.ts src/health Dockerfile package.json package-lock.json` gives empty output. Confirmed.
  - Test counts: 124 unit tests and 75 e2e tests in 14 files. I reproduced both independently (section 5).
  - Failpoint method and counts: reproduced (CA-14(a) produced 5 `update` commands; the short-lease variant produced 4 `update` commands and 2 worker-level writes).
- No mismatches were found between the report and the tree. The report does not mention the D-13 deviation in section 7.

## 3. Acceptance matrix

| ID | Result | Setup / action | Expected | Observed (direct evidence) | Requirements |
| --- | --- | --- | --- | --- | --- |
| CA-01 | PASS | `npm run build`, `npm run lint`, `npm test` | All exit 0 | build exit 0; lint exit 0 with no diagnostics; `npm test` exit 0, 8 files and 124 tests passed. `tsc --noEmit` also exit 0 | RNF-04 |
| CA-02 | PASS | `src/config/env.validation.spec.ts` > `WORKER_ENABLED` | unset, `''` and `'true'` → true; `'false'` → false; `FALSE`, `yes` and `1` throw the D-08 message; the message is combined with other errors | Verbose run: "is true for {}", "…''", "…'true'", "is false for \"false\"", "rejects FALSE/yes/1/' true'", and "lists it together with other problems" all passed | RF-08, D-08 |
| CA-03 | PASS | `worker.e2e-spec.ts` "CA-03/CA-20/D-11": POST via supertest, spy around the real `SimulatedProcessor` (50 ms, rate 0) | `done`, attempts 1, `result {simulated:true}`, `processedAt` Date, no lock fields or `lastError`, payload unchanged, spy got the stored key and the `_id` hex | Passed in both e2e runs (1599 ms). The test also asserts `writeConcern {w:'majority', wtimeout:5000}` on the wire for the `findAndModify` and the `update` | RF-02–RF-04, D-05, D-06, D-11 |
| CA-04 | PASS | "CA-04 holds the claim…": blocking processor | `processing`, attempts 1, `workerId` matching `/^.+:\d+:[0-9a-f]{8}$/`, `lockedUntil` within ±1 s of claim + `LEASE_MS`; then `done` with no lock fields | Passed (123 ms) | RF-02, RF-04, D-09 |
| CA-05 | PASS | "CA-05 only claims due pending events": 6 seeded docs, then a 500 ms (10 × 50 ms) wait | Only the due pending doc is processed; the other 5 are deep-equal to their seeded state | Passed (570 ms). `spy.calls` length 1, and `toEqual(other)` passed for all 5, including the expired `processing` doc | RF-02, D-01 |
| CA-06 | PASS | `worker-concurrency-1` "CA-06": 5 docs inserted in shuffled order 3,0,4,1,2 | Call order ascending by `nextAttemptAt` | Passed; the call order was `[0,1,2,3,4]` | RF-02 |
| CA-07 | PASS | `worker-concurrency-3` "CA-07": blocking processor, 10 docs | max concurrent = 3; 3 docs `processing` while blocked; all 10 `done` | Passed (1162 ms) | RF-02, D-13, P1 |
| CA-08 | PASS | `worker-concurrency-2` "CA-08": 2 docs with the same `patientId` | Both calls in flight together | Passed; `blocking.current === 2`, both with `p-test-1` | RF-02, G2 |
| CA-09 | PASS | "CA-09 two instances…": 2 apps, concurrency 10, 200 docs | All 200 `done` with attempts 1; 200 calls with unique keys; both instances processed events | Passed (1626 ms) | RF-02, P5 |
| CA-10 | PASS | "CA-10/CA-20 retries…": scripted fail, fail, success; base 200, max 10000 | `pending` snapshots with no lock fields, D-12 `lastError`, delay within [cap/2, cap] for 200 and 400; ends `done`, attempts 3, `lastError` kept from attempt 2; no warn | Passed (660 ms) | RF-05, D-04, D-12 |
| CA-11 | PASS | `worker-max-attempts` (MAX_ATTEMPTS=3, the processor always throws) and `worker-timeout` "CA-11 with MAX_ATTEMPTS=1" | `failed`, attempts 3, `processedAt`, `processor_error`/`External call failed`, no `result` or lock fields; exactly one warn `Event <id> failed after 3 attempts (processor_error)`; 3 calls after another 500 ms; MAX_ATTEMPTS=1 → `failed` with attempts 1 | Both passed (855 ms and 104 ms) | RF-05, D-12, D-15 |
| CA-12 | PASS | `worker-timeout` "CA-12": simulator delay 2000, timeout 200, lease 5000, MAX_ATTEMPTS 1 | `failed`, `timeout` / `External call timed out after 200 ms` within about 1 s; signal aborted; simulator rejected; never `done` | Passed (4268 ms). ≤1500 ms from call start to the observed `failed` state; `signal.aborted` true; `settled == ['rejected']`; still `failed` 2.5 s later | RF-03, D-06, D-12 |
| CA-13 | PASS | "CA-13 fenced writes": `$inc attempts` with success, `$inc attempts` with failure, `$set workerId` with success | Doc deep-equal to the post-tamper snapshot; exactly one warn `Stale write discarded for event <id> (attempt 1)` | All 3 cases passed | RF-04, RF-05, D-03 |
| CA-14 | PASS | (a) `failCommand` on `update` with `closeConnection`, `times: 4`; (b) the same `alwaysOn`; (c) `worker-short-lease` with LEASE_MS 1500 | (a) `done`, 1 call, no warn; (b) stays `processing` with lock fields, one warn `Write for event <id> abandoned: Mongo\w*Error`, a second event reaches `done`; (c) no retry after `lockedUntil` | (a) passed, with **5 `update` commands observed**: each worker write is 1 driver try plus 1 driver retry, so the worker made 2 failed writes and then succeeded, which is 2 worker retries. (b) passed (3226 ms, consistent with 3 sleeps of 1 s). (c) passed with **4 `update` commands, 2 worker-level writes, all sent before `lockedUntil`**. Method: failpoint, not the wrapper fallback | RF-06, D-07 |
| CA-15 | PASS | (a) `failCommand` on `findAndModify`, `errorCode 2`, `times 3`; (b) `mongo.stop()` while idle | (a) 3 `Claim failed: …` warns, then `done`; (b) `Claim failed: Mongo…Error` warns, `/health` 200 `{status:'ok'}`, no unhandled rejection | (a) passed with warns exactly `['Claim failed: MongoServerError (code 2)' ×3]`; (b) passed (5178 ms) with an empty `unhandledRejection` spy | RF-02, D-13, RNF-04 |
| CA-16 | PASS | `worker-concurrency-1` (a) concurrency 1, 1 in flight and 3 due, `close()`, release after 300 ms; (b) idle `close()` | (a) `close()` pending before release; then `done` + 3 `pending` with attempts 0; `Worker stopped`; no worker `findAndModify`/`update` after it; (b) resolves ≤ poll + 1 s | Both passed (390 ms and 223 ms) | RF-07, D-02 |
| CA-17 | PASS | `worker-disabled`: WORKER_ENABLED=false, POST, 500 ms wait | Doc `pending` with attempts 0; no `findAndModify` on `events`; `Worker disabled (WORKER_ENABLED=false)` logged | Passed (529 ms). It also asserts that no `Worker stopped` is logged on close | RF-01, RF-08 |
| CA-18 | PASS | `src/worker/backoff.spec.ts` | Delay within [cap/2, cap) for n = 1..8 with random 0 and 0.999999; max reached from n = 7; base 0 → 0; integer result; base = max | All 12 cases passed | D-04 |
| CA-19 | PASS | `src/worker/simulated-processor.spec.ts` (fake timers) | Rate 0 resolves only after the delay; rate 1 rejects only after the delay; random == rate → success; abort rejects at once | All 5 cases passed | D-06 |
| CA-20 | PASS | `expectCleanLogs` in CA-03, CA-10, CA-13 and CA-14(a)/(b), plus checks in `worker-max-attempts` | Every worker line matches a D-10 pattern; no payload, key or serialized result in any line; `lastError.message` is a D-12 string | Passed in each listed test. The `D10_PATTERNS` regexes are anchored. A full key is checked as absent explicitly only in CA-03 and CA-11. In the other tests, a 32-hex key cannot match the anchored worker patterns, and the source has exactly 7 logger calls, all D-10 templates (`grep logger.` in `src/worker`) | RNF-03, D-10, D-12 |
| CA-21 | PASS | `docker compose config`; `grep` the README | The app service lists `WORKER_ENABLED`; the README has the D-16 row | `docker compose config` exit 0, service `app` shows `WORKER_ENABLED: null`. README line 90 is exactly the D-16 row | RF-08, D-16 |
| CA-22 | PASS | Existing suites with `env: { WORKER_ENABLED: 'false' }` | All Phase 1 and 2 tests pass; `/health` 200 | `app`, `events`, `events-data-model`, `events-store-down` and `startup-failure` e2e suites all passed in both runs. The diff of those suites shows only `env: { WORKER_ENABLED: 'false' }` additions and their Prettier wrapping | Preserve |

## 4. Mandatory-requirement coverage

| Requirement | Result | Evidence |
| --- | --- | --- |
| RF-01 | PASS | CA-03 (started line), CA-17 (disabled), CA-15(b) (no crash). `onApplicationBootstrap` is synchronous and `run()` never rejects |
| RF-02 | PASS | CA-03–CA-09, CA-15. Claim filter, update and options match RF-02 exactly (`events-worker.ts:129-147`) |
| RF-03 | PASS | CA-03, CA-12. A synchronous throw maps to `processor_error` (`events-worker.ts:198-200`) |
| RF-04 | PASS | CA-03, CA-04, CA-13 |
| RF-05 | PASS | CA-10, CA-11, CA-13 |
| RF-06 | PASS | CA-14 (a), (b) and the short-lease variant |
| RF-07 | PASS | CA-16 (a), (b); CA-17 (disabled: no `Worker stopped`) |
| RF-08 | PASS | CA-02, CA-17, CA-21 |
| RNF-01 | N/A | No UI (spec states it does not apply) |
| RNF-02 | N/A | No UI (spec states it does not apply) |
| RNF-03 | PASS | CA-20; `$set` fields in `events-worker.ts` cover only status, lock, `nextAttemptAt`, `result`, `lastError` and `processedAt` |
| RNF-04 | PASS | CA-01, CA-07, CA-15; no dependency or lockfile change; `src/worker` imports only `node:crypto`, `node:os`, `mongodb`, `@nestjs/*`; fixed values are named constants |
| D-01 | PASS | CA-05 |
| D-02 | PASS | CA-16 |
| D-03 | PASS | CA-13 |
| D-04 | PASS | CA-10, CA-18 |
| D-05 | PASS | CA-03 (eventId and key passed); `EVENT_PROCESSOR` token, override used in every e2e |
| D-06 | PASS | CA-12, CA-19 |
| D-07 | PASS | CA-14 |
| D-08 | PASS | CA-02, CA-17 |
| D-09 | PASS | CA-04 regex; format `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}` |
| D-10 | PASS | CA-20, CA-11, CA-13, CA-14, CA-15 exact-text assertions |
| D-11 | PASS | CA-03 wire-level write-concern assertions; `returnDocument: 'after'` |
| D-12 | PASS | CA-10, CA-11, CA-12 |
| **D-13** | **FAIL** | See finding F-01. The poll wait after an empty or failed claim is cut short whenever an in-flight attempt settles, not only by stop |
| D-14 | PASS | `WorkerModule` in `src/worker/`, imported by `AppModule`; worker starts in `onApplicationBootstrap`; CA-03 |
| D-15 | PASS | CA-11 (both MAX_ATTEMPTS=3 and =1); `>=` comparison at `events-worker.ts:232,253` |
| D-16 | PASS | CA-21 |

## 5. Technical checks

| Command / procedure | Result | Supports |
| --- | --- | --- |
| `shasum -a 256` of the spec and plan | Matches the handoff values | Handoff |
| `npm run build` | exit 0 | CA-01 |
| `npm run lint` (`oxlint --type-aware src/ test/`) | exit 0, no output | CA-01 |
| `npx tsc --noEmit --incremental false -p tsconfig.json` | exit 0 | CA-01 (supplementary) |
| `npm test` | exit 0; 8 files, 124 tests | CA-01, CA-02, CA-18, CA-19, CA-22 (unit) |
| `npx vitest run --reporter=verbose src/worker src/config` | exit 0; 38 tests, names listed in CA-02/18/19 | CA-02, CA-18, CA-19 |
| `npm run test:e2e -- --reporter=verbose --silent=false` (run 1) | exit 0; 14 files, 75 tests. Console: `failpoint usage: CA-14(a) … observed 5 update commands; CA-14(b) … alwaysOn; CA-15(a) … errorCode=2 times=3` and `short lease: 4 update commands, 2 worker-level writes` | CA-03–CA-17, CA-20, CA-22 |
| `npm run test:e2e -- --silent=false` (run 2) | exit 0; 14 files, 75 tests | Stability of the same criteria |
| `docker compose config` | exit 0; service `app` has `WORKER_ENABLED: null` | CA-21 |
| `grep -n WORKER_ENABLED README.md docker-compose.yml` | One README row (line 90), one compose line (line 54) | CA-21, D-16 |
| `git diff --stat -- src/events src/database src/main.ts src/health Dockerfile package.json package-lock.json` | Empty | Preserve, RNF-04 |
| Scratch probe `…/scratchpad/probe/d13.mjs` (outside the repo): constructs the compiled `dist/worker/events-worker.js` `EventsWorker` with a fake collection (first claim returns one doc, then `null`), a processor that resolves after 100 ms, and `POLL_INTERVAL_MS=1000` | Claim times `[0,1,102,1102]` and `[0,0,102,1102]` ms in two runs | D-13 (F-01) |
| Scratch probe `…/scratchpad/probe/d13-error.mjs`: the same, but claims after the first throw `MongoServerError (code 2)` | Claim times `[4,4,106,1106]` ms | D-13 (F-01) |

Scratch probe directory: `/private/tmp/claude-501/-Users-danilosouza-workspace-clinical-event-ingestion-service/97f1f4fe-611a-4113-94e6-1da4131d73e1/scratchpad/probe/`. The probes did not write to the repository (`git status --short` had 26 entries before and after; `dist/` is gitignored).

## 6. Manual and tool-assisted checks

- The optional manual Docker QA (spec section 11, `docker compose up --build`) was not run. The spec marks it optional, so it is not required for any CA and does not block the verdict.
- No UI, browser, accessibility or external-service checks apply (RNF-01 and RNF-02 do not apply; there is no external integration).

## 7. Findings

### F-01 — Poll wait is cancelled by finishing attempts, not only by stop (D-13) — severity: Low — FAIL D-13

- Spec (D-13): "When a claim returns nothing, or throws (logged per D-10), it waits `POLL_INTERVAL_MS` (cancelled at once by stop) before claiming again. A freed slot wakes the loop if it is waiting because the pool is full."
- Implementation: `src/worker/events-worker.ts` uses a single `wake` callback for all waits (`waitForWake`, lines 92-102). `start()` calls `this.wake?.()` when every attempt settles (line 154). As a result, the timed poll wait at lines 118 and 122 also resolves early when a slot frees, even though the loop is not waiting because the pool is full.
- Reproduction (direct evidence): with `POLL_INTERVAL_MS=1000`, after a claim at about 1 ms returned `null`, the next claim was sent at about 102 ms, when the in-flight attempt finished. D-13 requires about 1001 ms. The same happens after a thrown claim error: the claim that failed at 4 ms was followed by another at 106 ms. Commands and output are in section 5.
- Impact: extra claim queries beyond one per `POLL_INTERVAL_MS`, one per settling attempt. During a store outage (claim errors), claims are retried sooner than the configured interval while attempts are settling. No CA detects this, and data correctness is unaffected (claims are atomic and writes fenced).
- Required remediation (via `/implement-spec`): only `stop` should cancel the `POLL_INTERVAL_MS` wait after an empty or failed claim. A freed slot should wake only the pool-full wait. A regression test that would have caught this is advisable but optional; the spec does not require one.

No other findings.

## 8. Regression and side-effect review

- `POST /events` contract, indexes, startup semantics and `/health`: preserved. All Phase 1 and Phase 2 e2e suites pass unchanged except for the added `WORKER_ENABLED: 'false'` env (CA-22).
- `EventsService`, `EventDocument`, `src/database`, `src/main.ts`, Dockerfile, `package.json` and `package-lock.json`: unchanged (empty diff).
- Config: the existing variables, defaults and cross-field rules are unchanged; the only addition is `WORKER_ENABLED`. The global "blank means default" filter is reused.
- Test support: `createTestApp` gained an optional `env` with a same-env-per-file guard. `startMongo` gained an optional `enableTestCommands`. Both changes are backward compatible.
- Logs and data: only the D-10 templates exist in `src/worker` (7 logger calls, no `console`). `lastError.message` is chosen from fixed text only (`errorMessage`). The worker never writes payload fields or `idempotencyKey`.
- Security: no new network surface or dependencies.

## 9. Verdict rationale

- Acceptance criteria: 22 PASS, 0 FAIL, 0 BLOCKED.
- Mandatory requirements: RF 8/8 PASS; RNF 2 PASS and 2 not applicable; D 15 PASS and 1 FAIL (D-13).
- Totals across all evaluated items (CA + RF + RNF + D, excluding the 2 not-applicable RNF items): 47 PASS, 1 FAIL, 0 BLOCKED.
- Rule: PASS needs every criterion passing and every mandatory requirement satisfied. D-13 has direct failing evidence (a reproduced behaviour), so the overall result is **FAIL**.

## 10. Spec status update

Not performed. The spec status and requirements are unchanged (fingerprint is still `c6afc6c45f90d24919cc36633d2b87fff7426b700ffa082277e4e5384ebd99f5`).
