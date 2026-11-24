#!/usr/bin/env node
'use strict';

// Generates the WebAuthn and ed25519 test vectors used by passkey_wallet's
// tests (tests/fixtures/webauthn_vectors.json).
//
//   node passkey_wallet/scripts/generate-webauthn-vectors.js
//
// Each passkey assertion is built the way a browser builds one for
// navigator.credentials.get(): authenticator data is
// rpIdHash || flags || signCount, client data is a JSON object whose
// `challenge` is the base64url (no padding) encoding of the Soroban signature
// payload, and the signature is ECDSA P-256 over
// sha256(authenticatorData || sha256(clientDataJSON)), encoded as r || s with
// s normalised to the low half of the curve order (as Soroban requires).
//
// Keys are generated fresh on every run and only public keys and signatures
// are written out: no private key is ever committed. Regenerating changes every
// value in the file; the tests read whatever the file holds.
//
// Only Node's built-in crypto module is used (Node 16+).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'tests', 'fixtures', 'webauthn_vectors.json');

const RP_ID = 'stellartags.xyz';
const ORIGIN = `https://${RP_ID}`;
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;

// secp256r1 group order.
const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const hex = (buf) => Buffer.from(buf).toString('hex');
const base64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(s, 'base64url');
const toBytes32 = (n) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');

// The fixed signature payloads. In a real transaction this is the hash of the
// Soroban authorization preimage; the tests call __check_auth directly with
// these values.
const PAYLOAD = sha256(Buffer.from('passkey_wallet test payload 1'));
const OTHER_PAYLOAD = sha256(Buffer.from('passkey_wallet test payload 2'));

const newPasskey = (name) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const uncompressed = Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)]);
  return {
    name,
    id: crypto.randomBytes(16),
    publicKey: uncompressed,
    privateKey,
  };
};

const newEd25519 = (name) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { name, publicKey: fromB64url(publicKey.export({ format: 'jwk' }).x), privateKey };
};

const authenticatorData = (flags, signCount = 1) => {
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(signCount);
  return Buffer.concat([sha256(Buffer.from(RP_ID)), Buffer.from([flags]), counter]);
};

const clientDataJson = ({ type = 'webauthn.get', challenge, reorder = false }) => {
  // Browsers emit type, challenge, origin, crossOrigin in that order; the
  // reordered variant checks the contract does not depend on key order.
  const json = reorder
    ? `{"origin":"${ORIGIN}","crossOrigin":false,"challenge":"${challenge}","type":"${type}","other_keys_can_be_added_here":"do not compare clientDataJSON against a template"}`
    : `{"type":"${type}","challenge":"${challenge}","origin":"${ORIGIN}","crossOrigin":false}`;
  return Buffer.from(json, 'utf8');
};

const signP256 = (privateKey, authData, cdj) => {
  const signed = Buffer.concat([authData, sha256(cdj)]);
  const sig = crypto.sign('sha256', signed, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  const r = sig.subarray(0, 32);
  let s = BigInt(`0x${hex(sig.subarray(32))}`);
  if (s > N / 2n) s = N - s; // low-S normalisation
  return Buffer.concat([r, toBytes32(s)]);
};

const assertion = (passkey, { payload = PAYLOAD, flags = FLAG_UP | FLAG_UV, type, reorder, note }) => {
  const authData = authenticatorData(flags);
  const cdj = clientDataJson({ type, challenge: base64url(payload), reorder });
  return {
    note,
    signer: passkey.name,
    id: hex(passkey.id),
    authenticator_data: hex(authData),
    client_data_json: hex(cdj),
    signature: hex(signP256(passkey.privateKey, authData, cdj)),
  };
};

const ed25519Signature = (key, payload, note) => ({
  note,
  signer: key.name,
  public_key: hex(key.publicKey),
  signature: hex(crypto.sign(null, payload, key.privateKey)),
});

const passkeys = ['passkey_a', 'passkey_b', 'passkey_c'].map(newPasskey);
const [a, b, c] = passkeys;
const edKeys = ['ed25519_a', 'ed25519_b'].map(newEd25519);

const vectors = {
  generated_by: 'passkey_wallet/scripts/generate-webauthn-vectors.js',
  rp_id: RP_ID,
  origin: ORIGIN,
  payload: hex(PAYLOAD),
  other_payload: hex(OTHER_PAYLOAD),
  passkeys: passkeys.map((p) => ({ name: p.name, id: hex(p.id), public_key: hex(p.publicKey) })),
  ed25519_keys: edKeys.map((k) => ({ name: k.name, public_key: hex(k.publicKey) })),
  assertions: {
    a_valid: assertion(a, { note: 'passkey_a, UP+UV, over payload' }),
    b_valid: assertion(b, { note: 'passkey_b, UP+UV, over payload' }),
    c_valid: assertion(c, { note: 'passkey_c, UP+UV, over payload' }),
    a_reordered: assertion(a, { reorder: true, note: 'passkey_a with clientDataJSON keys reordered and an extra key' }),
    a_up_only: assertion(a, { flags: FLAG_UP, note: 'passkey_a, User Present only (no UV)' }),
    a_no_up: assertion(a, { flags: FLAG_UV, note: 'passkey_a, UV set but User Present missing' }),
    a_wrong_type: assertion(a, { type: 'webauthn.create', note: 'passkey_a, type webauthn.create' }),
    a_wrong_challenge: assertion(a, { payload: OTHER_PAYLOAD, note: 'passkey_a, challenge is other_payload' }),
  },
  ed25519_signatures: {
    ed_a_valid: ed25519Signature(edKeys[0], PAYLOAD, 'ed25519_a over payload'),
    ed_b_valid: ed25519Signature(edKeys[1], PAYLOAD, 'ed25519_b over payload'),
  },
};

// Self-check every vector with an independent verifier before writing.
for (const [name, v] of Object.entries(vectors.assertions)) {
  const key = passkeys.find((p) => p.name === v.signer);
  const signed = Buffer.concat([Buffer.from(v.authenticator_data, 'hex'), sha256(Buffer.from(v.client_data_json, 'hex'))]);
  const ok = crypto.verify('sha256', signed, { key: crypto.createPublicKey(key.privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(v.signature, 'hex'));
  if (!ok) throw new Error(`self-check failed for ${name}`);
}
for (const [name, v] of Object.entries(vectors.ed25519_signatures)) {
  const key = edKeys.find((k) => k.name === v.signer);
  if (!crypto.verify(null, PAYLOAD, crypto.createPublicKey(key.privateKey), Buffer.from(v.signature, 'hex'))) {
    throw new Error(`self-check failed for ${name}`);
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`Wrote ${path.relative(process.cwd(), OUT)}`);
