# Implementation report: events-read-endpoints

## 1. Identity and result

- Result: COMPLETE
- Date: 2026-11-02
- Spec: `.ai/.specs/events-read-endpoints.md`, SHA-256 `6bf83c6150c510b441ece99baae69cf5a37f6faa08007970966cdde654f14c39` (recomputed, matches the plan)
- Plan: `.ai/.plans/events-read-endpoints.md` (SHA-256 not recorded by the plan; it embeds the spec hash above)
- Repository: `clinical-event-ingestion-service` only

## 2. Starting state

- Branch `main`, HEAD `84593be`.
- Pre-existing uncommitted changes (not from this run): untracked `.ai/.specs/events-read-endpoints.md` and `.ai/.plans/events-read-endpoints.md`. No overlap with planned files.
- Environment: Node v24.21.0, MongoDB 7.0.45 (mongodb-memory-server replica set).

## 3. Task execution

- T-01 completed: `src/health/health.controller.ts` (1000 ms timer race, late ping absorbed, `ServiceUnavailableException({status:'error',mongo:'down'})`), `src/health/health.module.ts` imports `DatabaseModule`. RF-01, D-01..D-03.
- T-02 completed: `test/app.e2e-spec.ts` (1 line), `test/worker-store-down.e2e-spec.ts` (2 lines: 503 and the down body).
- T-03 completed: new `src/stats/stats.service.ts` (exports `dueFilter`, `expiredLeaseFilter`, `OLDEST_DUE_OPTIONS`, `STATS_STATUSES`, `StatsBody`), `stats.controller.ts`, `stats.module.ts`; `src/app.module.ts` imports `StatsModule`. RF-02, RF-03, D-04..D-06, D-09.
- T-04 completed: `src/stats/stats.service.spec.ts` (6 tests, including code 50 and one-warn-for-parallel-failures).
- T-05 completed: `test/health.e2e-spec.ts` (CA-02, CA-03, CA-05, CA-10 for health).
- T-06 completed: `test/stats.e2e-spec.ts` (CA-06, D-05 command shape, CA-08, CA-10).
- T-07 completed: `test/read-endpoints-store-down.e2e-spec.ts` (CA-04 worker disabled, CA-07).
- T-08 completed: `test/health-worker-store-down.e2e-spec.ts` (CA-04 worker enabled).
- T-09 completed: `test/stats-worker.e2e-spec.ts` (CA-09, CA-10).
- T-10 completed: `README.md` (`GET /health` and `GET /stats` sections; old sentence replaced by a pointer to the new section).
- T-11 completed: verification below.

## 4. Behavior delivered

- `GET /health`: `200 {status:'ok',mongo:'up'}` when ping resolves within 1000 ms, else `503 {status:'error',mongo:'down'}`. No logs.
- `GET /stats`: D-04 body from six `countDocuments` and one `findOne`, all with `maxTimeMS: 5000`; store errors and code 50 map to the existing 503 with one warn (context `StatsService`); other errors rethrown.
- Preserved: POST /events, worker, indexes, env, compose, Dockerfile, package.json untouched.

## 5. Deviations

- Spec section 7 / README: the README sentence under "Running" was replaced by "The Compose healthcheck calls `GET /health`; see below." rather than only removed. Spec text "reports whether the app is up" is gone (grep count 0).
- CA-03 failpoint confirmation: no separate direct-ping timing check was made. Evidence of delay is indirect: with Mongo healthy, `/health` returned 503 at about 1005 ms with the failpoint on and 200 after it was turned off.
- CA-10 in `test/stats-worker.e2e-spec.ts`: Nest's own startup/route log lines (RoutesResolver, RouterExplorer, NestApplication) are allowed in addition to `EventsWorker` lines.
- `test/stats.e2e-spec.ts` compares `find.sort` via `Object.fromEntries` because the driver emits a Map.

## 6. Verification evidence

All run in the repository root.

- `npm run build`: exit 0 (passed).
- `npm run lint`: exit 0, no findings (passed).
- `npx tsc --noEmit --incremental false -p tsconfig.json`: exit 0 (passed).
- `npm test`: 9 files, 130 tests passed.
- `npm run build` then `npm run test:e2e`: 26 files, 101 tests passed, including unchanged `test/process-signals.e2e-spec.ts`.
- Targeted rerun of the four new Mongo-timing files (verbose): 4 files, 9 tests passed.
- Slow-ping method: `failCommand` failpoint on `ping` (`appName` filter, `blockTimeMS: 3000`) worked; no wrapper fallback needed.
- Observed times: CA-03 `/health` 1005 ms; CA-04 worker disabled 1017 ms; CA-04 worker enabled 1022 ms; CA-07 `/stats` 5009 ms.
- CA-08 winning plans (printed by the test): the four status counts and `due` use `COUNT_SCAN` on `claim_status_nextAttemptAt`; `expiredLeases` uses `FETCH` over `IXSCAN` on the claim index; `findOne` uses `LIMIT > PROJECTION_SIMPLE > FETCH > IXSCAN` on the claim index with forward direction. No COLLSCAN, no SORT.
- `git diff` of existing tests: only the three `/health` lines listed in T-02 changed.
- README grep: `grep -c "reports whether the app is up" README.md` is 0; both sections present.
- Per-CA: CA-01..CA-11 passed by the above. CA-11 verified by reading the README diff.
- Not run: the optional manual Docker Compose QA; `/stats` recovery after Mongo restart (not automated per spec).

## 7. Changed-file inventory

- Modified: `README.md`, `src/app.module.ts`, `src/health/health.controller.ts`, `src/health/health.module.ts`, `test/app.e2e-spec.ts`, `test/worker-store-down.e2e-spec.ts`.
- Created: `src/stats/stats.service.ts`, `src/stats/stats.controller.ts`, `src/stats/stats.module.ts`, `src/stats/stats.service.spec.ts`, `test/health.e2e-spec.ts`, `test/stats.e2e-spec.ts`, `test/read-endpoints-store-down.e2e-spec.ts`, `test/health-worker-store-down.e2e-spec.ts`, `test/stats-worker.e2e-spec.ts`, `.ai/.implementations/events-read-endpoints.md`.
- Nothing staged or committed.

## 8. Outstanding work and blockers

None. R-03 interpretation: CA-04 worker-enabled is split between the minimal edit of `worker-store-down` (status and body) and the new `health-worker-store-down` (timing and log silence).

## 9. Assessment handoff

Ready for `/assess-spec`. No acceptance approval is claimed.
