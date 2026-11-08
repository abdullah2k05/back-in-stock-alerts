# Back-in-Stock Alerts

A small production-minded service for a merchant's "email me when this is back" flow:

- Hosted, embeddable subscription form (`/embed?sku=...`)
- Stock webhook that only sends after re-checking live stock
- Durable SQLite outbox with idempotent retries, so an email is not lost or sent twice
- Password-protected admin dashboard (`/admin`)
- Docker image and tests

Built for the Upwork "Back-in-Stock Alerts" challenge. The Resend-format email endpoint is the one the challenge harness provides; the same payload works with the real Resend API (`POST /emails`).

## Requirements

- Node.js 22+
- No external services are needed for tests; the suite starts mock stock/email servers.

## Run locally

```bash
npm ci
cp .env.example .env   # fill in the challenge harness credentials
npm run dev
```

Or with plain environment variables:

```bash
STOCK_API_URL=https://harness-production-e601.up.railway.app/api/stock \
STOCK_API_KEY=re_test_... \
RESEND_API_KEY=re_test_... \
RESEND_BASE_URL=https://harness-production-e601.up.railway.app \
WEBHOOK_SECRET=whsec_... \
ADMIN_PASSWORD=change-me \
PORT=3000 DATA_DIR=./data npm start
```

Open:

- Form: `http://localhost:3000/embed?sku=MUG-STN-SAGE`
- Admin: `http://localhost:3000/admin` (HTTP Basic auth; any username, password = `ADMIN_PASSWORD`)
- Health: `http://localhost:3000/healthz`

The harness key, webhook secret, and candidate base URL are created by signing up at the harness and shown on its dashboard. Point the harness at the app's public URL before using its test endpoints.

## Environment

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `STOCK_API_URL` | yes | – | Stock catalogue base URL |
| `STOCK_API_KEY` | yes | – | Bearer token for stock API |
| `RESEND_API_KEY` | yes | – | Bearer token for email API |
| `RESEND_BASE_URL` | yes | – | Email API base URL |
| `WEBHOOK_SECRET` | yes | – | Expected `x-webhook-secret` |
| `ADMIN_PASSWORD` | yes | – | Admin dashboard password |
| `PORT` | no | `3000` | HTTP port |
| `DATA_DIR` | no | `./data` | SQLite location |
| `EMAIL_FROM` | no | `Back in Stock <alerts@example.com>` | From header |
| `STORE_NAME` / `STORE_URL` | no | `Our Store` / – | Branding and links in the email/form |
| `HTTP_TIMEOUT_MS` | no | `8000` | Stock API timeout |
| `EMAIL_TIMEOUT_MS` | no | `10000` | Email API timeout |
| `OUTBOX_MAX_ATTEMPTS` | no | `8` | Give up after this many attempts |
| `OUTBOX_BACKOFF_MS` / `OUTBOX_MAX_BACKOFF_MS` | no | `3000` / `60000` | Exponential retry delay |
| `OUTBOX_WORKER_MS` | no | `5000` | Outbox poll interval |
| `CATALOGUE_TTL_MS` | no | `60000` | Catalogue cache lifetime |
| `ADMIN_MAX_FAILURES` / `ADMIN_LOCKOUT_MS` | no | `10` / `900000` | Basic-auth brute-force lockout |
| `BODY_LIMIT` | no | `16kb` | JSON body limit |

## HTTP API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/embed?sku=...` | Embeddable page (`frame-ancestors *`); without `sku` shows a product picker |
| `GET` | `/` | Redirects to `/embed` |
| `POST` | `/api/requests` | `{ email, sku }`; `201` created, `409` already waiting, `200` product is in stock |
| `POST` | `/webhooks/stock` | Requires `x-webhook-secret`; `{ event_id, type: "stock.updated", sku, quantity, occurred_at }` |
| `GET` | `/admin` | Basic auth; filters by email/SKU/status, outbox state and recent webhook deliveries |
| `GET` | `/healthz` | Liveness/readiness |

## Duplicate and missed-email safety

Sending exactly one email is the hard part, so the design layers four guards:

1. **Webhook dedupe** – `event_id` is the primary key. A repeated delivery sees the first row as completed/skipped and returns `200` without work; concurrent duplicates get `200` with `in_progress`.
2. **Open-request uniqueness** – a partial unique index allows at most one `pending` request per `(email, sku)`, so double-submits and repeated events cannot create two emails.
3. **Durable outbox** – the webhook transaction claims requests and writes `outbox` rows before responding. Email is sent only from the outbox worker, with an `Idempotency-Key` derived from the request id. A crash after send is retried with the same key, so Resend/harness returns the original send instead of a second email. Interrupted `sending` rows are reset to `pending` on boot.
4. **Stock re-verification** – before enqueuing, the app fetches the SKU from the stock API. A stale or phantom "back in stock" webhook with zero/unknown quantity, or a stock check that says out of stock, skips the send.

Transient email failures (timeouts, 408/429/5xx) retry with exponential backoff. Permanent 4xx errors stop immediately. Exhausted rows remain visible in the admin as `failed` with the last error.

Known limit: the idempotency key is `bis-request-<local request id>`, so two separately deployed databases sharing one email account could collide. That is out of scope for a single-merchant deployment.

## Tests

```bash
npm test          # 45 tests: requests, webhooks, email/outbox, admin, security
npm run test:docker
```

The suite uses an isolated temp `DATA_DIR`, mock stock/email servers, and covers webhook secrets, duplicate/concurrent deliveries, phantom stock, retry/backoff, email HTML escaping, rate limits, CORS, CSP, admin lockout, and restart recovery.

## Docker

```bash
docker build -t back-in-stock-alerts .
mkdir -p data   # bind mounts must be writable by the container's UID 1000
docker run -d --name bis \
  -p 3000:3000 \
  -v "$PWD/data:/data" \
  -e STOCK_API_URL=... -e STOCK_API_KEY=... \
  -e RESEND_API_KEY=... -e RESEND_BASE_URL=... \
  -e WEBHOOK_SECRET=... -e ADMIN_PASSWORD=... \
  back-in-stock-alerts
```

`DATA_DIR` defaults to `/data` in the image; mount a volume there so the SQLite database survives restarts. The image runs as the non-root `node` user and has a `/healthz` HEALTHCHECK.

`npm run test:docker` builds the image and verifies it boots with environment variables only, serves static assets, redirects `/`, and protects `/admin`.

## Deploy to Railway

1. Install the Railway CLI and log in.
2. From this directory: `railway init` then `railway up`.
3. Add all required variables from the table above (`PORT` is provided by Railway; keep `DATA_DIR=/data`).
4. Add a volume mounted at `/data`.
5. Set `STOCK_API_URL`/`STOCK_API_KEY`/`RESEND_*`/`WEBHOOK_SECRET` from the harness dashboard, and `ADMIN_PASSWORD` to a long random value.
6. After the first deploy, copy the public URL into the harness candidate dashboard and run its restock tests.

`railway.json` configures the Dockerfile build and `/healthz` health check.

## AI usage

Implementation and tests were written with **opencode** (CLI coding agent). All flows were verified locally against the challenge harness, including duplicate concurrent webhooks, phantom restocks, injected email 500s, and container restart persistence.
