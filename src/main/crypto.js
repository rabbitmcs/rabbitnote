'use strict';
// All encryption lives here. AES-256-GCM for data, scrypt for the passphrase, HKDF for subkeys.
const crypto = require('crypto');

const KDF = { name: 'scrypt', N: 2 ** 18, r: 8, p: 1 };
const MAGIC = Buffer.from('RN1');
const PAD_BLOCK = 1024;

function deriveFromPassphrase(passphrase, salt, kdf = KDF) {
  if (kdf.name !== 'scrypt' || kdf.r !== 8 || kdf.p !== 1 || !Number.isInteger(Math.log2(kdf.N)) || kdf.N < 2 ** 14 || kdf.N > 2 ** 21) {
    throw new Error('This notebook file has invalid settings.');
  }
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase.normalize('NFKC'), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r }, (e, k) => (e ? reject(e) : resolve(k)));
  });
}

function subkey(master, label) {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), `rabbitnote/${label}`, 32));
}

function seal(key, plaintext, aad) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([MAGIC, nonce, c.getAuthTag(), body]);
}

function open(key, sealed, aad) {
  if (sealed.length < 31 || !sealed.subarray(0, 3).equals(MAGIC)) throw new Error('Not a RabbitNote file.');
  const d = crypto.createDecipheriv('aes-256-gcm', key, sealed.subarray(3, 15));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(sealed.subarray(15, 31));
  return Buffer.concat([d.update(sealed.subarray(31)), d.final()]);
}

// Hides an entry's exact length from anyone holding the encrypted file.
function pad(data) {
  const size = Math.ceil((data.length + 4) / PAD_BLOCK) * PAD_BLOCK;
  const out = Buffer.alloc(size);
  out.writeUInt32BE(data.length, 0);
  data.copy(out, 4);
  return out;
}
function unpad(buf) {
  const n = buf.readUInt32BE(0);
  if (n + 4 > buf.length) throw new Error('Bad padding.');
  return buf.subarray(4, 4 + n);
}

const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest('hex');
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex'); // only to compare with Drive's checksum

module.exports = { KDF, deriveFromPassphrase, subkey, seal, open, pad, unpad, hmac, md5 };
