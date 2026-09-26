"use strict";

const express = require("express");
const request = require("supertest");
const {
  createGraphQLContext,
  createGraphQLMiddleware,
  createGraphQLServer,
} = require("../src/graphql");

const userRows = [
  {
    username: "alice*stellar.test",
    address: "GALICE",
    isPrimary: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  },
  {
    username: "bob*stellar.test",
    address: "GBOB",
    isPrimary: true,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
  },
];

const paymentRows = [
  {
    id: "payment-1",
    createdAt: new Date("2026-01-03T00:00:00.000Z"),
    fromAddress: "GALICE",
    toAddress: "GBOB",
    amount: 25,
    fee: 0.25,
    assetCode: "USDC",
    transactionHash: "tx-1",
    status: "completed",
  },
  {
    id: "payment-2",
    createdAt: new Date("2026-01-04T00:00:00.000Z"),
    fromAddress: "GBOB",
    toAddress: "GALICE",
    amount: 10,
    fee: 0.1,
    assetCode: "XLM",
    transactionHash: "tx-2",
    status: "completed",
  },
];

const createPrismaMock = () => ({
  user: {
    findUnique: jest.fn(({ where }) =>
      Promise.resolve(userRows.find((user) => user.username === where.username) || null),
    ),
    findMany: jest.fn(({ take } = {}) => Promise.resolve(userRows.slice(0, take))),
  },
  payment: {
    findUnique: jest.fn(({ where }) =>
      Promise.resolve(paymentRows.find((payment) => payment.id === where.id) || null),
    ),
    findMany: jest.fn().mockResolvedValue(paymentRows),
  },
});

const execute = async (server, prisma, query, variables) => {
  const response = await server.executeOperation(
    { query, variables },
    { contextValue: createGraphQLContext(prisma) },
  );
  expect(response.body.kind).toBe("single");
  return response.body.singleResult;
};

describe("federated GraphQL API", () => {
  let server;

  beforeEach(async () => {
    server = createGraphQLServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("publishes federation entity directives", async () => {
    const result = await execute(
      server,
      createPrismaMock(),
      `query SubgraphSchema { _service { sdl } }`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data._service.sdl).toContain('type User @key(fields: "username")');
    expect(result.data._service.sdl).toContain('type Payment @key(fields: "id")');
    expect(result.data._service.sdl).toContain('type Token @key(fields: "code")');
  });

  it("exposes nested users, payments, and tokens", async () => {
    const prisma = createPrismaMock();
    const result = await execute(
      server,
      prisma,
      `query UsersWithPayments {
        users {
          username
          payments {
            id
            amount
            token { code }
          }
        }
      }`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.users).toEqual([
      {
        username: "alice*stellar.test",
        payments: [
          { id: "payment-1", amount: 25, token: { code: "USDC" } },
        ],
      },
      {
        username: "bob*stellar.test",
        payments: [
          { id: "payment-2", amount: 10, token: { code: "XLM" } },
        ],
      },
    ]);
  });

  it("batches nested payment lookups with DataLoader", async () => {
    const prisma = createPrismaMock();
    await execute(
      server,
      prisma,
      `query BatchedUsers { users { username payments { id } } }`,
    );

    expect(prisma.payment.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.payment.findMany).toHaveBeenCalledWith({
      where: { fromAddress: { in: ["GALICE", "GBOB"] } },
      orderBy: { createdAt: "desc" },
    });
  });

  it("serves GraphQL requests through the Express middleware", async () => {
    const app = express();
    const handler = createGraphQLMiddleware({ prismaClient: createPrismaMock() });
    app.use(express.json());
    app.use("/graphql", handler);

    const response = await request(app)
      .post("/graphql")
      .send({ query: "query { users(limit: 1) { username } }" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        users: [
          { username: "alice*stellar.test" },
        ],
      },
    });
    await handler.apolloServer.stop();
  });
});
