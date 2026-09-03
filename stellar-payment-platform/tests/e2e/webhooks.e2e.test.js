'use strict';

jest.mock('../../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
  Keypair: {
    fromPublicKey: jest.fn(() => ({
      verify: jest.fn(() => true),
    })),
  },
}));
jest.mock('pdfkit', () => jest.fn());

const mockDbUsers = new Map();
const mockDbWebhooks = new Map();

jest.mock('../../prismaClient', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }) => {
        let row = null;
        if (where.username) {
          for (const entry of mockDbUsers.values()) {
            if (entry.username === where.username) {
              row = entry;
              break;
            }
          }
        }
        return row ? { ...row } : null;
      }),
    },
    webhook: {
      create: jest.fn(async ({ data }) => {
        const row = {
          ...data,
          createdAt: data.createdAt || new Date(),
        };
        mockDbWebhooks.set(data.id, row);
        return row;
      }),
      findMany: jest.fn(async ({ where, orderBy }) => {
        let results = Array.from(mockDbWebhooks.values());
        if (where && where.username) {
          results = results.filter(w => w.username === where.username);
        }
        return results;
      }),
      deleteMany: jest.fn(async ({ where }) => {
        let count = 0;
        for (const [id, entry] of mockDbWebhooks.entries()) {
          if (entry.id === where.id && entry.username === where.username) {
            mockDbWebhooks.delete(id);
            count++;
          }
        }
        return { count };
      }),
    },
    activityLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn(async (ops) => Promise.all(ops)),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  };
  return { prisma, isPrismaConnectionError: () => false };
});

jest.mock('../../src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn().mockResolvedValue({ success: true }),
  isSingleSignerAccount: jest.fn().mockReturnValue(true),
}));

const request = require('supertest');
const { app } = require('../../server');

describe('E2E: Webhooks Flow', () => {
  beforeEach(() => {
    mockDbUsers.clear();
    mockDbWebhooks.clear();
    
    // Set up a user for the webhooks
    mockDbUsers.set('GABC123XYZ456789WEBHOOK', {
      username: 'webhook_test_user*localhost',
      address: 'GABC123XYZ456789WEBHOOK',
    });
  });

  it('should create, list, and delete a webhook', async () => {
    // We mock verifyFreighterSignedMessage implicitly by mocking StrKey and Keypair in stellar-sdk.

    // 1. Create Webhook
    let res = await request(app)
      .post('/api/v1/webhooks')
      .send({
        username: 'webhook_test_user',
        signature: 'mock_signature',
        url: 'https://example.com/webhook',
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.webhook.url).toBe('https://example.com/webhook');
    expect(res.body.webhook.id).toBeDefined();

    const webhookId = res.body.webhook.id;

    // 2. List Webhooks
    res = await request(app)
      .get('/api/v1/webhooks')
      .send({
        username: 'webhook_test_user',
        signature: 'mock_signature',
      });

    expect(res.status).toBe(200);
    expect(res.body.webhooks.length).toBe(1);
    expect(res.body.webhooks[0].id).toBe(webhookId);

    // 3. Delete Webhook
    res = await request(app)
      .delete(`/api/v1/webhooks/${webhookId}`)
      .send({
        username: 'webhook_test_user',
        signature: 'mock_signature',
      });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    
    // 4. Verify Delete
    res = await request(app)
      .get('/api/v1/webhooks')
      .send({
        username: 'webhook_test_user',
        signature: 'mock_signature',
      });

    expect(res.status).toBe(200);
    expect(res.body.webhooks.length).toBe(0);
  });
});
