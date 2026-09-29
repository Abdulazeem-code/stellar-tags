// ---------------------------------------------------------------------------
// Tests for the startup migration check (src/migrate-check.js)
// ---------------------------------------------------------------------------
// Covers the CLI-ouput classification, the policy resolution, and the
// strict / permissive exit behaviour driven by MIGRATION_POLICY.
// ---------------------------------------------------------------------------

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('../src/logger', () => ({
  logger: mockLogger,
}));

const mockChild = { on: jest.fn() };
const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  execFile: (...args) => {
    mockExecFile(...args);
    return mockChild;
  },
}));

// Simulate the Prisma CLI completing by invoking the callback with the result.
const simulateSpawn = ({ code = 0, stdout = '', stderr = '' }) => {
  mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
    if (code !== 0) {
      cb(Object.assign(new Error(`exited with code ${code}`), { code }), stdout, stderr);
    } else {
      cb(null, stdout, stderr);
    }
  });
  mockChild.on.mockImplementation(() => {});
};

// Simulate the binary failing to spawn (ENOENT) -> runMigrateStatus rejects.
const simulateSpawnError = () => {
  mockExecFile.mockImplementation(() => {});
  mockChild.on.mockImplementation((event, handler) => {
    if (event === 'error') handler(new Error('spawn prisma ENOENT'));
  });
};

describe('currentPolicy', () => {
  let currentPolicy;
  let original;

  beforeAll(() => {
    ({ currentPolicy } = require('../src/migrate-check'));
    original = process.env.MIGRATION_POLICY;
  });

  afterEach(() => {
    delete process.env.MIGRATION_POLICY;
  });

  afterAll(() => {
    if (original === undefined) delete process.env.MIGRATION_POLICY;
    else process.env.MIGRATION_POLICY = original;
  });

  it('defaults to the permissive "warn" policy', () => {
    delete process.env.MIGRATION_POLICY;
    expect(currentPolicy()).toBe('warn');
  });

  it('returns "strict" when MIGRATION_POLICY=strict (case-insensitive)', () => {
    process.env.MIGRATION_POLICY = 'STRICT';
    expect(currentPolicy()).toBe('strict');
  });

  it('returns "off" when MIGRATION_POLICY=off', () => {
    process.env.MIGRATION_POLICY = 'off';
    expect(currentPolicy()).toBe('off');
  });

  it('falls back to "warn" for unknown values', () => {
    process.env.MIGRATION_POLICY = 'banana';
    expect(currentPolicy()).toBe('warn');
  });
});

describe('classifyStatus', () => {
  let classifyStatus;

  beforeAll(() => {
    ({ classifyStatus } = require('../src/migrate-check'));
  });

  it('classifies "Database schema is up to date!" as up-to-date', () => {
    const r = classifyStatus({ code: 0, output: 'Status: Database schema is up to date!' });
    expect(r.status).toBe('up-to-date');
    expect(r.pending).toBe(false);
    expect(r.drift).toBe(false);
  });

  it('classifies pending migrations ("not yet applied")', () => {
    const r = classifyStatus({
      code: 1,
      output: 'Following migration(s) have not yet been applied:\n- 20260727120000_add_deleted_at',
    });
    expect(r.status).toBe('pending');
    expect(r.pending).toBe(true);
    expect(r.drift).toBe(false);
  });

  it('classifies pending migrations ("not been applied")', () => {
    const r = classifyStatus({
      code: 1,
      output: '1 migration not been applied',
    });
    expect(r.status).toBe('pending');
    expect(r.pending).toBe(true);
  });

  it('classifies drift ("differ from the migrations")', () => {
    const r = classifyStatus({
      code: 1,
      output: 'following migration(s) differ from the migrations recorded in the database',
    });
    expect(r.status).toBe('drift');
    expect(r.drift).toBe(true);
  });

  it('classifies drift when a DB migration is missing from the local folder', () => {
    const r = classifyStatus({
      code: 1,
      output: 'The migration 2026_foo has already been applied but is missing from the local migrations folder',
    });
    expect(r.status).toBe('drift');
    expect(r.drift).toBe(true);
  });

  it('returns "unknown" for unrecognised output with a non-zero exit', () => {
    const r = classifyStatus({ code: 1, output: 'some unrelated error text' });
    expect(r.status).toBe('unknown');
    expect(r.pending).toBe(false);
    expect(r.drift).toBe(false);
  });

  it('treats unrecognised output with exit 0 as up-to-date', () => {
    const r = classifyStatus({ code: 0, output: 'prisma v6.19.3' });
    expect(r.status).toBe('up-to-date');
  });
});

describe('checkMigrations', () => {
  let checkMigrations;
  let originalUrl;
  let originalPolicy;

  beforeAll(() => {
    ({ checkMigrations } = require('../src/migrate-check'));
    originalUrl = process.env.DATABASE_URL;
    originalPolicy = process.env.MIGRATION_POLICY;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
  });

  afterEach(() => {
    delete process.env.MIGRATION_POLICY;
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  afterAll(() => {
    if (originalPolicy === undefined) delete process.env.MIGRATION_POLICY;
    else process.env.MIGRATION_POLICY = originalPolicy;
  });

  it('skips entirely when the policy is "off" (never spawns the CLI)', async () => {
    process.env.MIGRATION_POLICY = 'off';
    const r = await checkMigrations();
    expect(r.skipped).toBe(true);
    expect(r.status).toBe('skipped');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('skips (with a warning) when DATABASE_URL is not set', async () => {
    delete process.env.DATABASE_URL;
    const r = await checkMigrations();
    expect(r.skipped).toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('DATABASE_URL'));
  });

  it('returns pending when the CLI reports un-applied migrations', async () => {
    process.env.MIGRATION_POLICY = 'strict';
    simulateSpawn({
      code: 1,
      stdout: 'Following migration(s) have not yet been applied:\n- 20260626000000_add_memo_fields',
    });
    const r = await checkMigrations();
    expect(r.skipped).toBe(false);
    expect(r.status).toBe('pending');
    expect(r.pending).toBe(true);
    expect(r.policy).toBe('strict');
  });

  it('returns up-to-date for a healthy database', async () => {
    simulateSpawn({ code: 0, stdout: 'Status: Database schema is up to date!' });
    const r = await checkMigrations();
    expect(r.status).toBe('up-to-date');
    expect(r.pending).toBe(false);
  });

  it('skips gracefully when the Prisma CLI cannot spawn', async () => {
    simulateSpawnError();
    const r = await checkMigrations();
    expect(r.skipped).toBe(true);
    expect(r.status).toBe('error');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.any(Error),
      expect.stringContaining('Could not run'),
    );
  });

  it('never mistakes a spawn error (string error.code) for an up-to-date DB', async () => {
    // A missing binary surfaces an ENOENT with a *string* error.code; ensure
    // that is treated as a hard failure (skip) rather than resolved as a
    // silent, healthy run.
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      cb(Object.assign(new Error('spawn prisma ENOENT'), { code: 'ENOENT' }));
    });
    mockChild.on.mockImplementation(() => {});

    const r = await checkMigrations();
    expect(r.skipped).toBe(true);
    expect(r.status).toBe('error');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.any(Error),
      expect.stringContaining('Could not run'),
    );
  });
});

describe('enforceMigrationPolicy', () => {
  let enforceMigrationPolicy;

  beforeEach(() => {
    jest.clearAllMocks();
    ({ enforceMigrationPolicy } = require('../src/migrate-check'));
  });

  const base = { policy: 'warn', pending: false, drift: false, skipped: false, output: '' };

  it('exits in strict mode when migrations are pending', () => {
    const { shouldExit } = enforceMigrationPolicy({
      ...base,
      policy: 'strict',
      status: 'pending',
      pending: true,
    });
    expect(shouldExit).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('out of sync'));
  });

  it('exits in strict mode when drift is detected', () => {
    const { shouldExit } = enforceMigrationPolicy({
      ...base,
      policy: 'strict',
      status: 'drift',
      drift: true,
    });
    expect(shouldExit).toBe(true);
  });

  it('warns but keeps going in permissive mode when migrations are pending', () => {
    const { shouldExit } = enforceMigrationPolicy({
      ...base,
      policy: 'warn',
      status: 'pending',
      pending: true,
    });
    expect(shouldExit).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('out of sync'));
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('does not block when migrations are up to date, even in strict mode', () => {
    const { shouldExit } = enforceMigrationPolicy({ ...base, policy: 'strict', status: 'up-to-date' });
    expect(shouldExit).toBe(false);
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('up to date'));
  });

  it('never blocks a skipped check', () => {
    const { shouldExit } = enforceMigrationPolicy({ ...base, status: 'skipped', skipped: true });
    expect(shouldExit).toBe(false);
  });

  it('warns without blocking when the status is unknown', () => {
    const { shouldExit } = enforceMigrationPolicy({ ...base, status: 'unknown' });
    expect(shouldExit).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not determine'));
  });
});