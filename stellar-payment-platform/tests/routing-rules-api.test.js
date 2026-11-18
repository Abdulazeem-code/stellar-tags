'use strict';

// Authorized Protocol Quality Assurance & Routing Rules API Integration Test Suite

const express = require('express');
const request = require('supertest');

const mockRules = [];
let nextId = 1;

const mockPrisma = {
  routingRule: {
    create: jest.fn(async ({ data }) => {
      const created = {
        id: `rule-${nextId++}`,
        name: data.name,
        description: data.description,
        priority: data.priority,
        active: data.active !== undefined ? data.active : true,
        clientOrg: data.clientOrg || null,
        conditions: data.conditions,
        actions: data.actions,
        metadata: data.metadata || {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockRules.push(created);
      return created;
    }),
    findMany: jest.fn(async ({ where, orderBy }) => {
      let result = [...mockRules];
      if (where) {
        if (where.active !== undefined) {
          result = result.filter((r) => r.active === where.active);
        }
        if (where.OR) {
          result = result.filter((r) =>
            where.OR.some((clause) => {
              if (clause.clientOrg === null) return r.clientOrg === null;
              return r.clientOrg === clause.clientOrg;
            }),
          );
        }
      }
      result.sort((a, b) => b.priority - a.priority);
      return result;
    }),
    findUnique: jest.fn(async ({ where }) => {
      return mockRules.find((r) => r.id === where.id) || null;
    }),
    update: jest.fn(async ({ where, data }) => {
      const idx = mockRules.findIndex((r) => r.id === where.id);
      if (idx === -1) throw new Error('Not found');
      mockRules[idx] = { ...mockRules[idx], ...data, updatedAt: new Date() };
      return mockRules[idx];
    }),
    delete: jest.fn(async ({ where }) => {
      const idx = mockRules.findIndex((r) => r.id === where.id);
      if (idx === -1) throw new Error('Not found');
      const removed = mockRules.splice(idx, 1)[0];
      return removed;
    }),
  },
  paymentIntent: {
    create: jest.fn(async ({ data }) => ({
      id: `intent-${nextId++}`,
      externalId: data.externalId,
      from: data.from,
      to: data.to,
      amount: data.amount,
      asset: data.asset,
      memo: data.memo,
      memoType: data.memoType,
      metadata: data.metadata,
      status: 'pending',
    })),
  },
  $transaction: jest.fn(async (ops) => Promise.all(ops)),
};

jest.mock('../prismaClient', () => ({
  prisma: mockPrisma,
}));

jest.mock('@stellar/stellar-sdk', () => ({
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));

const routingRuleRoutes = require('../src/routes/v1/routingRuleRoutes');
const paymentRoutes = require('../src/routes/v1/paymentRoutes');

describe('Payment Routing Rules API & Dynamic Route Switching', () => {
  let app;

  beforeEach(() => {
    mockRules.length = 0;
    nextId = 1;
    jest.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use('/api/v1', routingRuleRoutes());
    app.use('/api/v1', paymentRoutes(null));
  });

  describe('Rule Management Endpoints (CRUD)', () => {
    test('POST /api/v1/routing/rules creates a dynamic routing rule in database', async () => {
      const payload = {
        name: 'Enterprise High-Volume Settlement',
        description: 'Directs payments >= 10,000 USDC to VIP liquidity gateway',
        priority: 100,
        clientOrg: 'acme-corp',
        conditions: {
          and: [
            { field: 'amount', operator: '>=', value: 10000 },
            { field: 'asset', operator: '==', value: 'USDC' },
          ],
        },
        actions: {
          route: 'vip-liquidity-gateway',
          targetAddress: 'GVIP_SETTLEMENT_VAULT_ADDRESS',
          priorityTier: 'instant',
          feeOverride: 0.0001,
          memoPrefix: 'VIP-',
        },
      };

      const res = await request(app)
        .post('/api/v1/routing/rules')
        .set('Idempotency-Key', 'test-key-1')
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.name).toBe('Enterprise High-Volume Settlement');
      expect(res.body.data.priority).toBe(100);
      expect(mockPrisma.routingRule.create).toHaveBeenCalledTimes(1);
    });

    test('GET /api/v1/routing/rules lists active rules', async () => {
      await request(app).post('/api/v1/routing/rules')
        .set('Idempotency-Key', 'test-key-2').send({
        name: 'Rule Alpha',
        priority: 50,
        conditions: { field: 'asset', operator: '==', value: 'EURC' },
        actions: { route: 'eur-anchor' },
      });

      const res = await request(app).get('/api/v1/routing/rules');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.count).toBe(1);
      expect(res.body.data[0].name).toBe('Rule Alpha');
    });

    test('PATCH /api/v1/routing/rules/:id updates priority and active state', async () => {
      const created = await request(app).post('/api/v1/routing/rules')
        .set('Idempotency-Key', 'test-key-3').send({
        name: 'Updatable Rule',
        priority: 10,
        conditions: { field: 'amount', operator: '>', value: 50 },
        actions: { route: 'fast-route' },
      });

      const ruleId = created.body.data.id;
      const updateRes = await request(app)
        .patch(`/api/v1/routing/rules/${ruleId}`)
        .set('Idempotency-Key', 'test-key-10')
        .send({ priority: 999, active: false });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.priority).toBe(999);
      expect(updateRes.body.data.active).toBe(false);
    });

    test('DELETE /api/v1/routing/rules/:id removes rule', async () => {
      const created = await request(app).post('/api/v1/routing/rules')
        .set('Idempotency-Key', 'test-key-4').send({
        name: 'Rule to Delete',
        conditions: { field: 'amount', operator: '>', value: 1 },
        actions: { route: 'discard' },
      });

      const ruleId = created.body.data.id;
      const delRes = await request(app).delete(`/api/v1/routing/rules/${ruleId}`)
        .set('Idempotency-Key', 'test-key-11');
      expect(delRes.status).toBe(200);
      expect(delRes.body.ok).toBe(true);
      expect(mockRules.length).toBe(0);
    });
  });

  describe('POST /api/v1/routing/evaluate (Simulation / Sandboxed Dry-Run)', () => {
    test('dry-runs payment context against inline rule without DB dependency', async () => {
      const payload = {
        payment: {
          from: 'GCLIENT',
          to: 'GORIGINAL_RECIPIENT',
          amount: '50000',
          asset: 'USDC',
          memo: 'INVOICE-888',
        },
        rules: [
          {
            id: 'inline-1',
            name: 'Whale Route',
            priority: 10,
            active: true,
            conditions: { field: 'amount', operator: '>=', value: 25000 },
            actions: {
              route: 'otc-institutional-pool',
              targetAddress: 'GOTC_SETTLEMENT_VAULT',
              feeOverride: 0,
            },
          },
        ],
      };

      const res = await request(app)
        .post('/api/v1/routing/evaluate')
        .set('Idempotency-Key', 'test-key-5')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.matched).toBe(true);
      expect(res.body.appliedRule.name).toBe('Whale Route');
      expect(res.body.routingResult.to).toBe('GOTC_SETTLEMENT_VAULT');
      expect(res.body.routingResult.route).toBe('otc-institutional-pool');
      expect(res.body.routingResult.fee).toBe(0);
    });
  });

  describe('POST /api/v1/payments/route (Live Endpoint)', () => {
    test('evaluates database rules and returns dynamic routing decision', async () => {
      await request(app).post('/api/v1/routing/rules')
        .set('Idempotency-Key', 'test-key-6').send({
        name: 'Micropayments Route',
        priority: 75,
        conditions: {
          and: [
            { field: 'amount', operator: '<', value: 5 },
            { field: 'asset', operator: '==', value: 'XLM' },
          ],
        },
        actions: {
          route: 'state-channel-micro',
          priorityTier: 'batch',
          targetAddress: 'GMICROPAY_AGGREGATOR',
        },
      });

      const res = await request(app)
        .post('/api/v1/payments/route')
        .set('Idempotency-Key', 'test-key-7')
        .send({
          from: 'GSENDER',
          to: 'GRECIPIENT',
          amount: '1.5',
          asset: 'XLM',
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.route).toBe('state-channel-micro');
      expect(res.body.targetAddress).toBe('GMICROPAY_AGGREGATOR');
      expect(res.body.priorityTier).toBe('batch');
    });
  });

  describe('POST /api/v1/payments/bulk with Dynamic Routing Integration', () => {
    test('dynamically overrides payment target address and enriches metadata based on DB rules', async () => {
      // 1. Seed a high-priority enterprise rule
      await request(app).post('/api/v1/routing/rules')
        .set('Idempotency-Key', 'test-key-8').send({
        name: 'Enterprise VIP Routing',
        priority: 200,
        conditions: {
          field: 'amount',
          operator: '>=',
          value: 10000,
        },
        actions: {
          route: 'enterprise-liquidity-pool',
          targetAddress: 'GENTERPRISE_ESCROW_TARGET',
          memoPrefix: 'VIP-',
          priorityTier: 'instant',
        },
      });

      // 2. Submit bulk payment intents
      const intents = [
        {
          external_id: 'tx-high-value',
          from: 'GSOURCE11111111111111111111111111111111111111111111111111111111',
          to: 'GORIGINAL_RECIPIENT1111111111111111111111111111111111111111111',
          amount: '15000.00',
          asset: 'USDC',
          memo: 'INV-100',
        },
        {
          external_id: 'tx-standard-value',
          from: 'GSOURCE11111111111111111111111111111111111111111111111111111111',
          to: 'GORIGINAL_RECIPIENT1111111111111111111111111111111111111111111',
          amount: '20.00',
          asset: 'USDC',
          memo: 'INV-101',
        },
      ];

      const res = await request(app)
        .post('/api/v1/payments/bulk')
        .set('Idempotency-Key', 'test-key-9')
        .send(intents);

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.count).toBe(2);

      // Verify Prisma creation calls:
      const calls = mockPrisma.paymentIntent.create.mock.calls;
      expect(calls.length).toBe(2);

      // Intent 1 (High Value) had targetAddress dynamically altered and memo prefixed
      const highValArg = calls[0][0].data;
      expect(highValArg.to).toBe('GENTERPRISE_ESCROW_TARGET');
      expect(highValArg.memo).toBe('VIP-INV-100');
      expect(highValArg.metadata.routingEngine.applied).toBe(true);
      expect(highValArg.metadata.routingEngine.route).toBe('enterprise-liquidity-pool');
      expect(highValArg.metadata.routingEngine.priorityTier).toBe('instant');

      // Intent 2 (Standard Value) kept original recipient address
      const standardValArg = calls[1][0].data;
      expect(standardValArg.to).toBe('GORIGINAL_RECIPIENT1111111111111111111111111111111111111111111');
      expect(standardValArg.memo).toBe('INV-101');
    });
  });
});
