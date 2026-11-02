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

## Tests

```bash
npm test           # unit tests
npm run test:e2e   # end-to-end tests
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
