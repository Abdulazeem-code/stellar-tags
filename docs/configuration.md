# Configuration

Environment variables, logging and internal mTLS for the server and dashboard.

> Back to the [README](../README.md).

## Frontend (`payment-dashboard/.env`)
- `VITE_API_BASE` - The base URL where the frontend expects the Node.js server API to be running (e.g., `http://localhost:5000`).

## Server (`stellar-payment-platform/.env` or exported directly)
- `DATABASE_URL` - **(Required)** PostgreSQL connection string used by Prisma (see [Database setup](development.md#database-setup)).
- `PORT` - (Optional) The port for the Node.js server to listen on. Defaults to `5000`.
- `HORIZON_NETWORK` - (Optional) Stellar network for the payment listener: `testnet` (default) or `public`. Also selects the `NETWORK_PASSPHRASE` published for SEP-10.
- `STELLAR_TAG_DOMAIN` - (Optional) Extra origin to add to the CORS allow-list. Also the default for federation and SEP-10 discovery domains.
- `PAY_PAGE_URL` - (Optional) Origin of the dashboard, which serves the `/pay/<tag>` page (for example `https://app.example.com`). Payment request links and QR codes point here. Falls back to `PUBLIC_API_URL`, then `DOMAIN`, then the API's own host, which is only right when the dashboard and API share a host.
- `RUN_HORIZON_LISTENER` - (Optional) Set to `true` to run the Horizon listener inside the API process, so payment requests turn to paid and payments are recorded without a separate `npm run listener` worker. Off by default. Run the listener in one place only: one API instance with this flag, or a separate listener process, never both, or webhooks are delivered twice. Without `REDIS_URL` the listener still matches payments and sends live status updates to this process's clients, but skips webhook delivery and logs a warning.
- `SEP10_SIGNING_SECRET` - (Optional) Secret key (`S...`) of the dedicated SEP-10 server signing account. SEP-10 is **disabled** when this is unset: startup logs one info line, `stellar.toml` is unchanged and no auth endpoint is advertised. An invalid value fails startup fast; the value is never logged. Only the derived `SIGNING_KEY` is exposed.
- `SEP10_HOME_DOMAIN` - (Optional) Home domain whose `stellar.toml` is discovered by wallets. Defaults to `STELLAR_TAG_DOMAIN`; required (via either variable) when SEP-10 is enabled.
- `SEP10_WEB_AUTH_DOMAIN` - (Optional) Host that serves the auth endpoint. Defaults to `SEP10_HOME_DOMAIN`; the published `WEB_AUTH_ENDPOINT` is `https://<this domain>/auth`.
- `SEP10_CHALLENGE_TIMEOUT_SECONDS` - (Optional) Challenge lifetime in seconds. Defaults to `900` (15 minutes, as recommended by SEP-10).
- `SEP10_JWT_EXPIRY` - (Optional) Session JWT lifetime. Defaults to `24h`.
- `LOG_DIR` - (Optional) Directory for the rotating log files. Defaults to `stellar-payment-platform/logs`.
- `LOG_LEVEL` - (Optional) Minimum level to record. Defaults to `info` in production and `debug` elsewhere.
- `LOG_MAX_SIZE` - (Optional) Size at which the active log file rotates. Defaults to `20m`.
- `LOG_MAX_FILES` - (Optional) Retention for rotated files, as a count (`30`) or an age (`14d`). Defaults to `14d`.
- `MIGRATION_POLICY` - (Optional) What to do at startup when `prisma migrate status` reports the database is out of sync (pending migrations or drift). `warn` (default) logs a clear warning and continues; `strict` logs an error and exits non-zero before the server binds a port; `off` skips the check. Set to `strict` where you want deploys to fail fast on schema drift instead of failing on the first query.
- `REDIS_URL` / `REDIS_CLUSTER_NODES` - (Optional) Redis connection for rate limiting and the BullMQ queues. The dead letter queue is only enabled when one of these is set; see [Dead letter queue](api-reference.md#dead-letter-queue-admindlq).
- `MAX_RETRY_ATTEMPTS` - (Optional) Total delivery attempts before a webhook job is parked on the dead letter queue. Defaults to `5`.
- `RETRY_BACKOFF_MS` - (Optional) Base delay in milliseconds for the exponential backoff between retry attempts. Defaults to `1000`.
- `DLQ_ALERT_THRESHOLD` - (Optional) Log an error once the dead letter queue holds this many messages. Defaults to `10`.
- `DLQ_ALERT_COOLDOWN_MS` - (Optional) Minimum gap in milliseconds between two depth alerts, so a queue that stays deep does not log on every job. Defaults to `300000`.
- `DLQ_REPLAY_BATCH_LIMIT` - (Optional) Largest number of messages one `POST /admin/dlq/replay` call replays. Defaults to `100`.

For Render deployments, make sure the web service has `DATABASE_URL` set in its environment or linked from a Render PostgreSQL instance before startup. The container runs `prisma migrate deploy` during boot, so the variable must be available at runtime.

### SEP-10 discovery

With SEP-10 enabled, `GET /.well-known/stellar.toml` appends three fields to the existing federation entry so wallets can discover the auth endpoint:

```toml
FEDERATION_SERVER="https://example.com/federation"
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
SIGNING_KEY="G..."
WEB_AUTH_ENDPOINT="https://example.com/auth"
```

`SIGNING_KEY` is public; the matching secret never leaves the server configuration. SEP-10 allows the auth server to live on a different domain from the home domain, which is why `SEP10_WEB_AUTH_DOMAIN` is independent of `SEP10_HOME_DOMAIN`.

### SEP-10 challenge endpoint

With SEP-10 enabled, `GET /auth` issues a challenge transaction for a wallet:

```text
GET /auth?account=G...&memo=123&home_domain=example.com&client_domain=wallet.example.com
```

- `account` is required and may be a `G...` or muxed `M...` address.
- `memo` is optional, accepts only a uint64 ID value, and is rejected for muxed accounts.
- `home_domain` is optional; when supplied it must equal `SEP10_HOME_DOMAIN`.
- `client_domain` is accepted and ignored for now; client-domain verification is separate work.

Success returns `{ "transaction": "<base64 XDR>", "network_passphrase": "..." }`. The challenge hash is stored in Redis with a TTL equal to `SEP10_CHALLENGE_TIMEOUT_SECONDS` so it can be consumed only once.

`POST /auth` exchanges the signed challenge for a JWT. Both `application/json` (`{ "transaction": "..." }`) and `application/x-www-form-urlencoded` (`transaction=...`) bodies are accepted. The server verifies the challenge with the SDK, checks the client account's medium threshold on Horizon (or the master key when the account does not exist), consumes the stored hash, and returns `{ "token": "<jwt>" }`. The JWT includes `iss`, `sub`, `iat`, `exp`, `jti`, `home_domain` and, when present, `client_domain`; it is signed with the same RS256 key published at `/.well-known/jwks.json`.

When SEP-10 is disabled the endpoint returns `404`; if Redis or Horizon is unavailable it returns `503`. Validation errors use the SEP-10 `{ "error": "..." }` response shape.

## Logging

The server logs through a shared [Winston](https://github.com/winstonjs/winston) logger
(`stellar-payment-platform/src/logger.js`). Import it instead of calling `console` directly:

```js
const { logger } = require('./src/logger');

logger.info('Registered tag', { correlationId: req.correlationId, tag });
logger.error(err);
```

Log records are written as JSON to `stellar-payment-platform/logs/`:

- `application-YYYY-MM-DD.log` - everything at `LOG_LEVEL` and above.
- `error-YYYY-MM-DD.log` - errors only, so incidents are easy to find.

Both files rotate **daily and whenever they pass 20MB**, older files are gzipped, and
anything beyond the retention window is deleted, so logs cannot exhaust the disk. A
human-readable copy is also printed to the console (silenced when `NODE_ENV=test`, which
also disables file output so test runs leave no logs behind).


## Internal service-to-service mTLS

Service-to-service calls are encrypted and mutually authenticated: the API
requires a client certificate signed by an internal CA before a request is
routed, and a peer with no valid certificate never reaches a handler. An
internal CA issues, rotates and retires the certificates, including a
zero-downtime cutover to a new issuing CA. Off by default, so local development
and CI keep using plain HTTP.

```sh
MTLS_ENABLED=true docker compose --profile dev --profile mtls up --build
```

See [docs/mtls.md](mtls.md) for the PKI layout, rotation runbook and
configuration reference.

