# Development guide

Running Stellar Tags locally: Docker Compose profiles, the database, seed data, tests and deployment.

> Back to the [README](../README.md).

## Docker Compose profiles

Every service in `docker-compose.yml` belongs to a profile, so
`docker compose up` on its own starts nothing and you always say which stack
you want:

| Command | Starts |
| --- | --- |
| `docker compose --profile dev up` | backend, postgres, redis |
| `docker compose --profile full up` | the same, plus the built frontend on :3000 |
| `docker compose --profile test up` | the API under test on :5001 and its own database |
| `docker compose --profile integration up` | a local standalone Stellar network on :8000 |

`dev` is the everyday one. `full` adds the frontend, which is the slowest
thing in the file to build and is not needed for backend work.

The dev and test stacks use separate databases on separate host ports (5432
and 5433), so you can run both at once:

```bash
docker compose --profile dev --profile test up -d
```

`COMPOSE_PROFILES` works too, if you would rather not repeat the flag:

```bash
export COMPOSE_PROFILES=dev
docker compose up -d
```

Stop a stack with the same profile you started it with, otherwise Compose
will not know which services it is meant to remove:

```bash
docker compose --profile dev down
```

The `integration` profile pulls `stellar/quickstart`, a multi-gigabyte image
used only by the Soroban contract tests in `tests/integration/`. It is kept
out of `test` so the API tests do not drag it in.

## Frontend dashboard

```bash
cd payment-dashboard
npm install
npm run dev
```

## Server

The server uses **PostgreSQL** as its database, accessed through the
[Prisma ORM](https://www.prisma.io/). You need a running Postgres instance
(local install, Docker, or a hosted provider) before starting the server.

```bash
cd stellar-payment-platform
npm install

# 1. Create your local env file and point DATABASE_URL at your Postgres DB
cp .env.example .env
#    then edit .env (see "Database setup" below)

# 2. Apply the schema to your database
npm run prisma:migrate

# 3. Fill the database with test data
npm run db:seed

# 4. Start the server
npm run dev
```

### Database setup

The connection string lives in `stellar-payment-platform/.env` as `DATABASE_URL`.
Copy `.env.example` to `.env` and set it to your own Postgres database:

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE?schema=public"
```

For a typical local install that becomes, for example:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/stellar_tags?schema=public"
```

The quickest way to get a local database is the dev profile, which also
brings up Redis:

```bash
docker compose --profile dev up -d postgres redis
```

Or a single container, if you want nothing else:

```bash
docker run --name stellar-postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=stellar_tags -p 5432:5432 -d postgres:16
```

Useful Prisma commands (run from `stellar-payment-platform/`):

| Command | Description |
| --- | --- |
| `npm run prisma:migrate` | Create/apply migrations against your dev database |
| `npm run prisma:deploy` | Apply existing migrations (CI / production) |
| `npm run prisma:generate` | Regenerate the Prisma Client after schema changes |
| `npm run prisma:studio` | Open Prisma Studio to browse the data |
| `npm run db:seed` | Populate the database with test data (see below) |

> `.env` is gitignored — never commit real credentials. Each contributor keeps
> their own local `DATABASE_URL`.

### Seed data

`npm run db:seed` populates an empty database with 50 users, 10 webhooks,
20 payment intents and 2 API keys, so the API has something to answer with
before you have registered anything by hand. `prisma migrate reset` runs it
automatically.

The data covers the cases the endpoints branch on: usernames with every memo
type, several addresses carrying aliases alongside their primary username,
flagged and soft-deleted users, webhooks that are healthy, never delivered,
and failing on both sides of the retry cutoff, and payment intents in each
status.

Re-running is safe. Every record is upserted on its natural key and the
identities are derived from a fixed seed, so a second run updates the same
rows rather than adding a set. Pass `--reset` to delete the seeded rows first:

```bash
npm run db:seed -- --reset
```

Both API keys are printed on each run, since only their hashes are stored.
Use the active one as `X-Api-Key`; the revoked one is there to exercise the
rejection path. The script refuses to run against a non-local `DATABASE_URL`
unless `SEED_ALLOW_REMOTE=1` is set.

## Render deployment

The repository includes a [render.yaml](../render.yaml) blueprint for the backend API and its PostgreSQL database. When you deploy from Render, import the blueprint or create the service from the repo so `DATABASE_URL` is injected automatically from the managed database.

If you deploy the backend without the blueprint, make sure the web service has a PostgreSQL `DATABASE_URL` secret configured before startup. The container runs Prisma migrations on boot, so the variable must already exist.


## Tests

```bash
# frontend (no unit tests yet: lint and build)
cd payment-dashboard
npm run lint && npm run build

# server
cd ../stellar-payment-platform
npm test

# contract
cd ../payment_router
cargo test
```

### Coverage

The server runs with coverage in CI via `npm run test:coverage` (same as
`npm test` plus `--coverage`). Minimum coverage thresholds are set in
`stellar-payment-platform/package.json` under `jest.coverageThreshold` — CI
fails the build when coverage drops below the floor, and the `lcov`/HTML report
is uploaded as a build artifact. Raise the thresholds as coverage improves so
the floor keeps pace with the suite.

