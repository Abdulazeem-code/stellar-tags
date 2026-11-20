const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Stellar Tags API',
      version: '1.0.0',
      description:
        'Federation, registration, and lookup API for Stellar name tags (stellar-tags).',
    },
    servers: [
      {
        url: process.env.API_BASE_URL || 'http://localhost:5000',
        description: 'Active server',
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
              description: 'Human-readable Stellar federation address (e.g. alice*localhost).',
              example: 'alice*localhost',
            },
            account_id: {
              type: 'string',
              description: 'Stellar public key (G…).',
              example: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
            },
            memo_type: {
              type: 'string',
              enum: ['text', 'id', 'hash'],
              description: 'Optional memo type attached to this address.',
              example: 'text',
            },
            memo: {
              type: 'string',
              description: 'Optional memo value paired with memo_type.',
              example: 'payment-ref',
            },
          },
        },
        RegisterRequest: {
          type: 'object',
          required: ['username', 'address'],
          properties: {
            username: {
              type: 'string',
              description: 'Desired name tag (minimum 3 characters, profanity-free).',
              example: 'alice',
            },
            address: {
              type: 'string',
              description: 'Stellar public key to associate with this username.',
              example: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
            },
            memo_type: {
              type: 'string',
              enum: ['text', 'id', 'hash'],
              description: 'Optional memo type (required when memo is provided).',
              example: 'text',
            },
            memo: {
              type: 'string',
              description: 'Optional memo value (required when memo_type is provided).',
              example: 'payment-ref',
            },
            signature: {
              type: 'string',
              description:
                'Base64-encoded SEP-0053 signature or signer public key (for multi-sig flows).',
              example: 'base64EncodedSignatureString==',
            },
            signerAddress: {
              type: 'string',
              description:
                'Public key of the signer when it differs from the account address (Freighter flow).',
              example: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
            },
          },
        },
        RegisterResponse: {
          type: 'object',
          required: ['ok', 'username', 'address', 'federation_address'],
          properties: {
            ok: { type: 'boolean', example: true },
            username: { type: 'string', example: 'alice*localhost' },
            address: {
              type: 'string',
              example: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
            },
            federation_address: {
              type: 'string',
              example: 'alice*localhost',
            },
            memo_type: { type: 'string', example: 'text' },
            memo: { type: 'string', example: 'payment-ref' },
            verification: {
              type: 'object',
              description: 'Multi-signer verification details (present when a signature was provided).',
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
        LookupUser: {
          type: 'object',
          required: ['username', 'address'],
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
        LookupListResponse: {
          type: 'object',
          required: ['data', 'totalCount', 'totalPages', 'currentPage'],
          properties: {
            data: {
              type: 'array',
              items: { $ref: '#/components/schemas/LookupUser' },
            },
            totalCount: { type: 'integer', example: 42 },
            totalPages: { type: 'integer', example: 5 },
            currentPage: { type: 'integer', example: 1 },
          },
        },
        ErrorResponse: {
          type: 'object',
          required: ['success', 'error'],
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', example: 'Descriptive error message.' },
            statusCode: { type: 'integer', example: 400 },
          },
        },
      },
    },
  },
  apis: ['./server.js'],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;
