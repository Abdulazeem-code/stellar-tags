jest.mock('dotenv', () => ({ config: jest.fn() }));

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));

jest.mock('pdfkit', () => jest.fn());

jest.mock('../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));

jest.mock('bad-words', () => {
  return jest.fn().mockImplementation(() => ({
    isProfane: jest.fn(() => false),
  }));
});

jest.mock('@prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  },
}));

jest.mock('../src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn(),
  isSingleSignerAccount: jest.fn().mockReturnValue(true),
}));

jest.mock('sqlite3', () => ({
  verbose: () => ({
    Database: jest.fn().mockImplementation((_path, cb) => {
      const db = {
        run: jest.fn(function (...args) {
          const fn = args.find((a) => typeof a === 'function');
          if (fn) fn.call({ lastID: 0, changes: 0 }, null);
        }),
        serialize: jest.fn((fn) => fn && fn()),
        close: jest.fn((cb) => cb && cb()),
      };
      if (cb) cb(null);
      return db;
    }),
  }),
}));

jest.mock('generic-pool', () => ({
  createPool: jest.fn(() => ({
    acquire: jest.fn().mockResolvedValue({
      run: jest.fn(function (...args) {
        const fn = args.find((a) => typeof a === 'function');
        if (fn) fn.call({ lastID: 1, changes: 1 }, null);
      }),
    }),
    release: jest.fn(),
    drain: jest.fn().mockResolvedValue(undefined),
    clear: jest.fn().mockResolvedValue(undefined),
  })),
}));

const mockInit = jest.fn();
const mockSetupExpressErrorHandler = jest.fn();
jest.mock('@sentry/node', () => ({
  init: (...args) => mockInit(...args),
  setupExpressErrorHandler: (...args) => mockSetupExpressErrorHandler(...args),
}));

describe('Sentry error reporting', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    mockInit.mockClear();
    mockSetupExpressErrorHandler.mockClear();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('initializes Sentry with the configured DSN when SENTRY_DSN is set', () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';

    require('../server');

    expect(mockInit).toHaveBeenCalledWith({
      dsn: 'https://examplePublicKey@o0.ingest.sentry.io/0',
    });
    expect(mockSetupExpressErrorHandler).toHaveBeenCalledTimes(1);
  });

  test('does not initialize Sentry when SENTRY_DSN is not set', () => {
    delete process.env.SENTRY_DSN;

    require('../server');

    expect(mockInit).not.toHaveBeenCalled();
    expect(mockSetupExpressErrorHandler).not.toHaveBeenCalled();
  });
});
