const test = require('node:test');
const assert = require('node:assert/strict');
const { createBot } = require('../src/bot');

test('bot handles /resolve command successfully', async () => {
  const config = {
    domain: 'stellar-tags.org',
    network: 'testnet',
  };

  const mockDeps = {
    resolveTag: async (tag) => {
      assert.equal(tag, 'alice');
      return {
        accountId: 'GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G',
        stellarAddress: 'GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G',
        memo: 'Platform123',
        memoType: 'text',
      };
    },
  };

  const bot = createBot(config, mockDeps);

  let replyText = '';
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === 'sendMessage') {
      replyText = payload.text;
      return { ok: true, result: { message_id: 99, chat: { id: payload.chat_id } } };
    }
    return prev(method, payload, signal);
  });

  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 12345, type: 'private' },
      from: { id: 12345, is_bot: false, first_name: 'Tester' },
      text: '/resolve alice',
      entities: [{ type: 'bot_command', offset: 0, length: 8 }],
    },
  });

  assert.ok(replyText.includes('Resolved Stellar Tag'));
  assert.ok(replyText.includes('Platform123'));
});

test('bot handles /pay command and generates QR response', async () => {
  const config = {
    domain: 'stellar-tags.org',
    network: 'testnet',
  };

  let sentPhotoCaption = '';
  const mockDeps = {
    resolveTag: async () => ({
      accountId: 'GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G',
      stellarAddress: 'GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G',
      memo: 'PayMemo',
      memoType: 'text',
    }),
    generateQrBuffer: async (uri) => {
      assert.ok(uri.startsWith('web+stellar:pay?'));
      return Buffer.from('FAKE_QR_DATA');
    },
  };

  const bot = createBot(config, mockDeps);
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === 'sendPhoto') {
      sentPhotoCaption = payload.caption || '';
      return { ok: true, result: { message_id: 100, chat: { id: payload.chat_id } } };
    }
    return prev(method, payload, signal);
  });

  await bot.handleUpdate({
    update_id: 2,
    message: {
      message_id: 2,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 12345, type: 'private' },
      from: { id: 12345, is_bot: false, first_name: 'Tester' },
      text: '/pay alice 15.5 XLM',
      entities: [{ type: 'bot_command', offset: 0, length: 4 }],
    },
  });

  assert.ok(sentPhotoCaption.includes('Payment Request for'));
  assert.ok(sentPhotoCaption.includes('15.5 XLM'));
  assert.ok(sentPhotoCaption.includes('web+stellar:pay?'));
});

test('bot handles /pay with unknown tag gracefully', async () => {
  const config = {
    domain: 'stellar-tags.org',
    network: 'testnet',
  };

  let repliedText = '';
  const mockDeps = {
    resolveTag: async () => {
      const err = new Error('Tag not found');
      err.code = 'TAG_NOT_FOUND';
      throw err;
    },
  };

  const bot = createBot(config, mockDeps);
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === 'sendMessage') {
      repliedText = payload.text;
      return { ok: true, result: { message_id: 101, chat: { id: payload.chat_id } } };
    }
    return prev(method, payload, signal);
  });

  await bot.handleUpdate({
    update_id: 3,
    message: {
      message_id: 3,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 12345, type: 'private' },
      from: { id: 12345, is_bot: false, first_name: 'Tester' },
      text: '/pay unknown 10',
      entities: [{ type: 'bot_command', offset: 0, length: 4 }],
    },
  });

  assert.ok(repliedText.includes('was not found'));
});

test('bot handles /pay with invalid amount gracefully', async () => {
  const config = {
    domain: 'stellar-tags.org',
    network: 'testnet',
  };

  let repliedText = '';
  const bot = createBot(config, {});
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === 'sendMessage') {
      repliedText = payload.text;
      return { ok: true, result: { message_id: 102, chat: { id: payload.chat_id } } };
    }
    return prev(method, payload, signal);
  });

  await bot.handleUpdate({
    update_id: 4,
    message: {
      message_id: 4,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 12345, type: 'private' },
      from: { id: 12345, is_bot: false, first_name: 'Tester' },
      text: '/pay alice -5',
      entities: [{ type: 'bot_command', offset: 0, length: 4 }],
    },
  });

  assert.ok(repliedText.includes('Invalid amount') || repliedText.includes('positive number'));
});
