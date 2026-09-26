# Stellar Tags — Dockerfile-backend Multi-Stage Refactor: Findings & Fix Report

Repo: `madisonsc52-del/stellar-tags` · Fix validated on 2026-08-24 · Files changed: `Dockerfile-backend`, `.dockerignore`

---

## 1. The real problem (verified in the codebase)

`Dockerfile-backend` (used by `render.yaml` to deploy the `stellar-tags-api` service) looked
multi-stage but wasn't in any effective way:

```dockerfile
COPY --from=builder /app /app        # copies ALL 436 MB of node_modules (dev deps included)
RUN npm prune --omit=dev             # deletes devDeps in a NEW layer — the fat layer stays forever
```

Docker image size is the **sum of all layers**. Pruning *after* a wholesale copy keeps every
deleted byte in the earlier layer — the classic copy-then-prune anti-pattern. The final image
shipped jest/supertest/tsx, test files, test logs, and a `curl` install that exists only for the
healthcheck.

## 2. Measured breakdown (real `npm ci` runs, sandbox-verified)

| Component of the OLD image | Size |
|---|---|
| `node:22-alpine` base | ~158 MB |
| `apk add curl` (healthcheck only) | ~5 MB |
| `/app` copied from builder (full node_modules 436 MB + source) | ~437 MB |
| **OLD image (unpacked estimate)** | **~600 MB** |

Where the 436 MB of node_modules lives:

| Piece | Size | Needed at runtime? |
|---|---|---|
| devDependencies (jest, supertest, tsx) | 46 MB | ❌ |
| `@prisma/client/runtime` WASM engine blobs (driver-adapter mode only) | 54 MB | ❌ (library engine used) |
| `.prisma/client/query_engine_bg.wasm` | 3 MB | ❌ |
| Query engine copy inside the `prisma` CLI package | 17 MB | ❌ (CLI uses schema engine) |
| Rest of production deps (Prisma client+CLI+engines, Stellar SDK, Sentry+OTel, redis, pdfkit…) | ~316 MB | ✅ |

## 3. The fix

1. **True multi-stage build** — devDependencies and generate-only engine binaries are pruned
   *inside the builder*; the runtime stage `COPY --from=builder` only the slimmed production
   `node_modules` and the runtime source files (tests, docs, logs never enter the image).
2. **`node:lts-alpine`** base for both stages (was `node:22-alpine`).
3. **Engine de-duplication** — removes the unused WASM blobs and the CLI's internal query-engine
   copy. Critically, `@prisma/engines/libquery_engine-*` is **kept**: testing proved
   `prisma migrate deploy` (run by `startup.sh` at every container start) silently re-downloads
   it if missing, which would have slowed every deploy and required network egress.
4. **No more `curl`** — the healthcheck uses busybox `wget` (built into alpine), matching the
   pattern already used in `docker-compose.test.yml`.
5. **Non-root runtime** — app runs as the unprivileged `node` user (smaller attack surface,
   explicitly called out in the issue's Impact section).
6. **BuildKit cache mounts** (`# syntax=docker/dockerfile:1`) — the npm download cache
   accelerates rebuilds without ever baking into a layer.
7. **`.dockerignore` hardened** — backend tests, test logs/output, `data/*.db` SQLite files
   (yes, `registrations.db-shm/-wal` were being shipped into images), and stray root files are
   excluded from the build context; `**/.env` added so secrets can never leak into a layer.

## 4. Result

| | Content (`/app`) | Whole image (est., unpacked) |
|---|---|---|
| Before | 437 MB | ~600 MB |
| After | **318 MB (−27%)** | **~477 MB (−21%)** |

Plus: faster builds (shared npm cache, leaner context), no dev tooling or test data in
production, non-root process, and no `curl` attack surface.

### Honest note on the ">50%" acceptance criterion
Removing **only** devDependencies can never reach −50% here: devDeps are just 46 MB of a 436 MB
tree. The image is dominated by *production* dependencies the API genuinely requires
(Prisma client + CLI + engines ≈ 150 MB, Stellar SDK 32 MB, Sentry + OTel ≈ 51 MB, …).
Reaching −50% would require product-level changes (e.g. running migrations outside the
container so the Prisma CLI/effect tree can be dropped, or dropping Sentry/OTel) — out of scope
for a Dockerfile refactor and not something a maintainer should merge blind. The achievable,
safe maximum via this refactor is delivered instead: **every byte that can be removed without
changing runtime behavior has been removed.** Optional follow-up: move `@faker-js/faker`
(seed-script-only) from `dependencies` to `devDependencies` for another −4 MB.

## 5. Validation performed (all green)

| Check | Result |
|---|---|
| Full jest suite (24 suites / **352 tests**) with the same strips applied | ✅ 352/352 pass |
| Clean-room simulation of both stages (install → generate → prune → strip) | ✅ 436 → 318 MB, Prisma CLI + generated client intact |
| `startup.sh` end-to-end against real PostgreSQL 17 | ✅ "All migrations have been successfully applied" |
| Server boot on the exact final-image layout | ✅ up in 3–6 s |
| `GET /health` + `wget` healthcheck syntax | ✅ `{"status":"ok","database":"ok"}` |
| `POST /register` → row persisted in PostgreSQL | ✅ (verified via `psql`, 3 registrations) |
| Repeat start (redeploy scenario) — no engine re-downloads | ✅ node_modules byte-stable at 318 MB |
| `hadolint Dockerfile-backend` | ✅ 0 warnings |
| Root-context `.dockerignore` changes vs. main `Dockerfile`, `Dockerfile.test`, CI workflows | ✅ no references broken (`Dockerfile-backend` referenced only by `render.yaml`) |

Confidence the fix is correct and conflict-free: **~97%** (validated down to real DB writes;
the only untested delta is a literal `docker build` on Render's infra, which this sandbox
cannot run).

## 6. Files modified

- `Dockerfile-backend` — rewritten as a true two-stage build (see patch)
- `.dockerignore` — test artifacts, data DBs, stray root files, `**/.env`

Patch: `stellar-tags-multistage-fix.patch` (apply with `git apply`).
