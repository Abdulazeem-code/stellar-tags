const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { prisma } = require('../../../prismaClient');
const { normalizeNameTag } = require('../../utils');
const { verifyMultiSignerThreshold } = require('../../multisigner-verifier');
const { logger } = require('../../logger');
const { Keypair, StrKey } = require('@stellar/stellar-sdk');
const { asyncHandler } = require('../../middleware/asyncHandler');

const router = express.Router();

const verifyFreighterSignedMessage = ({
  message,
  signature,
  signerAddress,
  publicKey,
}) => {
  const claimedSigner = signerAddress || publicKey;

  if (!StrKey.isValidEd25519PublicKey(claimedSigner)) {
    const error = new Error('Invalid signer address format.');
    error.statusCode = 400;
    throw error;
  }

  const keypair = Keypair.fromPublicKey(claimedSigner);

  let signatureBuffer;
  if (Buffer.isBuffer(signature)) {
    signatureBuffer = signature;
  } else if (typeof signature === 'string') {
    signatureBuffer = Buffer.from(signature, 'base64');
  } else {
    throw new Error('Invalid message signature format.');
  }

  const prefix = Buffer.from('Stellar Signed Message:\n', 'utf8');
  const messageBytes = Buffer.from(message, 'utf8');
  const payload = Buffer.concat([prefix, messageBytes]);
  const messageHash = crypto.createHash('sha256').update(payload).digest();

  if (!keypair.verify(messageHash, signatureBuffer)) {
    const error = new Error('Signature verification failed.');
    error.statusCode = 401;
    throw error;
  }

  if (claimedSigner !== publicKey) {
    const error = new Error('Signer address does not match the registered account.');
    error.statusCode = 401;
    throw error;
  }

  return claimedSigner;
};

/**
 * Authenticates a webhook management request by verifying the Stellar
 * signature provided in the request body against the registered address for
 * the given username. Uses Prisma for all DB lookups.
 */
const authenticateWebhookCall = async (req) => {
  const rawUsername = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const signature = typeof req.body?.signature === 'string' ? req.body.signature.trim() : '';
  const signerAddress = typeof req.body?.signerAddress === 'string' ? req.body.signerAddress.trim() : undefined;

  if (!rawUsername) {
    const error = new Error('Missing required field: username.');
    error.statusCode = 400;
    throw error;
  }
  if (!signature) {
    const error = new Error('Missing required field: signature.');
    error.statusCode = 400;
    throw error;
  }

  const normalizedUsername = normalizeNameTag(rawUsername).toLowerCase();

  const userRecord = await prisma.user.findUnique({
    where: { username: normalizedUsername },
    select: { username: true, address: true },
  });

  if (!userRecord) {
    const error = new Error('Username not registered.');
    error.statusCode = 404;
    throw error;
  }

  const operation =
    typeof req.body?.operation === 'string' ? req.body.operation : 'webhook';
  const message = `${operation}:${normalizedUsername}`;

  if (StrKey.isValidEd25519PublicKey(signature) && !signerAddress) {
    const verificationResult = await verifyMultiSignerThreshold(
      userRecord.address,
      [signature],
      { operationType: 'management' },
    );
    if (!verificationResult.success) {
      const error = new Error(verificationResult.errorMessage || 'Signature verification failed');
      error.statusCode = 401;
      throw error;
    }
  } else {
    verifyFreighterSignedMessage({
      message,
      signature,
      signerAddress,
      publicKey: userRecord.address,
    });
  }

  return userRecord;
};

const isValidWebhookUrl = (url) => {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

const normalizeWebhookEvents = (input) => {
  if (input === undefined || input === null) return ['*'];
  const raw = Array.isArray(input) ? input : [input];
  const events = raw
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())
    .filter((value, index, arr) => arr.indexOf(value) === index);

  if (events.length === 0) return ['*'];
  if (events.includes('*')) return ['*'];

  return events;
};

const getWebhookSecret = (req) => {
  const headerValue = req.get ? req.get('X-Webhook-Secret') || req.get('X-Stellar-Tags-Secret') : '';
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const secret = typeof body.secret === 'string' ? body.secret : (typeof body.webhookSecret === 'string' ? body.webhookSecret : headerValue);
  return typeof secret === 'string' && secret.trim() ? secret.trim() : '';
};

const getPayloadForVerification = (body) => {
  if (body && typeof body === 'object' && !Array.isArray(body) && Object.prototype.hasOwnProperty.call(body, 'payload')) {
   return body.payload;
  }

  if (body && typeof body === 'object' && !Array.isArray(body)) {
   const { secret, webhookSecret, signature, ...rest } = body;
   if (Object.keys(rest).length > 0) {
     return rest;
   }
  }

  return body;
};

const normalizeSignature = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^sha256=/i, '');
};

const getSigningPayloadBuffer = (payload) => {
  if (Buffer.isBuffer(payload)) return payload;
  if (typeof payload === 'string') return Buffer.from(payload, 'utf8');
  if (payload === undefined || payload === null) {
   throw new Error('Missing required field: payload.');
  }
  return Buffer.from(JSON.stringify(payload), 'utf8');
};

// Issue #727: `Stellar-Timestamp` is an ISO 8601 timestamp (the same value as
// `payload.timestamp`). Dispatches older than 5 minutes are expired; more
// than 1 minute in the future is rejected to bound clock skew.
const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
const WEBHOOK_FUTURE_SKEW_MS = 60 * 1000;

const resolveWebhookTimestamp = (req, payload) => {
  if (req.get) {
    const headerTs = req.get('Stellar-Timestamp') || req.get('X-Webhook-Timestamp');
    if (typeof headerTs === 'string' && headerTs.trim()) return headerTs.trim();
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof body.timestamp === 'string' && body.timestamp.trim()) return body.timestamp.trim();
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed.timestamp === 'string' && parsed.timestamp.trim()) {
        return parsed.timestamp.trim();
      }
    } catch {
      return '';
    }
    return '';
  }
  if (payload && typeof payload === 'object' && typeof payload.timestamp === 'string') {
    return payload.timestamp.trim();
  }
  return '';
};

const checkTimestampFreshness = (timestamp) => {
  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts)) {
    return { ok: false, code: 'MISSING_TIMESTAMP', message: 'Missing or invalid Stellar-Timestamp header.' };
  }
  const now = Date.now();
  if (now - ts > WEBHOOK_TIMESTAMP_TOLERANCE_MS) {
    return { ok: false, code: 'TIMESTAMP_EXPIRED', message: 'Webhook timestamp is older than 5 minutes — possible replay attack.' };
  }
  if (ts - now > WEBHOOK_FUTURE_SKEW_MS) {
    return { ok: false, code: 'TIMESTAMP_TOO_FAR_IN_FUTURE', message: 'Webhook timestamp is more than 1 minute in the future — check clock synchronization.' };
  }
  return { ok: true };
};

router.post('/webhooks/verify-test', asyncHandler(async (req, res, next) => {
  try {
   const secret = getWebhookSecret(req);
   if (!secret) {
     return res.status(400).json({
       ok: false,
       error: {
         code: 'MISSING_WEBHOOK_SECRET',
         message: 'Missing required webhook secret. Provide secret or webhookSecret in the request body or X-Webhook-Secret header.',
       },
     });
   }

    const stellarSignatureHeader = normalizeSignature(
      req.get ? req.get('Stellar-Signature') : ''
    );
    const signatureHeader = normalizeSignature(
      stellarSignatureHeader || (req.get ? (req.get('X-Webhook-Signature') || req.get('X-Stellar-Tags-Signature') || req.body?.signature) : (req.body?.signature || ''))
    );
    if (!signatureHeader) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'MISSING_SIGNATURE',
          message: 'Missing required X-Webhook-Signature or Stellar-Signature header.',
        },
      });
    }

    const payload = getPayloadForVerification(req.body);
    const rawPayload = getSigningPayloadBuffer(payload);
    const isBoundScheme = Boolean(stellarSignatureHeader);
    const timestamp = resolveWebhookTimestamp(req, payload);

    if (isBoundScheme) {
      // `Stellar-Signature` binds the header timestamp: it is required and
      // must be fresh, otherwise the header could be swapped in transit.
      const freshness = checkTimestampFreshness(timestamp);
      if (!freshness.ok) {
        const status = freshness.code === 'MISSING_TIMESTAMP' ? 400 : 401;
        return res.status(status).json({
          ok: false,
          valid: false,
          error: { code: freshness.code, message: freshness.message },
        });
      }
    } else if (timestamp) {
      // Legacy body-only scheme: enforce expiry when a timestamp is present,
      // skip when absent for backward compatibility with older payloads.
      const freshness = checkTimestampFreshness(timestamp);
      if (!freshness.ok && freshness.code !== 'MISSING_TIMESTAMP') {
        return res.status(401).json({
          ok: false,
          valid: false,
          error: { code: freshness.code, message: freshness.message },
        });
      }
    }

    const expectedSignature = isBoundScheme
      ? crypto.createHmac('sha256', secret).update(`${timestamp}.${rawPayload.toString('utf8')}`).digest('hex')
      : crypto.createHmac('sha256', secret).update(rawPayload).digest('hex');

   const expectedBuffer = Buffer.from(expectedSignature, 'hex');
   const receivedBuffer = Buffer.from(signatureHeader, 'hex');

   if (expectedBuffer.length !== receivedBuffer.length) {
     return res.status(401).json({
       ok: false,
       valid: false,
       error: {
         code: 'INVALID_WEBHOOK_SIGNATURE',
         message: 'The provided signature does not match the webhook secret and payload.',
       },
       expectedSignature,
       receivedSignature: signatureHeader,
     });
   }

   let valid;
   try {
     valid = crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
   } catch (error) {
     valid = false;
   }

   if (!valid) {
     return res.status(401).json({
       ok: false,
       valid: false,
       error: {
         code: 'INVALID_WEBHOOK_SIGNATURE',
         message: 'The provided signature does not match the webhook secret and payload.',
       },
       expectedSignature,
       receivedSignature: signatureHeader,
     });
   }

   return res.status(200).json({
     ok: true,
     valid: true,
     message: 'Webhook signature verification succeeded.',
     expectedSignature,
     receivedSignature: signatureHeader,
   });
  } catch (err) {
   if (err.statusCode) return next(err);
   logger.error('[webhooks] POST /webhooks/verify-test failed:', err.message);
   const error = new Error(err.message || 'Failed to verify webhook signature');
   error.statusCode = 400;
   return next(error);
  }
}));

router.post('/webhooks', asyncHandler(async (req, res, next) => {
  try {
    if (!req.is('application/json')) {
      return res.status(415).json({ error: 'Unsupported Media Type. Please send application/json' });
    }

    const user = await authenticateWebhookCall(req);
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';

    if (!isValidWebhookUrl(rawUrl)) {
      return res.status(400).json({ error: 'Invalid webhook URL. Must be http or https.' });
    }

    const secret = crypto.randomBytes(32).toString('hex');
    const id = uuidv4();
    const now = new Date();

    let webhook;
    try {
      webhook = await prisma.webhook.create({
        data: {
          id,
          username: user.username,
          url: rawUrl,
          secret,
          createdAt: now,
        },
      });
    } catch (error) {
      if (
        error?.code === 'P2002' &&
        Array.isArray(error.meta?.target) &&
        error.meta.target.includes('username') &&
        error.meta.target.includes('url')
      ) {
        const conflictError = new Error('A webhook with this URL is already registered for the user.');
        conflictError.statusCode = 409;
        return next(conflictError);
      }
      throw error;
    }

    return res.status(201).json({
      ok: true,
      webhook: {
        id: webhook.id,
        username: webhook.username,
        url: webhook.url,
        secret,
        created_at: (webhook.createdAt instanceof Date
          ? webhook.createdAt
          : new Date(webhook.createdAt)
        ).toISOString(),
      },
      note: 'Save the secret securely — it will only be returned once. Signatures for webhook payloads are computed with HMAC-SHA256 using this secret.',
    });
  } catch (err) {
    if (err.statusCode) return next(err);
    logger.error('[webhooks] POST /webhooks failed:', err.message);
    const generic = new Error('Failed to register webhook');
    generic.statusCode = 500;
    return next(generic);
  }
}));

router.get('/webhooks', asyncHandler(async (req, res, next) => {
  try {
    if (!req.is('application/json') && Object.keys(req.body || {}).length > 0) {
      return res.status(415).json({ error: 'Unsupported Media Type. Please send application/json' });
    }

    const user = await authenticateWebhookCall(req);

    const webhooks = await prisma.webhook.findMany({
      where: { username: user.username },
      orderBy: { createdAt: 'desc' },
    });

    return res.status(200).json({
      ok: true,
      webhooks: webhooks.map((w) => ({
        id: w.id,
        url: w.url,
        created_at: (w.createdAt instanceof Date ? w.createdAt : new Date(w.createdAt)).toISOString(),
        last_sent_at: w.lastSentAt
          ? (w.lastSentAt instanceof Date ? w.lastSentAt : new Date(w.lastSentAt)).toISOString()
          : null,
        failing_since: w.failingSince
          ? (w.failingSince instanceof Date ? w.failingSince : new Date(w.failingSince)).toISOString()
          : null,
      })),
    });
  } catch (err) {
    if (err.statusCode) return next(err);
    logger.error('[webhooks] GET /webhooks failed:', err.message);
    const generic = new Error('Failed to list webhooks');
    generic.statusCode = 500;
    return next(generic);
  }
}));

router.delete('/webhooks/:id', asyncHandler(async (req, res, next) => {
  try {
    if (!req.is('application/json') && Object.keys(req.body || {}).length > 0) {
      return res.status(415).json({ error: 'Unsupported Media Type. Please send application/json' });
    }

    const user = await authenticateWebhookCall(req);
    const id = typeof req.params?.id === 'string' ? req.params.id.trim() : '';

    if (!id) {
      return res.status(400).json({ error: 'Webhook id is required in URL path.' });
    }

    const deleted = await prisma.webhook.deleteMany({
      where: { id, username: user.username },
    });

    if (deleted.count === 0) {
      return res.status(404).json({ error: 'Webhook not found.' });
    }

    return res.status(200).json({ ok: true, deleted: true });
  } catch (err) {
    if (err.statusCode) return next(err);
    logger.error('[webhooks] DELETE /webhooks/:id failed:', err.message);
    const generic = new Error('Failed to delete webhook');
    generic.statusCode = 500;
    return next(generic);
  }
}));

router.all('/webhooks', (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  res.status(404).end();
});

router.post('/webhooks/verify-test', (req, res) => {
  const { secret, payload } = req.body;
  const signature = req.headers['x-webhook-signature'] || req.headers['x-stellar-tags-signature'];

  if (!secret || !payload) {
    return res.status(400).json({ error: 'Missing secret or payload' });
  }

  const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  if (signature === expectedSignature) {
    return res.status(200).json({
      ok: true,
      valid: true,
      message: 'Signature verification succeeded',
      expectedSignature,
    });
  } else {
    return res.status(401).json({
      ok: false,
      valid: false,
      error: {
        code: 'INVALID_WEBHOOK_SIGNATURE',
        message: 'Signature verification failed',
        expected: expectedSignature,
        received: signature,
      },
      receivedSignature: signature,
    });
  }
});

module.exports = (redisClient) => router;
