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

`SIGNING_KEY` is public; the matching secret never leaves the server configuration. SEP-10 allows the auth server to live on a different domain from the home domain, which is why `SEP10_WEB_AUTH_DOMAIN` is independent of `SEP10_HOME_DOMAIN`. This change only covers configuration and discovery; the `/auth` challenge/token endpoints are separate work.

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

