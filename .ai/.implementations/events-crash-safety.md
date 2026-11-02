# Implementation report: events-crash-safety

## 1. Identity and result

- Result: COMPLETE
- Date: 2026-11-02
- Spec: `.ai/.specs/events-crash-safety.md`, SHA-256 `32e69a9554e4554cbd45606d367532944c653b598814475bc906694a82e2e353` (recomputed, matches the plan)
- Plan: `.ai/.plans/events-crash-safety.md`, SHA-256 `d3cfe942dfd93d57dc35ac8d25724aa7da4f839da6fc7613e35ff757282cd841`
- Repository: `clinical-event-ingestion-service` only.

## 2. Starting state

- Branch `main`, HEAD `79348bc`.
- Pre-existing uncommitted changes (not from this run): untracked `.ai/.plans/events-crash-safety.md` and `.ai/.specs/events-crash-safety.md`. No tracked file was modified before the run.
- Nothing staged, committed or discarded by this run.

## 3. Task execution

- T-01 completed: `test/support/worker.ts` (`D10_PATTERNS` gained `lease_expired` and the three D-08 patterns; `D12_MESSAGES` gained the `lease_expired` text). D-08, CA-13.
- T-02 completed: `src/worker/events-worker.ts`, slot waiter (`waitForSlot`) and stop wake split from the poll wait (`waitForPoll`). RF-06, D-07.
- T-03 completed: `claim()` with the `$or` filter, `returnDocument: 'before'`, derived `Claim` record (`attempts`, `lockedUntil`, `reclaimed`), reclaim warn in `attempt()`. RF-01, RF-02, D-01, D-02, D-04.
- T-04 completed: `ErrorCode` gained `lease_expired`, fixed message constant, guard in `attempt()` routed through `recordOutcome`. RF-03, D-03.
- T-05 completed: `AttemptState` (abort controller, cancelled flag, cancellable retry wait), bounded `stop()` and `drain()`, cancelled attempts send no further writes. RF-05, D-05, D-11.
- T-06 completed: `src/main.ts` calls `app.enableShutdownHooks(['SIGTERM', 'SIGINT'])` before `listen`. RF-04, D-06.
- T-07 completed: CA-05 test in `test/worker.e2e-spec.ts` updated (CA-14); `POLL_INTERVAL_MS` 50 to 5000 in `test/worker-short-lease.e2e-spec.ts`; one added assertion in `test/worker-disabled.e2e-spec.ts`.
- T-08 completed: `test/worker-reclaim.e2e-spec.ts` (CA-02, CA-05, CA-11, CA-13).
- T-09 completed: `test/worker-reclaim-limit.e2e-spec.ts` (CA-03 a-d).
- T-10 completed: `test/worker-reclaim-stale.e2e-spec.ts` (CA-04).
- T-11 completed: `test/worker-shutdown-timeout.e2e-spec.ts` (CA-08, CA-09 incl. retry variant).
- T-12 completed: `test/worker-poll-spacing.e2e-spec.ts`, `test/worker-pool-wake.e2e-spec.ts` (CA-12).
- T-13 completed: `test/process-signals.e2e-spec.ts` (CA-06, CA-07, CA-10, CA-13 process part).
- T-14 completed: verification below. The optional `src/worker/events-worker.spec.ts` was not written.

## 4. Behavior delivered

- Expired `processing` events are claimed atomically with due `pending` ones; a reclaim counts as an attempt and logs a warn.
- A reclaim with `attempts > MAX_ATTEMPTS` ends `failed` (`lease_expired`) with no processor call; non-reclaim claims keep the old behaviour.
- SIGTERM and SIGINT run `app.close()`; the worker drains for up to `SHUTDOWN_TIMEOUT_MS`, then warns, aborts and leaves unfinished events for lease reclaim, with no commands after `Worker stopped`.
- F-01 resolved: a settled attempt no longer cuts short the `POLL_INTERVAL_MS` wait.
- No change to HTTP contract, indexes, config, model, compose, Dockerfile, README, dependencies.

## 5. Deviations

1. `test/worker-short-lease.e2e-spec.ts`: setting-only change `POLL_INTERVAL_MS` 50 to 5000 (plan R-02), no assertion changes. Needed because reclaim would otherwise run while the abandon is asserted.
2. `test/process-signals.e2e-spec.ts` CA-06/CA-07: a 300 ms pause between "3 events processing" and sending SIGTERM. The claim is stored before the worker sees its reply, so without it the logged count could be 2 (observed as a flaky failure while developing). Spec bounds unchanged.
3. Plan section 2 items 4 and 5 (spec wording vs Nest 12.3.2: HTTP close order, second signal ignored) were not exercised or tested; no code depends on them (R-06).
4. The test harness waits for the child `close` event (not `exit`) so piped stdout is fully read.
5. CA-03(a) test waits for the `lease_expired` log line, since it is emitted after the write that the document check observes.

## 6. Verification evidence

Environment: Node v24.21.0, MongoDB 7.0.45 (mongodb-memory-server, one-member replica set), macOS.

Passed:
- `npm run build`: exit 0 (CA-01).
- `npm run lint`: exit 0, no output (CA-01).
- `npx tsc --noEmit --incremental false -p tsconfig.json`: exit 0.
- `npm test`: 8 files, 124 tests passed (CA-01).
- `npm run test:e2e`: two consecutive final runs, each 21 files, 91 tests passed, exit 0 (CA-01 to CA-14).
- Focused verbose run of the new and touched suites: 16 tests passed.
- Per-CA: CA-02, CA-03 a-d, CA-04, CA-05, CA-06, CA-07, CA-08, CA-09 (incl. retry variant), CA-10, CA-11, CA-12, CA-13, CA-14 all passed.
- Observations: child exit on SIGTERM `{"code":null,"signal":"SIGTERM"}` (drain about 1.2 to 1.5 s); `app.close()` with timeout took 304 ms; poll spacing: empty claim to next claim 1002 ms (settle to next 994 ms), failed claim to next 1003 ms; pool-full wake: next claim 7 ms and 4 ms after settle; short-lease: 2 worker-level writes.
- CA-11 winning plan: `UPDATE > SUBPLAN > LIMIT > FETCH > SORT_MERGE` over two `IXSCAN` stages, both `claim_status_nextAttemptAt` (the processing branch has a `lockedUntil` FETCH filter); no `SORT` stage.
- Failpoints used: CA-03(d) `failCommand` on `update`, `closeConnection`, `times: 2`; CA-09 retry variant `alwaysOn` on `update` (turned off in `afterEach`); CA-12 `failCommand` on `findAndModify`, `errorCode: 2`, `times: 1`. No wrapper fallback.
- Log templates: `grep "logger\." src/worker/events-worker.ts` shows only worker D-10 and D-08 templates.

Failed: none in the final runs. Earlier runs in this session failed on the two test-harness races described in deviations 2 and 5; both were repaired once and then passed.

Not run: manual Docker procedure (optional); optional unit spec.

## 7. Changed-file inventory

Modified: `src/worker/events-worker.ts`, `src/main.ts`, `test/support/worker.ts`, `test/worker.e2e-spec.ts`, `test/worker-short-lease.e2e-spec.ts`, `test/worker-disabled.e2e-spec.ts`.
Created: `test/worker-reclaim.e2e-spec.ts`, `test/worker-reclaim-limit.e2e-spec.ts`, `test/worker-reclaim-stale.e2e-spec.ts`, `test/worker-shutdown-timeout.e2e-spec.ts`, `test/worker-poll-spacing.e2e-spec.ts`, `test/worker-pool-wake.e2e-spec.ts`, `test/process-signals.e2e-spec.ts`, and this report.
`package.json`, lockfile, `src/database`, `src/events`, `src/config`, compose, Dockerfile, README untouched (`git diff --stat` empty for them). `dist/` is git-ignored build output.

## 8. Outstanding work and blockers

None. Follow-ups: Phase 5 may expose reclaim counts/draining state; Phase 6 measures recovery. Spec wording on Nest close order and second signal (R-06) could be corrected via `/create-spec`. Timing-sensitive tests (CA-08 1300 ms bound, CA-12 200 ms) passed in all final runs but depend on machine load.

## 9. Assessment handoff

Artifacts are ready for `/assess-spec`. This report does not claim acceptance approval.
