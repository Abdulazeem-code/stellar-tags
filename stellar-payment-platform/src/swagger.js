'use strict';

const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Stellar Tags API',
      version: '1.0.0',
      description:
        'REST API for the Stellar Tags payment platform. Provides username registration and federation lookups that map human-readable tags to Stellar addresses.',
      contact: {
        name: 'Stellar Tags',
        url: 'https://stellar-tags.vercel.app',
      },
    },
    servers: [
      {
        url: 'http://localhost:{port}',
        description: 'Local development server',
        variables: {
          port: {
            default: '5000',
            description: 'Port the server listens on (defaults to 5000)',
          },
        },
      },
      {
        url: 'https://stellar-tags-production.up.railway.app',
        description: 'Production server',
      },
    ],
    tags: [
      {
        name: 'Federation',
        description: 'Stellar federation protocol — resolve username tags to Stellar addresses',
      },
      {
        name: 'Registration',
        description: 'Register new username–address mappings',
      },
      {
        name: 'Lookup',
        description: 'Reverse-lookup and search users by address or keyword',
      },
      {
        name: 'Health',
        description: 'Server liveness check',
      },
    ],
    components: {
      schemas: {
        FederationResponse: {
          type: 'object',
          required: ['stellar_address', 'account_id'],
          properties: {
            stellar_address: {
              type: 'string',
              example: 'alice*stellar-tags-production.up.railway.app',
              description: 'Fully-qualified Stellar federation address (username*domain)',
            },
            account_id: {
              type: 'string',
              example: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
              description: 'Stellar public key (G…) associated with this tag',
            },
            memo_type: {
              type: 'string',
              enum: ['text', 'id', 'hash'],
              description: 'Type of Stellar memo attached to this account (omitted when absent)',
            },
            memo: {
              type: 'string',
              description: 'Memo value matching memo_type (omitted when absent)',
            },
          },
        },
        RegisterRequest: {
          type: 'object',
          required: ['username', 'address'],
          properties: {
            username: {
              type: 'string',
              minLength: 3,
              example: 'alice',
              description:
                'Desired username. Must be ≥ 3 characters. A domain suffix (*domain) is appended automatically if omitted.',
            },
            address: {
              type: 'string',
              example: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
              description: 'Stellar public key (must start with G)',
            },
            signature: {
              type: 'string',
              description:
                'Optional. Base64-encoded SEP-0053 signature or raw ed25519 public key for multi-signer verification.',
            },
            signerAddress: {
              type: 'string',
              description:
                'Optional. Stellar public key of the signer when using Freighter signature flow.',
            },
            memo_type: {
              type: 'string',
              enum: ['text', 'id', 'hash'],
              description: 'Optional. Stellar memo type to associate with this registration.',
            },
            memo: {
              type: 'string',
              description: 'Optional. Memo value (required when memo_type is provided).',
            },
          },
        },
        RegisterResponse: {
          type: 'object',
          required: ['ok', 'username', 'address', 'federation_address'],
          properties: {
            ok: {
              type: 'boolean',
              example: true,
            },
            username: {
              type: 'string',
              example: 'alice*localhost',
            },
            address: {
              type: 'string',
              example: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
            },
            federation_address: {
              type: 'string',
              example: 'alice*localhost',
            },
            memo_type: {
              type: 'string',
              description: 'Included only when memo was supplied at registration',
            },
            memo: {
              type: 'string',
              description: 'Included only when memo was supplied at registration',
            },
            verification: {
              type: 'object',
              description: 'Included only when a signature was provided',
              properties: {
                accountId: { type: 'string' },
                signerCount: { type: 'integer' },
                thresholdMet: { type: 'boolean' },
                requiredThreshold: { type: 'integer' },
                providedWeight: { type: 'integer' },
              },
            },
          },
        },
        LookupResponse: {
          type: 'object',
          required: ['username', 'address'],
          properties: {
            username: {
              type: 'string',
              example: 'alice*localhost',
            },
            address: {
              type: 'string',
              example: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
            },
          },
        },
        LookupPagedResponse: {
          type: 'object',
          required: ['data', 'totalCount', 'totalPages', 'currentPage'],
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  username: { type: 'string', example: 'alice*localhost' },
                  address: {
                    type: 'string',
                    example: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
                  },
                  created_at: {
                    type: 'string',
                    format: 'date-time',
                    example: '2024-01-15T10:30:00.000Z',
                  },
                },
              },
            },
            totalCount: { type: 'integer', example: 42 },
            totalPages: { type: 'integer', example: 5 },
            currentPage: { type: 'integer', example: 1 },
          },
        },
        HealthResponse: {
          type: 'object',
          required: ['status'],
          properties: {
            status: {
              type: 'string',
              example: 'ok',
            },
          },
        },
        ErrorResponse: {
          type: 'object',
          required: ['success', 'error'],
          properties: {
            success: {
              type: 'boolean',
              example: false,
            },
            error: {
              type: 'string',
              example: 'Missing required parameter',
            },
            statusCode: {
              type: 'integer',
              example: 400,
            },
          },
        },
      },
    },
  },
  // Scan server.js for JSDoc @swagger annotations
  apis: ['./server.js'],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = { swaggerSpec };
