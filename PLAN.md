# Plan: Ingest Service assessment

## 1. The problems hidden in section 3, and how we answer them

| # | Condition | Problem it creates | Answer |
|---|---|---|---|
| P1 | 1000 events/min, 5s each, growing | About 17 events/s × 5s means about **84 events in flight at any time**. Processing one at a time can't keep up. | Separate accepting from processing. Each process runs a worker pool with set concurrency (default 100). More replicas of the same image handle growth. |
| P2 | Answer the sender immediately | Can't run the 5s work inside the request | Store the event durably, then return `202 Accepted`. Processing happens in the background. |
| P3 | Senders retry and send duplicates | The same event arrives more than once | Content hash of the event as the idempotency key, with a **unique index**. A duplicate POST returns `202` with the original record. |
| P4 | Never lost | A crash between "accepted" and "processed" | Return 202 only after a `w:majority` write. Processing is at-least-once. Nothing is deleted. Permanent failures end as a visible `failed` status. |
| P5 | Never counted twice | At-least-once processing can apply an event twice | Completing an event is a conditional update: it only applies if this worker still holds the event. The external call gets the event hash as its idempotency key. |
| P6 | Processes killed mid-work | A worker dies while holding an event | Claims carry a **lease** (`lockedUntil`). Expired leases are reclaimed. On SIGTERM, stop claiming and let in-flight events finish. |
| P7 | Order matters per patient, arrival order isn't guaranteed | The patient's state depends on the order its events are applied in | **Order is rebuilt when the data is read, not when it is processed.** Every event is stored unchanged with its `ts`. Consumers read a patient's events sorted by `ts`, with a fixed tie-break, through a dedicated index. Processing order doesn't matter (see the assumption in G2). |
| P8 | Late events | An earlier-`ts` event arrives after later ones | Nothing special to do. Once stored, a late event sorts into its correct place for any reader. |
| P9 | Growth and backpressure | The backlog grows faster than workers drain it | `GET /stats` shows queue depth and lag. Scale by adding replicas. Events for the same patient are processed in parallel, so patients that send many events don't slow themselves down. |
| P10 | "A way for us to see that it does" | The evaluators need proof, not claims | Load, chaos and verification scripts (Phase 6). |

## 2. Decisions (the former gaps)

**G1. Event identity: content hash only.**
- `idempotencyKey = sha256(canonicalJson({ patientId, type, ts, data }))`.
- `ts` is normalized to UTC milliseconds and object keys are sorted, so formatting differences don't create new events.
- Trade-off: two genuinely separate events with identical content are merged into one. Documented in the README.

**G2. Ordering: order is a read-side concern.**
- **Assumption, stated in the README:** processing an event doesn't depend on the patient's earlier events, and the external call doesn't care about order. The spec says the processing logic doesn't matter, so this is reasonable.
- Workers claim any due pending event, oldest first, with no grouping by patient.
- Consumers rebuild a patient's sequence by sorting on `ts`. Ties are broken by `receivedAt`, then `_id`. An index on `{ patientId, ts, receivedAt, _id }` makes that read cheap.
- `ts` comes from the senders' clocks. Clock skew between senders is accepted and listed as a known limit.
- If the external system ever needs one event at a time per patient, in order, this assumption no longer holds. See "With more time" in Phase 8.

**G3. Late events: no special handling.**
- Because order is rebuilt at read time, a late event takes its correct position as soon as it is stored. It is never flagged, reordered or recomputed.

**G4. Outcome: stored on each event only.**
- Each event document holds its status, result and `processedAt`.
- There is no separate patient-state document. A patient's history is a query over its events sorted by `ts`.

**G5. Storage: one collection, no broker.**
- The `events` collection is both the work queue and the result store. No Redis, Kafka or BullMQ.

**G6. External system: pass an idempotency key.**
- The simulated call receives `idempotencyKey`. We assume the real system honours it, and the README says so.
- Our own store gives the effect of exactly-once. The external call is at-least-once plus that key.

**G7. Failures: configurable simulated failures, up to 5 attempts, then flag.**
- The simulator has a failure rate and a timeout, both set by environment variables (default failure rate about 5%).
- Up to 5 attempts, with exponential backoff and jitter. After that: `status: failed` with `lastError`.
- A failed event doesn't block anything else, including the same patient's other events. The failure stays visible.

**G8. HTTP contract.**
- `POST /events` returns `202 { id, status, duplicate }` for both new and duplicate events.
- A body that fails validation returns `400` immediately. The sender knows, so the event is not silently lost.
- Validation:
  - `patientId`: non-empty string, at most 128 characters
  - `type`: non-empty string, at most 64 characters, free-form rather than a fixed list
  - `data`: must be a JSON object
  - `ts`: ISO 8601 with a timezone offset
  - body size: Express's default limit
- The "same key, different payload → 409" case can't happen with content hashing.

**G9. Read endpoints: `GET /stats` and `GET /health`.**
- `/stats`: counts by status, oldest pending age (lag), failed count.
- `/health`: liveness plus the Mongo connection, used by the docker compose health check.

**G10. Sizing.**
- Worker concurrency defaults to 100 per process: 84 needed plus headroom.
- The load test spreads events over about 500 patients, with a few patients that send many events.
- Growth: the README shows the math for 10× (about 840 in flight means several replicas) and where Mongo-as-queue stops scaling.

**G11. Runtime: Node everywhere, drop bun.**
- npm as the package manager. Remove `bun.lock` and update the scripts and README.
- The Docker image runs on Node LTS. Locally, `docker compose up` starts Mongo and the app.

**G12. Scope: core service plus the load, chaos and verification scripts.**
- One process runs both the HTTP API and the worker. Horizontal scaling means running more replicas of the same image.
- Moved to "with more time": per-patient serialization, separate API and worker roles, waking workers with change streams, structured logs and metrics, a real broker.

## 3. The claim query

With no grouping by patient, claiming is a plain atomic update:
- `findOneAndUpdate({ status: pending, nextAttemptAt <= now })`, sorted by `nextAttemptAt`.
- It sets `status: processing`, `workerId`, `lockedUntil` and increments `attempts`.

Many workers race for the oldest documents. `findOneAndUpdate` is atomic, so each document is claimed by only one worker. Check under load that the contention stays cheap at 100 concurrent workers per process times several replicas.

Expired leases are reclaimed by the same claim: also match `status: processing, lockedUntil < now`.

## 4. What to produce

1. **The service:** `POST /events`, `GET /stats`, `GET /health`, and background workers in the same process.
2. **MongoDB setup:** a single-node replica set in `docker-compose.yml` for majority writes. Indexes for idempotency, claiming, and reading a patient's events in order.
3. **Tests that cover the risky parts.**
4. **Load, chaos and verification scripts.**
5. **A README:** architecture, decisions, trade-offs, known limits, and what to do with more time.
6. **A readable commit history.**

## 5. Implementation phases (one or more commits each)

**Phase 0: Housekeeping**
- Move from bun to npm: remove `bun.lock`, generate `package-lock.json`, update the scripts.
- Replace the boilerplate README. Remove the `AppController`/`AppService` examples.
- Validate configuration from environment variables: concurrency, lease time, processing delay, failure rate, maximum attempts, backoff.
- `Dockerfile` (Node LTS) and `docker-compose.yml` (Mongo replica set plus the app, with health checks).

**Phase 1: Ingest path**
- `EventsModule` with a DTO and validation (G8).
- Content hash (G1) with a unique index.
- Insert with `w:majority`. On a duplicate-key error, return the existing record. Respond `202 { id, status, duplicate }`.

**Phase 2: Data model** (the `events` collection)
- Fields: `_id`, `idempotencyKey`, `patientId`, `type`, `data`, `ts`, `receivedAt`, `status` (`pending | processing | done | failed`), `attempts`, `nextAttemptAt`, `lockedUntil`, `workerId`, `result`, `lastError`, `processedAt`.
- Indexes:
  - unique `idempotencyKey`
  - claim index on `{ status, nextAttemptAt }`
  - read-order index on `{ patientId, ts, receivedAt, _id }`

**Phase 3: Worker**
- A polling loop with bounded concurrency. Claim as described in section 3.
- The simulated processor: 5s delay, configurable failure rate and timeout, receives the idempotency key.
- Complete with a conditional update that requires `workerId` and `status: processing`.
- On failure: set `status: pending` and `nextAttemptAt` with backoff. After 5 attempts: `failed`.

**Phase 4: Crash safety**
- Reclaim expired leases.
- Graceful shutdown with `enableShutdownHooks`: stop claiming, wait for in-flight events up to a timeout.

**Phase 5: Read endpoints**
- `GET /stats` and `GET /health`.

**Phase 6: Proof**
- Load script at ≥1000/min for several minutes:
  - about 10% duplicate POSTs, including concurrent ones
  - `ts` shuffled per patient
  - about 500 patients, a few of them sending many events
- Chaos: kill the app container partway through, then let it restart.
- Verification script that asserts:
  - every unique event ends up `done` or `failed`; nothing stays stuck
  - exactly one document per idempotency key
  - each event was completed exactly once (no lost or doubled completions)
  - reading each patient's events by the read-order index gives the `ts` order the load script generated
  - the count of `failed` events is reported
  - throughput and lag stay within limits

**Phase 7: Tests**
- Unit:
  - DTO validation
  - canonical hash (key order and `ts` format don't change it)
  - retry and backoff policy
- Integration against a real Mongo replica set (testcontainers or mongodb-memory-server):
  - concurrent duplicate POSTs give one record
  - two workers never claim the same event
  - an expired lease is reclaimed and the event isn't completed twice
  - a stale worker can't complete an event that was reclaimed by another worker
  - after 5 failed attempts the event ends as `failed`
- E2E: POST, then poll until `done`.

**Phase 8: README**
- Architecture diagram.
- A table mapping each section 3 condition to the mechanism that handles it (section 1 of this plan).
- Decisions and rejected alternatives (section 2 of this plan): Mongo as the queue vs a broker, polling vs change streams, content hash vs explicit key, rebuilding order at read time vs serializing processing per patient.
- Sizing math and how to scale.
- Known limits:
  - Identical events without a key are merged.
  - Sender clock skew affects ordering.
  - Ordering relies on the assumption in G2. Processing itself runs in any order.
  - The external call is at-least-once and relies on the idempotency key.
  - Mongo-as-queue has a throughput ceiling.
- "With more time":
  - **Per-patient serialization**, if the external system must receive one event at a time per patient, in `ts` order:
    - an `inFlight` flag, set while an event is processing or waiting between retries
    - a partial unique index on `{ patientId }` where `inFlight: true`, so Mongo refuses a second claim for the same patient
    - the oldest `ts` first within each patient
    - the patient held during retries, so a short failure doesn't let a later event go first
    - events that arrive after a later one was sent get flagged `late`
    - costs: patients that send many events slow themselves down, and claims have to skip patients that are already held
  - an explicit `Idempotency-Key` header
  - separate API and worker roles
  - change streams
  - metrics and alerting
  - a broker partitioned by patient
  - a way to retry failed events
