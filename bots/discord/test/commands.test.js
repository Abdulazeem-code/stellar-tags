const test = require('node:test');
const assert = require('node:assert/strict');
const resolveCommand = require('../src/commands/resolve');
const payCommand = require('../src/commands/pay');
const helpCommand = require('../src/commands/help');

function createMockInteraction(commandName, options = {}) {
  let deferred = false;
  let deferEphemeral = null;
  let replyData = null;
  let editReplyData = null;

  return {
    commandName,
    isChatInputCommand: () => true,
    options: {
      getString: (name, required) => options[name] ?? null,
      getBoolean: (name, required) => options[name] ?? null,
    },
    deferReply: async ({ ephemeral } = {}) => {
      deferred = true;
      deferEphemeral = ephemeral;
    },
    reply: async (data) => {
      replyData = data;
    },
    editReply: async (data) => {
      editReplyData = data;
    },
    get _state() {
      return { deferred, deferEphemeral, replyData, editReplyData };
    },
  };
}

test('resolve command successfully resolves a tag', async () => {
  const interaction = createMockInteraction('resolve', { tag: 'alice', public: false });
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

  await resolveCommand.execute(interaction, config, mockDeps);

  assert.equal(interaction._state.deferred, true);
  assert.equal(interaction._state.deferEphemeral, true);
  const embed = interaction._state.editReplyData.embeds[0];
  assert.ok(embed.data.title.includes('alice'));
  const fullAddressField = embed.data.fields.find((f) => f.name === 'Full Stellar Account ID');
  assert.equal(fullAddressField.value, '`GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G`');
});

test('resolve command handles unknown tag error', async () => {
  const interaction = createMockInteraction('resolve', { tag: 'missing_user' });
  const config = { domain: 'stellar-tags.org', network: 'testnet' };

  const mockDeps = {
    resolveTag: async () => {
      const err = new Error('Tag not found');
      err.code = 'TAG_NOT_FOUND';
      throw err;
    },
  };

  await resolveCommand.execute(interaction, config, mockDeps);

  const embed = interaction._state.editReplyData.embeds[0];
  assert.equal(embed.data.title, '❌ Tag Not Found');
  assert.ok(embed.data.description.includes('missing_user'));
});

test('pay command creates payment embed and QR attachment', async () => {
  const interaction = createMockInteraction('pay', {
    tag: 'alice',
    amount: '25.5',
    asset: 'USDC',
    public: true,
  });
  const config = { domain: 'stellar-tags.org', network: 'testnet' };

  const mockDeps = {
    resolveTag: async () => ({
      accountId: 'GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G',
      stellarAddress: 'GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G',
      memo: 'Order#99',
      memoType: 'text',
    }),
    generateQrBuffer: async (uri) => {
      assert.ok(uri.startsWith('web+stellar:pay?'));
      return Buffer.from('FAKE_QR_BUFFER');
    },
  };

  await payCommand.execute(interaction, config, mockDeps);

  // public is true, deferEphemeral should be false
  assert.equal(interaction._state.deferEphemeral, false);
  const embed = interaction._state.editReplyData.embeds[0];
  assert.ok(embed.data.title.includes('alice'));
  assert.ok(embed.data.description.includes('web+stellar:pay?'));
  const amountField = embed.data.fields.find((f) => f.name === 'Amount');
  assert.equal(amountField.value, '`25.5 USDC`');
  assert.equal(interaction._state.editReplyData.files.length, 1);
});

test('pay command handles invalid amount', async () => {
  const interaction = createMockInteraction('pay', {
    tag: 'alice',
    amount: '-10',
  });
  const config = { domain: 'stellar-tags.org', network: 'testnet' };

  await payCommand.execute(interaction, config);

  const embed = interaction._state.editReplyData.embeds[0];
  assert.equal(embed.data.title, '⚠️ Invalid Amount');
});

test('help command returns usage embed', async () => {
  const interaction = createMockInteraction('help', { public: false });
  const config = { domain: 'stellar-tags.org', network: 'testnet' };

  await helpCommand.execute(interaction, config);

  assert.equal(interaction._state.replyData.ephemeral, true);
  const embed = interaction._state.replyData.embeds[0];
  assert.equal(embed.data.title, '🌟 Stellar Tags Discord Bot');
});
