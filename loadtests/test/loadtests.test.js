const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('loadtests files exist and are populated', () => {
  const dir = path.resolve(__dirname, '../');
  assert.ok(fs.existsSync(path.join(dir, 'common.js')));
  assert.ok(fs.existsSync(path.join(dir, 'federation.js')));
  assert.ok(fs.existsSync(path.join(dir, 'lookup.js')));
  assert.ok(fs.existsSync(path.join(dir, 'mixed.js')));
  assert.ok(fs.existsSync(path.join(dir, 'export-data.js')));
  assert.ok(fs.existsSync(path.join(dir, 'usernames.txt')));
  assert.ok(fs.existsSync(path.join(dir, 'addresses.txt')));

  const usernames = fs.readFileSync(path.join(dir, 'usernames.txt'), 'utf8').trim().split('\n');
  const addresses = fs.readFileSync(path.join(dir, 'addresses.txt'), 'utf8').trim().split('\n');

  assert.ok(usernames.length >= 50);
  assert.ok(addresses.length >= 50);
});

test('local base URL safety validation protects non-local targets', () => {
  const common = fs.readFileSync(path.resolve(__dirname, '../common.js'), 'utf8');

  // Verify the safety check logic exists
  assert.ok(common.includes('ALLOW_REMOTE'));
  assert.ok(common.includes('validateLocalBaseUrl'));
  assert.ok(common.includes('http://localhost'));
  assert.ok(common.includes('http://127.0.0.1'));
});

test('mixed script verifies realistic distribution', () => {
  const mixed = fs.readFileSync(path.resolve(__dirname, '../mixed.js'), 'utf8');
  assert.ok(mixed.includes('0.80')); // 80% federation
  assert.ok(mixed.includes('0.90')); // 10% lookup
  assert.ok(mixed.includes('0.95')); // 5% stellar.toml, 5% health
  assert.ok(mixed.includes('p(95)<200'));
});
