# Clinical Event Ingestion Service

A NestJS service that accepts clinical events over HTTP, stores them durably in MongoDB and processes them in the background. It deduplicates retried events and survives crashes without losing an event or applying one twice.

> Work in progress. The architecture, decisions, trade-offs and known limits will be documented here as the service is built.

## Running

Requirements: Docker with Compose. For running outside Docker: Node 24 and npm.

```bash
docker compose up --build
```

This starts a single-node MongoDB replica set and the app at <http://localhost:3000>. To use another host port, for example when 3000 is taken:

```bash
APP_PORT=3001 docker compose up --build
```

`GET /health` reports whether the app is up.

### Without Docker for the app

Start only Mongo, then run the app with npm:

```bash
docker compose up -d mongo
npm install
npm run start:dev
```

The default `MONGO_URI` points at this Mongo with `directConnection=true`. The replica set advertises itself as `mongo:27017`, a name that only resolves inside the Compose network.

## POST /events

Stores one event durably, then answers `202`. The app connects to MongoDB at startup and exits if it cannot, so start Mongo first.

```bash
curl -i -XPOST localhost:3000/events -H 'content-type: application/json' \
  -d '{"patientId":"p-demo","type":"vitals","ts":"2026-11-02T10:00:00Z","data":{"hr":72}}'
```

| Field | Rule |
|---|---|
| `patientId` | string, not blank, at most 128 characters |
| `type` | string, not blank, at most 64 characters |
| `ts` | `YYYY-MM-DDTHH:mm:ss[.fraction](Z\|±HH:mm)`, uppercase `T`/`Z`, a real calendar instant between years 1970 and 9999. Fractions beyond milliseconds are truncated |
| `data` | JSON object (`{}` allowed), content is free-form |

Any other top-level field is rejected. Values are never trimmed or changed.

| Status | Meaning |
|---|---|
| `202` | Stored with majority write concern. Body is `{ "id", "status", "duplicate" }`. `duplicate: true` means the same content was already stored: `id` and `status` are those of the original and nothing is written |
| `400` | Validation failed (`message` is a list of fixed strings) or the JSON is malformed (`"Malformed JSON body"`). Nothing is stored |
| `413` | Body larger than 100 kb |
| `503` | The store could not confirm the write in time. Retrying is safe: the retry is idempotent |

Duplicates are detected by content: the idempotency key is the SHA-256 of the canonical JSON of `{ data, patientId, ts, type }` (object keys sorted, `ts` normalized to UTC milliseconds). Key order, time zone notation and fraction length do not matter, but two real events with identical content are merged.

Known limit: there is no authentication. Deploy the service behind a gateway or mTLS.

## Tests

```bash
npm test           # unit tests
npm run test:e2e   # end-to-end tests (downloads MongoDB 7.0.45 on first run)
npm run lint
```

## Configuration

All settings come from environment variables and have defaults. The app validates them at startup and refuses to start if any value is invalid, listing every problem. An empty value counts as unset. With Docker Compose, a variable set in your shell is passed to the app container.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port inside the process or container |
| `MONGO_URI` | `mongodb://localhost:27017/ingest?directConnection=true` | Mongo connection string (Compose sets it to the `mongo` service) |
| `WORKER_CONCURRENCY` | `100` | Events processed at the same time per process |
| `LEASE_MS` | `30000` | How long a worker holds a claimed event before others may reclaim it. Must be greater than `PROCESSING_TIMEOUT_MS` |
| `POLL_INTERVAL_MS` | `500` | How long an idle worker waits before looking for due events again |
| `PROCESSING_DELAY_MS` | `5000` | Duration of the simulated external call |
| `PROCESSING_TIMEOUT_MS` | `10000` | Time after which the simulated call is treated as failed |
| `FAILURE_RATE` | `0.05` | Fraction of simulated calls that fail, from 0 to 1 |
| `MAX_ATTEMPTS` | `5` | Attempts before an event is marked `failed` |
| `BACKOFF_BASE_MS` | `1000` | Base delay for exponential backoff between attempts |
| `BACKOFF_MAX_MS` | `60000` | Maximum backoff delay. Must be at least `BACKOFF_BASE_MS` |
| `SHUTDOWN_TIMEOUT_MS` | `20000` | How long shutdown waits for in-flight events |
| `APP_PORT` | `3000` | Compose only: host port mapped to the app |

## Why MongoDB 7.0

MongoDB 8.x and 9.x refuse to start on Linux kernels 6.19 through 7.0.13 ([SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912)), and current Docker Desktop VMs run kernels in that range. 7.0 runs on every kernel. It has everything this service needs: replica sets, majority write concern and atomic `findOneAndUpdate`.
