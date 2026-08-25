"use strict";

jest.mock("dotenv", () => ({ config: jest.fn() }));

jest.mock("@stellar/stellar-sdk", () => ({
  Horizon: { Server: jest.fn() },
  StrKey: {
    isValidEd25519PublicKey: jest.fn(
      (key) =>
        typeof key === "string" && key.startsWith("G") && key.length === 56,
    ),
  },
}));

jest.mock("pdfkit", () => jest.fn());
jest.mock("./src/cleanup-cron", () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock("./src/soft-delete-purge-cron", () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    on: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("./prismaClient", () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  },
  isPrismaConnectionError: jest.fn().mockReturnValue(false),
}));

jest.mock("./src/multisigner-verifier", () => ({
  verifyMultiSignerThreshold: jest.fn().mockResolvedValue({
    success: true,
    accountId: "GDUMMYACCOUNTIDIIIIIIIIIIIIIIIIIIIIIIIIIIIIII",
    operationType: "management",
    requiredThreshold: 1,
    totalWeight: 1,
    signatureCount: 1,
    uniqueSignerCount: 1,
    signatures: [{ publicKey: "GDUMMY", weight: 1, isValid: true }],
    thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 3 },
    signerCount: 1,
    errorMessage: null,
  }),
  isSingleSignerAccount: jest.fn().mockReturnValue(true),
}));

const request = require("supertest");

describe("POST /register - integration test coverage", () => {
  let app;
  let prisma;

  const VALID_ADDRESS =
    "GDZST3XVCDTUJ76ZAV2HA72KYQM3DGLLFVDNNZ6XTQCR3BQFGMQ25E4Z";

  beforeEach(() => {
    jest.resetModules();
    ({ app } = require("./server"));
    ({ prisma } = require("./prismaClient"));

    prisma.user.findFirst.mockReset();
    prisma.user.create.mockReset();
  });

  test("registers successfully with valid payload", async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      username: "alice*localhost",
      address: VALID_ADDRESS,
    });

    const response = await request(app)
      .post("/register")
      .send({ username: "alice", address: VALID_ADDRESS });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      ok: true,
      username: "alice*localhost",
      address: VALID_ADDRESS,
    });
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { address: VALID_ADDRESS, deletedAt: null },
    });
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        username: "alice*localhost",
        address: VALID_ADDRESS,
      },
    });
  });

  test("returns 409 when address already exists", async () => {
    prisma.user.findFirst.mockResolvedValue({
      username: "existing*localhost",
      address: VALID_ADDRESS,
    });

    const response = await request(app)
      .post("/register")
      .send({ username: "bob", address: VALID_ADDRESS });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'CONFLICT', message: 'Address already registered' },
    });
  });

  test("returns 422 when required payload fields are missing", async () => {
    const response = await request(app)
      .post("/register")
      .send({ username: "charlie" });

    expect(response.status).toBe(422);
    expect(response.body).toHaveProperty('error.details');
    expect(response.body.error.details.some(e => e.field === 'address')).toBe(true);
  });
});
