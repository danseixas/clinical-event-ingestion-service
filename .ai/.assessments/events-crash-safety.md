# Assessment report: events-crash-safety

## 1. Identity and overall result

- Overall result: **PASS**
- Date: 2026-11-02
- Environment: macOS (Darwin 27.0.0), Node v24.21.0, vitest 4.1.12, MongoDB 7.0.45 via `mongodb-memory-server` (one-member replica set, with `enableTestCommands=1` where failpoints are used). Docker was not used; the manual Docker QA in spec section 11 is optional.
- Spec: `.ai/.specs/events-crash-safety.md`, assessed (pre-status-update) SHA-256 `32e69a9554e4554cbd45606d367532944c653b598814475bc906694a82e2e353`
- Plan: `.ai/.plans/events-crash-safety.md`, SHA-256 `d3cfe942dfd93d57dc35ac8d25724aa7da4f839da6fc7613e35ff757282cd841`
- Implementation report: `.ai/.implementations/events-crash-safety.md`
- Repository: `clinical-event-ingestion-service`, branch `main`, HEAD `79348bc`, with uncommitted changes: 6 modified tracked files and 10 untracked paths (7 new e2e suites plus the 3 `.ai` artifacts). Nothing was committed by this assessment.

## 2. Handoff integrity

- I recomputed both fingerprints with `shasum -a 256`. The spec hash is `32e69a95…2e353`, which matches the plan's `Spec SHA-256` (plan line 8) and the implementation report's spec fingerprint (line 7). The plan hash is `d3cfe942…cd841`, which matches the implementation report's plan fingerprint (line 8). No artifact is stale.
- All three artifacts are present and well-formed.
- I checked the implementation report's claims against the working tree:
  - Changed-file inventory: `git status --short` matches report section 7 exactly. `git diff --stat -- package.json package-lock.json src/database src/events src/config docker-compose.yml Dockerfile README.md` gives empty output.
  - Test counts: 124 unit tests in 8 files and 91 e2e tests in 21 files. I reproduced both independently (section 5).
  - Observations: I reproduced each reported value in my own run: the CA-11 winning plan, child exit `{"code":null,"signal":"SIGTERM"}`, close in 304 ms, 1002 ms and 1000 ms poll spacing, and a 7/13 ms pool wake.
  - Deviations 1 to 5 were checked against the code (section 8). None of them changes a spec expectation.
- No mismatches were found.

## 3. Acceptance matrix

| ID | Result | Setup / action | Expected | Observed (direct evidence) | Requirements |
| --- | --- | --- | --- | --- | --- |
| CA-01 | PASS | `npm run build`, `npm run lint`, `npm test`, `npm run test:e2e` | All exit 0; Phase 1–3 suites pass with only the Phase 3 CA-05 expired-lease assertion changed | build exit 0; lint exit 0 with no diagnostics; `npm test` exit 0 (8 files, 124 tests); `npm run test:e2e` exit 0 (21 files, 91 tests). `tsc --noEmit` exit 0; `prettier --check` clean. Diff of existing suites: only the `worker.e2e-spec.ts` CA-05 assertion changed. `worker-disabled` adds one assertion and `worker-short-lease` changes one setting, with no assertion changes (section 8) | RNF-04, Preserve |
| CA-02 | PASS | `worker-reclaim.e2e-spec.ts` "CA-02": seed expired `processing` (attempts 1, `dead:1:aaaaaaaa`, −1 s) and a held `processing` (+1 h), with `MAX_ATTEMPTS=5` and a success spy | `done`, attempts 2, result set, no lock fields; key passed once; one reclaim warn (attempt 2); held doc unchanged after 10 × poll | Passed (1534 ms). The test asserts each item, including `toEqual([{level:'warn', message:'Reclaimed event <id> after lease expiry (attempt 2)'}])` and a deep-equal check that the held document is unchanged | RF-01, RF-02, D-01, D-02, D-04 |
| CA-03 | PASS | `worker-reclaim-limit.e2e-spec.ts` (a)–(d), `MAX_ATTEMPTS=3` | (a) no processor call, `failed` attempts 4 with the exact `lease_expired` lastError and no result or lock fields, warns in order; (b) one call, `processor_error`, attempts 3; (c) pending attempts 5 goes to `done` attempts 6; (d) abandoned warn, then a later reclaim to `failed` `lease_expired` attempts 5, with 0 calls | All four passed (650, 40, 27 and 1079 ms). In (a) the warn list equals `[Reclaimed … (attempt 4), Event … failed after 4 attempts (lease_expired)]`. (d) used failpoint `failCommand update closeConnection times:2` (printed). The abandon comes from the worker D-07 lease bound (1 s retry wait ≥ the 1 s lease), and D-07 says that bound limits the retries | RF-03, D-03 |
| CA-04 | PASS | `worker-reclaim-stale.e2e-spec.ts`: A blocks, the test sets `lockedUntil` to −1 s, B (success spy) reclaims, then A is released | `done` attempts 2; doc deep-equal after A's release; B logs the reclaim warn (attempt 2); A logs `Stale write discarded … (attempt 1)`; B's spy called once | Passed (885 ms) with every listed assertion | RF-01, worker D-03, P5 |
| CA-05 | PASS | `worker-reclaim.e2e-spec.ts` "CA-05": 2 instances, concurrency 10, 100 expired seeds, success spies | 100 `done` with attempts 2; each key seen exactly once across spies; exactly 100 reclaim lines | Passed (888 ms). Spy keys: length 100, unique set size 100. Exactly 100 `Reclaimed event` lines | RF-01, D-01 |
| CA-06 | PASS | `process-signals.e2e-spec.ts` "CA-06": `node dist/main.js` child with the spec env, POST 3, wait for 3 `processing` (+300 ms), SIGTERM | `Worker stopping: 3 attempts in flight` then `Worker stopped`; no timeout line; exit by SIGTERM within 10 s; 3 `done`, attempts 1 | Passed (2014 ms). Printed `SIGTERM exit: {"code":null,"signal":"SIGTERM"} after 1222 ms`. Captured stdout shows `[EventsWorker] Worker stopping: 3 attempts in flight` then `[EventsWorker] Worker stopped`, with no timeout line | RF-04, RF-05, D-06, P6 |
| CA-07 | PASS | "CA-07": as CA-06, then POST a 4th event after `Worker stopping` appears | 202, `duplicate:false`; the 4th is `pending` with attempts 0 after exit | Passed (1899 ms). Exit `{"code":null,"signal":"SIGTERM"}`; the 4th document is `pending` with attempts 0 | D-10, RF-05 |
| CA-08 | PASS | `worker-shutdown-timeout.e2e-spec.ts` "CA-08/CA-09": `SHUTDOWN_TIMEOUT_MS=300`, `PROCESSING_TIMEOUT_MS=4000`, `LEASE_MS=5000`, blocking processor, 2 in flight, `app.close()` | close ≤ 1300 ms; logs `Worker stopping: 2…`, `Shutdown timeout after 300 ms: 2 attempts left for lease reclaim`, `Worker stopped` in order; both signals aborted; documents unchanged; a new instance after the lease reclaims both to `done` attempts 2 | Passed (6622 ms). Printed `close took 304 ms`. Exact ordered list of worker lines asserted; `signal.aborted` true for both calls; documents deep-equal to the pre-close snapshot; reclaim to `done` with attempts 2 | RF-05, D-05 |
| CA-09 | PASS | Same test (command sink sliced at the `Worker stopped` marker, checked after 4500 ms) and "CA-09 sends no write retry after the deadline" (failpoint `update` alwaysOn closeConnection). Plus my independent probe PROBE-B (section 6) | No `findAndModify` or `update` on `events` after `Worker stopped`; in the retry variant, no retry after the deadline | Both repository tests passed (1883 ms for the retry variant). The repository retry test does not assert that the deadline hit during the retry wait, so PROBE-B made sure the worker was in its 1 s retry wait before `close()`. It observed `Shutdown timeout after 300 ms: 1 attempts left for lease reclaim`, close in 305 ms, 2 `update` commands before close and 2 in total (none after) over 2.5 s | D-11, RF-05 |
| CA-10 | PASS | "CA-10": child A (delay 3000, timeout 4000, lease 5000), POST 1, wait for `processing`, SIGKILL; start child B | A has no `Worker stopped`; doc stays `processing` with A's workerId until the lease; B logs reclaim (attempt 2); doc `done` attempts 2; one doc per key | Passed (8434 ms) with each assertion (the pre-lease check ran under `Date.now() < lockedUntil`) | RF-01, RF-02, RF-04, P4, P6 |
| CA-11 | PASS | "CA-11": `explain` with `executionStats` of the claim `findAndModify` over seeded pending and processing documents | Both `$or` branches use `claim_status_nextAttemptAt`; no blocking `SORT` | Passed. Printed winning plan: `UPDATE > SUBPLAN > LIMIT > FETCH > SORT_MERGE(sortPattern nextAttemptAt:1)` over `IXSCAN claim_status_nextAttemptAt` (pending bounds) and `FETCH(lockedUntil $lt) > IXSCAN claim_status_nextAttemptAt` (processing, nextAttemptAt [MinKey,MaxKey]). No `SORT` stage | D-01, RNF-04 |
| CA-12 | PASS | `worker-poll-spacing.e2e-spec.ts` (`POLL_INTERVAL_MS=1000`, blocking processor released after an empty claim; failed-claim variant with failpoint `findAndModify errorCode 2 times 1`) and `worker-pool-wake.e2e-spec.ts` (concurrency 1, 3 due, 100 ms simulator) | Next claim ≥ 900 ms after the empty claim and after the failed claim; pool-full wake ≤ 200 ms after settle | Passed in both runs. Printed: `empty claim to next claim 1002 ms; settle to next claim 992 ms`; `failed claim to next claim 1000 ms`; `pool wake: claim 7 ms after settle (call 1)`, `13 ms (call 2)` | RF-06, D-07, worker D-13 |
| CA-13 | PASS | `CaptureLogger` checks in CA-02–CA-05, CA-08, CA-09 and child output checks in CA-06, CA-07 and CA-10; `worker-disabled` close; plus my independent probe PROBE-A (child, SIGINT, distinctive `type`/`data`/`ts`/`patientId`) | Every worker line matches a D-10/D-08 pattern exactly; no posted values or keys in any line; lastError messages in D-12 + `lease_expired`; disabled close logs no `Worker stopping`/`Worker stopped` | Repository tests passed. The `D10_PATTERNS` entries for the three D-08 lines are anchored exact patterns. `D12_MESSAGES` includes `Lease expired before the attempt completed` (asserted in CA-03(a)). The disabled test asserts no `Worker stopping`/`Worker stopped`. The repository tests check only `patientId`/`ts`/`idempotencyKey`, so PROBE-A also checked the complete child stdout+stderr for the posted `type` (`zzProbeType`), the `data` key and values (`probeField`, `zzProbeDataValue`), `ts` (`11:22:33`), `patientId` and both stored keys. None were found | RNF-03, D-08 |
| CA-14 | PASS | `worker.e2e-spec.ts` "CA-05 claims due pending and expired processing events" | The expired seed ends `done` with attempts 2; the other four seeds are deep-equal | Passed (558 ms). Diff shows only the expired seed moved from `others` to its own expectation (`done`, `attempts` 2), with spy calls 1→2. The four remaining seeds are still asserted with `toEqual` | D-01 |

## 4. Mandatory-requirement coverage

| Requirement | Covered by | Result |
| --- | --- | --- |
| RF-01 claim with expired-lease branch | CA-02, CA-04, CA-05, CA-10, CA-11, CA-14; code `claim()` uses the D-01 `$or`, same update/sort/write concern, `returnDocument: 'before'` | PASS |
| RF-02 reclaim detection/logging | CA-02, CA-03(a), CA-04, CA-05, CA-10 | PASS |
| RF-03 attempt-limit guard | CA-03 (a)–(d) | PASS |
| RF-04 SIGTERM and SIGINT | CA-06, CA-07, CA-10 (SIGTERM); PROBE-A (SIGINT: exit `{"code":null,"signal":"SIGINT"}`, drain logs, both docs `done`/1) | PASS |
| RF-05 bounded stop | CA-06, CA-07, CA-08, CA-09; idempotent hook via `stopPromise ??=` (code); disabled path in CA-13 | PASS |
| RF-06 dispatcher wakes | CA-12 | PASS |
| RNF-01 visual design | Not applicable (backend only, per spec) | N/A |
| RNF-02 accessibility | Not applicable (no UI, per spec) | N/A |
| RNF-03 privacy and security | CA-13, PROBE-A | PASS |
| RNF-04 quality, performance, compatibility | CA-01 (build, lint, tsc, prettier), CA-11, CA-12, CA-05, CA-04, CA-08, CA-09; no dependency changes | PASS |
| D-01 | CA-11, CA-14, CA-02, CA-05 | PASS |
| D-02 | CA-02, CA-05, CA-10 (attempts 2) | PASS |
| D-03 | CA-03 | PASS |
| D-04 | CA-02, CA-03 (derived attempts in logs and fencing), CA-04 | PASS |
| D-05 | CA-08, CA-09, PROBE-B | PASS |
| D-06 | `src/main.ts` diff (call before `listen`); CA-06; PROBE-A | PASS |
| D-07 | CA-12 | PASS |
| D-08 | CA-13 (exact patterns), CA-06, CA-08 | PASS |
| D-09 | `process-signals.e2e-spec.ts` (build once in `beforeAll`, spawns `node dist/main.js`, real simulator) runs CA-06, CA-07 and CA-10 | PASS |
| D-10 | CA-07 | PASS |
| D-11 | CA-09, PROBE-B | PASS |

No mandatory requirement is uncovered.

## 5. Technical checks

All commands were run from `/Users/danilosouza/workspace/clinical-event-ingestion-service` on Node v24.21.0.

| Command | Result | Supports |
| --- | --- | --- |
| `npm run build` | exit 0 | CA-01, D-09 (fresh `dist/main.js`) |
| `npm run lint` (`oxlint --type-aware src/ test/`) | exit 0, no diagnostics | CA-01, RNF-04 |
| `npx tsc --noEmit --incremental false -p tsconfig.json` | exit 0 | CA-01 |
| `npx prettier --check "src/**/*.ts" "test/**/*.ts"` | All files use Prettier code style | RNF-04 |
| `npm test` | exit 0, 8 files, 124 tests | CA-01 |
| `npm run test:e2e -- --reporter=verbose` (full) | exit 0, 21 files, 91 tests | CA-01 to CA-14 |
| `npm run test:e2e -- <8 new/touched suites>` (second run) | exit 0, 10 files, 29 tests | Repeat run of the timing-sensitive tests (CA-02 to CA-12, CA-14) |
| `npx vitest run --config ./vitest.config.e2e.ts --dir <scratchpad>/probe` (PROBE-A, PROBE-B) | exit 0, 2 tests | RF-04 (SIGINT), CA-13, CA-09 retry variant |
| `git status --short`, `git diff --stat` on out-of-scope paths | only in-scope files changed; out-of-scope diff empty | Scope, Preserve |

The probe file was written only to the session scratchpad. It imports the repository's `test/support` helpers read-only, and no project file was created or changed.

## 6. Manual and tool-assisted checks

- PROBE-A (child process, SIGINT): `node dist/main.js` with `PROCESSING_DELAY_MS=1500`, `PROCESSING_TIMEOUT_MS=3000`, `LEASE_MS=5000`, `SHUTDOWN_TIMEOUT_MS=10000`. I POSTed 2 events with distinctive `patientId`/`type`/`ts`/`data`, waited until both were `processing` (+300 ms) and sent SIGINT. Observed: exit `{"code":null,"signal":"SIGINT"}` after 1222 ms; output contains `Worker stopping: 2 attempts in flight` and `Worker stopped`; documents `done/1,done/1`; none of the posted values or stored keys appear in stdout or stderr.
- PROBE-B (in-process, CA-09 retry variant made explicit): `SHUTDOWN_TIMEOUT_MS=300`, `PROCESSING_TIMEOUT_MS=4000`, `LEASE_MS=5000`, blocking processor, one attempt in flight, failpoint `update` alwaysOn closeConnection. I released the processor, waited until both driver tries of the `update` were sent (+100 ms, so the worker was in its 1 s D-07 retry wait) and called `app.close()`. Observed: close took 305 ms; worker lines `Worker started…`, `Worker stopping: 1 attempts in flight`, `Shutdown timeout after 300 ms: 1 attempts left for lease reclaim`, `Worker stopped`; `update` count was 2 before close and 2 after 2.5 s; no `findAndModify`/`update` after close; the document stayed `processing`.
- Manual Docker QA (spec section 11, marked optional): not performed. It is not required by any CA.
- No browser, visual or accessibility checks apply (no UI).

## 7. Findings

No blocking or failing findings.

Observations (no remediation required by the spec):

1. The `test/worker-shutdown-timeout.e2e-spec.ts` "CA-09 sends no write retry after the deadline" test does not assert that the shutdown timeout path ran or that the attempt was in its retry wait at the deadline. PROBE-B gave that evidence. A future change could add that assertion to make the repository test self-sufficient.
2. The CA-13 checks in the repository suites look for `patientId`, `ts` and `idempotencyKey` but not the posted `type` or `data` values. PROBE-A covered those, and the anchored D-10/D-08 patterns stop worker lines from carrying payload.
3. CA-11 plan detail: the `processing` branch scans all `processing` index keys (`nextAttemptAt` [MinKey, MaxKey]) and filters `lockedUntil` in FETCH. That meets the criterion (index used, no blocking sort). The cost grows with the number of `processing` documents, which is bounded by instances × `WORKER_CONCURRENCY`. Phase 6 measures contention.
4. The timing-sensitive tests (CA-08 1300 ms bound, CA-12 900/200 ms thresholds) passed in both my runs with margin (304 ms; 1000–1002 ms; 7–13 ms).

## 8. Regression and side-effect review

- Preserved: all Phase 1–3 suites pass unchanged except the superseded Phase 3 CA-05 expectation. Worker CA-16(a)/(b) (`worker-concurrency-1`) pass: close waits for an attempt that finishes in time, and an idle close is prompt. The worker D-10 log templates are unchanged (`D10_PATTERNS` diff only adds alternatives and lines). The fenced filter and update shapes in `recordOutcome` are unchanged. The D-07 lease guard now reads the derived `claim.lockedUntil` (D-04).
- Test-file changes outside the CA-05 assertion: `worker-short-lease.e2e-spec.ts` changes only `POLL_INTERVAL_MS` from 50 to 5000, with a comment and the assertions unchanged. Reclaim would otherwise act on the abandoned event while the test asserts the abandon. The plan permits this (R-02), and the abandon behaviour under test is unchanged. `worker-disabled.e2e-spec.ts` adds one assertion required by CA-13.
- Code review notes: `stop()` takes the deadline before awaiting the loop, so a claim already sent counts against the deadline (RF-05). Cancelled attempts resolve their processor race at once, clear their timer, and return before any further `updateOne` (checks before send, after reply, after error, and after the retry wait). Out-of-scope paths are unchanged: `package.json`, lockfile, `src/database`, `src/events`, `src/config`, compose, Dockerfile, README.
- Data, log and security effects: no new fields or indexes. One new `lastError.code` value (`lease_expired`) with fixed text. New log lines contain only `_id`, counts and milliseconds. No new network surface.
- Side effects of this assessment: `npm run build` refreshed the git-ignored `dist/`. Probe output and logs are in the session scratchpad. Only this report and the spec status metadata were written in the repository.

## 9. Verdict rationale

- Criteria: 14 PASS, 0 FAIL, 0 BLOCKED (CA-01 to CA-14).
- Mandatory requirements: RF-01 to RF-06, RNF-03, RNF-04 and D-01 to D-11 are all covered with passing evidence. RNF-01 and RNF-02 are not applicable per the spec.
- Rule: every criterion has sufficient direct passing evidence and every mandatory requirement is covered, so the overall result is **PASS**.

## 10. Spec status update

- Assessed (pre-update) spec SHA-256: `32e69a9554e4554cbd45606d367532944c653b598814475bc906694a82e2e353`
- Metadata-only changes in `.ai/.specs/events-crash-safety.md` section 1: `Status: ready for implementation.` became `Status: implemented and verified.`; `Updated: 2026-11-02.` was kept (today); an `Assessment:` line linking this report was added (format of `events-data-model.md` / `events-ingest-path.md`). No requirement text was changed.
- Final (post-update) spec SHA-256: `456661538c24670a1ff3f0e02e3e6072b9089a3bf99c20fb5b315a302d3dd2ad`
