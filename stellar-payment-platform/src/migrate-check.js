'use strict';

// ---------------------------------------------------------------------------
// Startup migration check
// ---------------------------------------------------------------------------
// Runs `prisma migrate status` at server startup so schema drift between the
// code and the database is caught immediately, instead of surfacing later as
// a cryptic error on the first query.
//
// Behaviour is controlled by the MIGRATION_POLICY environment variable:
//   - "strict" -> exit the process (non-zero) before the server binds a port
//                 whenever migrations are pending or drift is detected, so an
//                 orchestrator can restart a correctly-migrated instance.
//   - "off"    -> skip the check entirely.
//   - anything else ("warn", the default) -> log a clear warning but continue
//                 booting so local dev / mock databases keep working.
//
// The standalone CLI (`prisma migrate status`) is invoked on purpose: it is
// the same source of truth the `prisma migrate deploy` step in startup.sh uses
// and needs no extra runtime dependencies beyond the already-shipped CLI.
// ---------------------------------------------------------------------------

const { execFile } = require('child_process');
const path = require('path');

const { logger } = require('./logger');

const PROJECT_ROOT = path.join(__dirname, '..');
const PRISMA_BIN = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'prisma');

/** How long to wait for `prisma migrate status` before giving up. */
const MIGRATION_CHECK_TIMEOUT_MS =
  parseInt(process.env.MIGRATION_CHECK_TIMEOUT_MS, 10) || 30_000;

const POLICIES = new Set(['strict', 'warn', 'off']);

/**
 * Resolves the active migration policy from MIGRATION_POLICY, defaulting to
 * the permissive "warn" mode.
 * @returns {'strict' | 'warn' | 'off'}
 */
function currentPolicy() {
  const raw = (process.env.MIGRATION_POLICY || 'warn').trim().toLowerCase();
  return POLICIES.has(raw) ? raw : 'warn';
}

/**
 * Runs the Prisma CLI directly against the configured database.
 * @returns {Promise<{ code: number, output: string }>}
 */
function runMigrateStatus() {
  return new Promise((resolve, reject) => {
    const child = execFile(
      PRISMA_BIN,
      ['migrate', 'status'],
      {
        cwd: PROJECT_ROOT,
        timeout: MIGRATION_CHECK_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        // Prisma writes diagnostics to both streams, so merge them.
        const output = `${stdout || ''}${stderr || ''}`;
        if (!error) {
          resolve({ code: 0, output });
          return;
        }
        if (typeof error.code === 'number') {
          // The CLI ran and exited non-zero (e.g. pending migrations / drift).
          // That is exactly the "out of sync" signal we want to inspect, not a
          // hard failure, so we capture it instead of rejecting.
          resolve({ code: error.code, output });
          return;
        }
        // Spawn-level failure (ENOENT, EACCES, timeout...). error.code is a
        // string here (e.g. 'ENOENT'), NOT a child exit code — treat it as a
        // hard failure so checkMigrations skips instead of guessing.
        reject(error);
      },
    );
    // Binary-level failure only (ENOENT, EACCES, spawn error). Kept as a guard
    // in case execFile reports the failure via the child 'error' event rather
    // than the completion callback.
    child.on('error', reject);
  });
}

/**
 * Classifies the raw `prisma migrate status` output into a machine-readable
 * result. Matching is deliberately lenient because wording differs across
 * Prisma CLI versions.
 * @param {{ code: number, output: string }} raw
 * @returns {{ status: string, pending: boolean, drift: boolean, output: string }}
 */
function classifyStatus({ code, output }) {
  const text = (output || '').toLowerCase();
  const has = (...needles) => needles.some((needle) => text.includes(needle));

  const result = (status, pending, drift) => ({
    status,
    pending,
    drift,
    output,
  });

  if (has('up to date')) {
    return result('up-to-date', false, false);
  }
  // New migration(s) recorded in the schema but not yet applied to the DB.
  // Match flexibly because wording varies across versions, e.g.
  // "not yet been applied", "have not yet been applied", "not been applied".
  if (/\bnot (?:yet )?been applied\b/.test(text) || has('not applied')) {
    return result('pending', true, false);
  }
  // The DB has been changed in a way the local migrations don't record
  // (drift), or the DB has migrations not present in the local folder.
  if (
    has(
      'differ from the migrations',
      'drift',
      'already been applied',
      'missing from the local migrations folder',
    )
  ) {
    return result('drift', false, true);
  }
  // Nothing recognisable matched. Never pretend a non-zero CLI run is healthy:
  // surface it so drift is never silently hidden behind an unknown state.
  if (code !== 0) {
    return result('unknown', false, false);
  }
  return result('up-to-date', false, false);
}

/**
 * Runs the migration status check according to the active policy.
 *
 * @returns {Promise<{
 *   policy: 'strict'|'warn'|'off',
 *   status: string,
 *   pending: boolean,
 *   drift: boolean,
 *   skipped: boolean,
 *   output: string,
 * }>}
 */
async function checkMigrations() {
  const policy = currentPolicy();

  if (policy === 'off') {
    return { policy, status: 'skipped', pending: false, drift: false, skipped: true, output: '' };
  }

  if (!process.env.DATABASE_URL) {
    // Nothing to compare against; don't block local/dev/mock startup but do
    // say so, since it often indicates a misconfigured environment.
    logger.warn(
      '[migrate-check] DATABASE_URL is not set — skipping migration status check'
    );
    return { policy, status: 'skipped', pending: false, drift: false, skipped: true, output: '' };
  }

  let raw;
  try {
    raw = await runMigrateStatus();
  } catch (err) {
    // The CLI itself failed to spawn (missing binary, EACCES...). Do not block
    // startup but surface it so operators can investigate.
    logger.warn(err, '[migrate-check] Could not run "prisma migrate status" — skipping check');
    return { policy, status: 'error', pending: false, drift: false, skipped: true, output: err.message };
  }

  return { policy, ...classifyStatus(raw), skipped: false };
}

/**
 * Logs the result of the check and decides whether startup should abort.
 *
 * @param {ReturnType<typeof checkMigrations> extends Promise<infer T> ? T : never} result
 * @returns {{ shouldExit: boolean }}
 */
function enforceMigrationPolicy(result) {
  const { policy, status, pending, skipped, output } = result;

  if (skipped) {
    return { shouldExit: false };
  }

  const trimmed = (output || '').trim();

  if (status === 'up-to-date') {
    logger.info('[migrate-check] Prisma migrations are up to date.');
    return { shouldExit: false };
  }

  if (status === 'pending' || status === 'drift') {
    const reason = pending
      ? 'there are pending migrations that have not been applied'
      : 'the database schema has drifted from the local migrations';
    const message = [
      '[migrate-check] Database schema is out of sync with Prisma migrations.',
      `Cause: ${reason}.`,
      '',
      'Queries are likely to fail with cryptic Prisma errors (P2010 / P2021 / no such column).',
      'Run "npx prisma migrate deploy" (production/CI) or "npx prisma migrate dev" (development)',
      'to bring the database up to date, then restart the server.',
      '',
      'Raw "prisma migrate status" output:',
      trimmed || '(no output)',
    ].join('\n');

    if (policy === 'strict') {
      logger.error(message);
      return { shouldExit: true };
    }
    logger.warn(message);
    return { shouldExit: false };
  }

  // 'unknown' / 'error' — log the raw output as a warning but keep booting so
  // an unexpected CLI response never takes a healthy environment down.
  logger.warn(
    `[migrate-check] Could not determine migration status (${status}). ` +
      `Raw output:\n${trimmed || '(no output)'}`
  );
  return { shouldExit: false };
}

module.exports = {
  checkMigrations,
  enforceMigrationPolicy,
  currentPolicy,
  classifyStatus,
  runMigrateStatus,
  PRISMA_BIN,
};