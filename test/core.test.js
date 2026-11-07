'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const { Vault, tagsOf } = require('../src/main/vault');
const { syncOnce } = require('../src/main/sync');
const { Drive } = require('../src/main/drive');

const FAST = { name: 'scrypt', N: 2 ** 14, r: 8, p: 1 };
const PASS = 'correct horse battery';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rn-'));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const res = (status, body) => new Response(body, { status });

// Emulates the parts of the Drive REST API that the real Drive class calls.
function fakeGoogle() {
  const files = new Map(); let n = 0; const calls = { refresh: 0 };
  const meta = (f) => ({ id: f.id, name: f.name, md5Checksum: f.bytes ? md5(f.bytes) : undefined });
  const fetchFn = async (url, o = {}) => {
    const u = new URL(url);
    if (u.host === 'oauth2.googleapis.com') { calls.refresh++; return res(200, JSON.stringify({ access_token: 't', expires_in: 3600 })); }
    if (fakeGoogle.offline) throw new TypeError('fetch failed');
    assert.equal(o.headers.Authorization, 'Bearer t');
    const m = u.pathname.match(/files\/(.+)$/);
    if (u.pathname.startsWith('/upload')) {
      if (o.method === 'PATCH') { const f = files.get(m[1]); f.bytes = Buffer.from(o.body); return res(200, JSON.stringify(meta(f))); }
      const b = o.headers['Content-Type'].split('boundary=')[1];
      const buf = o.body; const split = buf.indexOf('\r\n\r\n');
      const jsonEnd = buf.indexOf(`\r\n--${b}`, split);
      const info = JSON.parse(buf.subarray(split + 4, jsonEnd).toString());
      const dataStart = buf.indexOf('\r\n\r\n', jsonEnd) + 4;
      const f = { id: `f${++n}`, name: info.name, parent: info.parents[0], bytes: buf.subarray(dataStart, buf.lastIndexOf(`\r\n--${b}--`)) };
      files.set(f.id, f);
      return res(200, JSON.stringify(meta(f)));
    }
    if (m && u.searchParams.get('alt') === 'media') return res(200, files.get(m[1]).bytes);
    if (o.method === 'POST') { const j = JSON.parse(o.body); const f = { id: `d${++n}`, name: j.name, folder: true }; files.set(f.id, f); return res(200, JSON.stringify({ id: f.id })); }
    const q = u.searchParams.get('q');
    if (q.includes('mimeType')) return res(200, JSON.stringify({ files: [...files.values()].filter((f) => f.folder).map((f) => ({ id: f.id })) }));
    return res(200, JSON.stringify({ files: [...files.values()].filter((f) => !f.folder).map(meta) }));
  };
  return { files, fetchFn, drive: () => new Drive({ clientId: 'c', clientSecret: 's' }, 'r', fetchFn) };
}
async function twoDevices() {
  const g = fakeGoogle();
  const a = new Vault(tmp(), FAST); await a.create(PASS);
  a.put('2026-01-01', 'seed'); await syncOnce(a, g.drive());
  const b = new Vault(tmp(), FAST);
  const vf = [...g.files.values()].find((f) => f.name === 'vault.json');
  b.writeVaultRaw(vf.bytes); await b.unlock(PASS);
  await syncOnce(b, g.drive());
  return { g, a, b };
}

test('wrong passphrase refused, right one reads entries back', async () => {
  const d = tmp(); const v = new Vault(d, FAST); await v.create(PASS);
  v.save('2026-11-04', 'secret diary #Work'); v.lock();
  const v2 = new Vault(d, FAST);
  await assert.rejects(v2.unlock('wrong passphrase!!'), /not correct/);
  await v2.unlock(PASS);
  assert.equal(v2.get('2026-11-04').text, 'secret diary #Work');
  assert.deepEqual(v2.overview().tags, { work: 1 });
});

test('nothing readable on disk: no text, no dates', async () => {
  const d = tmp(); const v = new Vault(d, FAST); await v.create(PASS);
  v.save('2026-11-04', 'supersecretword');
  const walk = (p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap((x) => walk(path.join(p, x))) : [p];
  for (const f of walk(d)) {
    const s = fs.readFileSync(f).toString('latin1') + path.basename(f);
    assert.ok(!s.includes('supersecretword') && !s.includes('2026-11-04'), f);
  }
});

test('same-size padding hides short entry lengths', async () => {
  const v = new Vault(tmp(), FAST); await v.create(PASS);
  v.save('2026-01-01', 'a'); v.save('2026-01-02', 'a much longer sentence than that');
  const sizes = v.localNames().map((n) => v.readRaw(n).length);
  assert.equal(sizes[0], sizes[1]);
});

test('tampered or swapped files are rejected', async () => {
  const v = new Vault(tmp(), FAST); await v.create(PASS);
  v.save('2026-01-01', 'one'); v.save('2026-01-02', 'two');
  const [n1, n2] = v.localNames();
  const flipped = Buffer.from(v.readRaw(n1)); flipped[flipped.length - 1] ^= 1;
  assert.throws(() => v.applyRemote(n1, flipped));
  assert.throws(() => v.applyRemote(n1, v.readRaw(n2)));
});

test('edits travel between two devices through Drive', async () => {
  const { g, a, b } = await twoDevices();
  assert.equal(b.get('2026-01-01').text, 'seed');
  a.save('2026-02-02', 'from A', 0); await syncOnce(a, g.drive());
  const r = await syncOnce(b, g.drive());
  assert.deepEqual(r.changedDates, ['2026-02-02']);
  assert.equal(b.get('2026-02-02').text, 'from A');
});

test('Drive only ever holds ciphertext', async () => {
  const { g, a } = await twoDevices();
  a.save('2026-02-02', 'plaintextmarker', 0); await syncOnce(a, g.drive());
  for (const f of g.files.values()) {
    const s = (f.bytes ? f.bytes.toString('latin1') : '') + f.name;
    assert.ok(!s.includes('plaintextmarker') && !s.includes('2026-02-02') && !s.includes('seed'));
  }
});

test('both devices editing one day keeps both versions and converges', async () => {
  const { g, a, b } = await twoDevices();
  a.save('2026-01-01', 'A version', a.get('2026-01-01').updatedAt);
  await new Promise((r) => setTimeout(r, 5));
  b.save('2026-01-01', 'B version', b.get('2026-01-01').updatedAt);
  await syncOnce(a, g.drive()); await syncOnce(b, g.drive()); await syncOnce(a, g.drive());
  const t = a.get('2026-01-01').text;
  assert.ok(t.includes('A version') && t.includes('B version'));
  assert.equal(t, b.get('2026-01-01').text);
  const before = [...g.files.values()].map((f) => f.bytes && md5(f.bytes)).join();
  await syncOnce(a, g.drive()); await syncOnce(b, g.drive());
  assert.equal(before, [...g.files.values()].map((f) => f.bytes && md5(f.bytes)).join(), 'no endless re-uploads');
});

test('typing during a sync update keeps both texts', async () => {
  const v = new Vault(tmp(), FAST); await v.create(PASS);
  const e = v.save('2026-03-03', 'first');
  v.put('2026-03-03', 'came from sync', e.updatedAt + 1);
  const saved = v.save('2026-03-03', 'typed here', e.updatedAt);
  assert.ok(saved.text.includes('typed here') && saved.text.includes('came from sync'));
});

test('offline edits catch up later', async () => {
  const { g, a, b } = await twoDevices();
  fakeGoogle.offline = true;
  a.save('2026-04-04', 'offline', 0);
  await assert.rejects(syncOnce(a, g.drive()));
  fakeGoogle.offline = false;
  await syncOnce(a, g.drive()); await syncOnce(b, g.drive());
  assert.equal(b.get('2026-04-04').text, 'offline');
});

test('different notebook on Drive stops sync without touching anything', async () => {
  const { g } = await twoDevices();
  const c = new Vault(tmp(), FAST); await c.create('another long passphrase');
  c.put('2026-05-05', 'mine');
  const count = g.files.size;
  await assert.rejects(syncOnce(c, g.drive()), /different RabbitNote/);
  assert.equal(g.files.size, count);
  assert.equal(c.get('2026-05-05').text, 'mine');
});

test('passphrase change reaches the other device', async () => {
  const { g, a, b } = await twoDevices();
  await new Promise((r) => setTimeout(r, 5));
  await a.changePassphrase(PASS, 'a brand new passphrase');
  await syncOnce(a, g.drive()); await syncOnce(b, g.drive());
  b.lock();
  await assert.rejects(b.unlock(PASS), /not correct/);
  await b.unlock('a brand new passphrase');
  assert.equal(b.get('2026-01-01').text, 'seed');
});

test('tags ignore links and headings-in-words', () => {
  assert.deepEqual(tagsOf('#work and #Ideas, http://x.com/#frag a#b'), ['work', 'ideas']);
});

test('Google sign-in: rejects wrong state, exchanges code with PKCE', async () => {
  const { signIn } = require('../src/main/drive');
  const creds = { clientId: 'c', clientSecret: 's' };
  const realFetch = globalThis.fetch;
  let sent;
  const tokenFetch = async (_u, o) => { sent = o.body; return res(200, JSON.stringify({ refresh_token: 'RT' })); };
  const token = await signIn(creds, async (url) => {
    const u = new URL(url);
    assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
    const back = new URL(u.searchParams.get('redirect_uri'));
    back.searchParams.set('code', 'abc'); back.searchParams.set('state', u.searchParams.get('state'));
    await realFetch(back);
  }, tokenFetch);
  assert.equal(token, 'RT');
  assert.ok(sent.get('code_verifier').length > 40);
  await assert.rejects(signIn(creds, async (url) => {
    const u = new URL(url); const back = new URL(u.searchParams.get('redirect_uri'));
    back.searchParams.set('code', 'abc'); back.searchParams.set('state', 'forged');
    await realFetch(back);
  }, tokenFetch), /cancelled/);
});

test('images: encrypted, deduplicated, synced to the other device, tamper-proof', async () => {
  const { g, a, b } = await twoDevices();
  const bytes = Buffer.concat([Buffer.from('RIFF0000WEBP'), crypto.randomBytes(3000)]);
  const id = a.addImage(bytes);
  assert.equal(a.addImage(bytes), id);
  a.save('2026-06-06', `hello [[img:${id}]] world`, 0);
  await syncOnce(a, g.drive());
  const onDrive = [...g.files.values()].find((f) => f.name === `${id}.rni`);
  assert.ok(onDrive && !onDrive.bytes.includes(bytes.subarray(12, 200)));
  const r = await syncOnce(b, g.drive());
  assert.ok(r.imagesArrived);
  assert.ok(b.getImage(id).equals(bytes));
  const bad = Buffer.from(onDrive.bytes); bad[bad.length - 1] ^= 1;
  assert.throws(() => b.applyRemoteImage(`${id}.rni`, bad));
  assert.equal(b.search('hello world').length, 0);
  assert.ok(!b.search('world')[0].snippet.includes('img:'));
  assert.ok(b.exportText().includes(`[image: ${id}.webp]`));
  assert.deepEqual(b.exportImages(), [id]);
});

test('theme syncs, newest wins, stays out of notes', async () => {
  const { g, a, b } = await twoDevices();
  a.setTheme({ colors: { paper: '#ffffff' }, font: { builtin: 'book' } });
  await syncOnce(a, g.drive());
  const r = await syncOnce(b, g.drive());
  assert.ok(r.changedDates.includes('0000-00-00'));
  assert.equal(b.getTheme().colors.paper, '#ffffff');
  a.setTheme({ colors: { paper: '#111111' }, font: {} });
  await new Promise((x) => setTimeout(x, 5));
  b.setTheme({ colors: { paper: '#222222' }, font: {} });
  await syncOnce(a, g.drive()); await syncOnce(b, g.drive()); await syncOnce(a, g.drive());
  assert.equal(a.getTheme().colors.paper, '#222222');
  assert.equal(b.getTheme().colors.paper, '#222222');
  assert.ok(!b.overview().days.includes('0000-00-00'));
  assert.ok(!b.exportText().includes('paper'));
  assert.equal(b.search('paper').length, 0);
});

test('Google font: picks latin slices, caches for offline, rejects bad names and hosts', async () => {
  const { getFont, parseCss } = require('../src/main/fonts');
  const css = `/* cyrillic */\n@font-face { font-family:'X'; src:url(https://fonts.gstatic.com/c.woff2) format('woff2'); unicode-range: U+0400; }\n/* latin */\n@font-face { font-family:'X'; src:url(https://fonts.gstatic.com/l.woff2) format('woff2'); unicode-range: U+0000-00FF; }\n@font-face { src:url(https://evil.example/x.woff2); }`;
  assert.deepEqual(parseCss(css).map((f) => f.url), ['https://fonts.gstatic.com/l.woff2']);
  assert.equal(parseCss(`@font-face { src: url(https://fonts.gstatic.com/a.ttf) format('truetype'); }`).length, 1);
  let calls = 0;
  const f = async (u) => { calls++; return u.includes('css2') ? res(200, css) : res(200, Buffer.from('FONT')); };
  const dir = tmp();
  const faces = await getFont('Open Sans', dir, f);
  assert.equal(Buffer.from(faces[0].data).toString(), 'FONT');
  const n = calls;
  await getFont('Open Sans', dir, async () => { throw new Error('offline'); });
  assert.equal(calls, n);
  await assert.rejects(getFont('../../etc', dir, f), /not a Google font/);
});

test('backup file stays encrypted and restores on a new computer with the passphrase', async () => {
  const a = new Vault(tmp(), FAST); await a.create(PASS);
  const img = Buffer.concat([Buffer.from('RIFF0000WEBP'), crypto.randomBytes(2000)]);
  const id = a.addImage(img);
  a.save('2026-07-07', `secretbackupword [[img:${id}]]`);
  a.setTheme({ colors: { paper: '#ffffff' }, font: {} });
  const f = path.join(tmp(), 'x.rnbackup');
  a.writeBackup(f);
  assert.ok(!fs.readFileSync(f, 'latin1').includes('secretbackupword'));
  assert.ok(!Buffer.from(fs.readFileSync(f, 'latin1').split('\n')[2].split('\t')[1], 'base64').toString('latin1').includes('secretbackupword'));
  const b = new Vault(tmp(), FAST);
  await b.restoreBackup(f);
  await assert.rejects(b.unlock('wrong passphrase!!'), /not correct/);
  await b.unlock(PASS);
  assert.ok(b.get('2026-07-07').text.includes('secretbackupword'));
  assert.ok(b.getImage(id).equals(img));
  assert.equal(b.getTheme().colors.paper, '#ffffff');
  await assert.rejects(b.restoreBackup(f), /already has/);
  const bad = path.join(tmp(), 'bad.rnbackup'); fs.writeFileSync(bad, 'hello\n');
  await assert.rejects(new Vault(tmp(), FAST).restoreBackup(bad), /not a RabbitNote backup/);
});

test('formatting markers never leak into tags, search or export', async () => {
  const { plainText } = require('../src/main/vault');
  const table = Buffer.from(JSON.stringify([['Cat', '#petstuff'], ['needle', '2']])).toString('base64url');
  const draw = Buffer.from(JSON.stringify([{ c: '#123456', w: 2, p: [1, 2] }])).toString('base64url');
  const text = `[[b]]bold[[/b]] [[hl:#ffe45c]]bright #real[[/hl]] [[tape:#78aab2]]Title[[/tape]] [[table:${table}]] [[draw:${draw}]]`;
  assert.deepEqual(tagsOf(text).sort(), ['petstuff', 'real']);
  const p = plainText(text);
  assert.ok(p.includes('bold') && p.includes('Title') && p.includes('needle') && !p.includes('[[') && !p.includes('ffe45c'));
  const v = new Vault(tmp(), FAST); await v.create(PASS);
  v.save('2026-08-08', text);
  assert.equal(v.search('ffe45c').length, 0);
  assert.equal(v.search('needle').length, 1);
  assert.equal(v.search('bright #real').length, 1);
  assert.ok(!v.exportText().includes('[[hl'));
  assert.ok(!v.exportText().includes('[[draw'));
});
