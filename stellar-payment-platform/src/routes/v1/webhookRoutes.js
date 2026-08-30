const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { prisma } = require('../../../prismaClient');
const { normalizeNameTag, poolGet, poolRun, poolAll } = require('../../db');
const { verifyMultiSignerThreshold } = require('../../multisigner-verifier');
const { logger } = require('../../logger');
const { Keypair, StrKey } = require('@stellar/stellar-sdk');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { shouldFallbackToLocalRegistry } = require('../../utils');

const router = express.Router();

const DEFAULT_FEDERATION_DOMAIN = 'localhost';

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

  let userRecord;
  try {
    userRecord = await prisma.user.findUnique({
      where: { username: normalizedUsername },
      select: { username: true, address: true },
    });
  } catch (err) {
    if (!shouldFallbackToLocalRegistry(err)) throw err;
    const localRow = await poolGet(
      'SELECT username, address FROM username_registry WHERE username = $1 LIMIT 1',
      [normalizedUsername],
    );
    userRecord = localRow
      ? { username: localRow.username, address: localRow.address }
      : null;
  }

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

router.post('/webhooks', asyncHandler(async (req, res, next) => {
  try {
    if (!req.is('application/json')) {
      return res.status(415).json({ error: 'Unsupported Media Type. Please send application/json' });
    }

    const user = await authenticateWebhookCall(req);
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const events = normalizeWebhookEvents(req.body?.events);

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
          events,
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
      if (!shouldFallbackToLocalRegistry(error)) throw error;

      await poolRun(
        `INSERT INTO webhooks (id, username, url, secret, events, created_at, last_sent_at, failing_since)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)`,
        [id, user.username, rawUrl, secret, JSON.stringify(events), now.toISOString()],
      );
      webhook = { id, username: user.username, url: rawUrl, events, createdAt: now.toISOString() };
    }

    return res.status(201).json({
      ok: true,
      webhook: {
        id: webhook.id,
        username: webhook.username,
        url: webhook.url,
        events: Array.isArray(webhook.events) ? webhook.events : normalizeWebhookEvents(webhook.events),
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

    let webhooks;
    try {
      webhooks = await prisma.webhook.findMany({
        where: { username: user.username },
        orderBy: { createdAt: 'desc' },
      });
    } catch (error) {
      if (!shouldFallbackToLocalRegistry(error)) throw error;
      const rows = await poolAll(
        `SELECT id, username, url, events, created_at, last_sent_at, failing_since
         FROM webhooks WHERE username = $1 ORDER BY created_at DESC`,
        [user.username],
      );
      webhooks = rows.map((r) => ({
        id: r.id,
        username: r.username,
        url: r.url,
        events: Array.isArray(r.events) ? r.events : (typeof r.events === 'string' ? JSON.parse(r.events || '[]') : ['*']),
        createdAt: r.created_at,
        lastSentAt: r.last_sent_at,
        failingSince: r.failing_since,
      }));
    }

    return res.status(200).json({
      ok: true,
      webhooks: webhooks.map((w) => ({
        id: w.id,
        url: w.url,
        events: Array.isArray(w.events) ? w.events : normalizeWebhookEvents(w.events),
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

    let deletedCount = 0;
    try {
      const deleted = await prisma.webhook.deleteMany({
        where: { id, username: user.username },
      });
      deletedCount = deleted.count;
    } catch (error) {
      if (!shouldFallbackToLocalRegistry(error)) throw error;
      const result = await poolRun(
        'DELETE FROM webhooks WHERE id = $1 AND username = $2',
        [id, user.username],
      );
      deletedCount = result?.changes || 0;
    }

    if (deletedCount === 0) {
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

module.exports = router;
