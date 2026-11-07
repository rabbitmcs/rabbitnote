'use strict';
const http = require('http');
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const TOKEN = 'https://oauth2.googleapis.com/token';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER = 'RabbitNote';

const b64url = (b) => b.toString('base64url');

// Sign-in through the person's browser, returning to a one-time local address (PKCE).
function signIn(creds, openExternal, fetchFn = fetch) {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  return new Promise((resolve, reject) => {
    const finish = (err, val) => { clearTimeout(timer); server.close(); err ? reject(err) : resolve(val); };
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/') { res.writeHead(404); return res.end(); }
      const code = url.searchParams.get('code');
      const good = code && url.searchParams.get('state') === state;
      res.writeHead(good ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(good ? 'RabbitNote is connected. You can close this tab.' : 'Sign-in did not finish. Go back to RabbitNote and try again.');
      if (!good) return finish(new Error('Google sign-in was cancelled.'));
      try {
        const r = await fetchFn(TOKEN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code, code_verifier: verifier, grant_type: 'authorization_code',
            client_id: creds.clientId, client_secret: creds.clientSecret,
            redirect_uri: `http://127.0.0.1:${server.address().port}`,
          }),
        });
        const j = await r.json();
        if (!r.ok || !j.refresh_token) throw new Error(j.error_description || 'Google did not grant access.');
        finish(null, j.refresh_token);
      } catch (e) { finish(e); }
    });
    const timer = setTimeout(() => finish(new Error('Google sign-in timed out. Try again.')), 5 * 60 * 1000);
    server.on('error', (e) => finish(e));
    server.listen(0, '127.0.0.1', () => {
      const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      Object.entries({
        client_id: creds.clientId, redirect_uri: `http://127.0.0.1:${server.address().port}`,
        response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent',
        code_challenge: challenge, code_challenge_method: 'S256', state,
      }).forEach(([k, v]) => u.searchParams.set(k, v));
      openExternal(u.toString());
    });
  });
}

class Drive {
  constructor(creds, refreshToken, fetchFn = fetch) {
    Object.assign(this, { creds, refreshToken, fetchFn, accessToken: null, expires: 0, folderId: null });
  }

  async token() {
    if (this.accessToken && Date.now() < this.expires) return this.accessToken;
    const r = await this.fetchFn(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: this.refreshToken,
        client_id: this.creds.clientId, client_secret: this.creds.clientSecret,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error('Google sign-in has expired. Reconnect Google Drive in Settings.');
      e.auth = true;
      throw e;
    }
    this.accessToken = j.access_token;
    this.expires = Date.now() + (j.expires_in - 60) * 1000;
    return this.accessToken;
  }

  async req(url, opts = {}, retry = true) {
    const r = await this.fetchFn(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${await this.token()}` } });
    if (r.status === 401 && retry) { this.accessToken = null; return this.req(url, opts, false); }
    if (!r.ok) {
      const e = new Error(`Google Drive returned an error (${r.status}).`);
      e.offline = r.status === 429 || r.status >= 500 || r.status === 403;
      throw e;
    }
    return r;
  }

  async findFolder() {
    const q = `name='${FOLDER}' and mimeType='${FOLDER_MIME}' and trashed=false`;
    const r = await this.req(`${API}?q=${encodeURIComponent(q)}&fields=files(id)&orderBy=createdTime`);
    const { files } = await r.json();
    return files.length ? files[0].id : null;
  }

  async folder({ create = true } = {}) {
    if (this.folderId) return this.folderId;
    let id = await this.findFolder();
    if (!id && create) {
      const r = await this.req(`${API}?fields=id`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: FOLDER, mimeType: FOLDER_MIME }),
      });
      id = (await r.json()).id;
    }
    this.folderId = id;
    return id;
  }

  async list() {
    const parent = await this.folder();
    const out = [];
    let page = '';
    do {
      const q = encodeURIComponent(`'${parent}' in parents and trashed=false`);
      const r = await this.req(`${API}?q=${q}&pageSize=1000&fields=${encodeURIComponent('nextPageToken,files(id,name,md5Checksum)')}${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
      const j = await r.json();
      j.files.forEach((f) => out.push({ id: f.id, name: f.name, md5: f.md5Checksum }));
      page = j.nextPageToken;
    } while (page);
    return out;
  }

  async download(id) {
    const r = await this.req(`${API}/${encodeURIComponent(id)}?alt=media`);
    return Buffer.from(await r.arrayBuffer());
  }

  async upload(name, bytes, existingId) {
    if (existingId) {
      const r = await this.req(`${UPLOAD}/${encodeURIComponent(existingId)}?uploadType=media&fields=id,md5Checksum`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
      });
      const j = await r.json();
      return { id: j.id, md5: j.md5Checksum };
    }
    const parent = await this.folder();
    const boundary = `rn${crypto.randomBytes(12).toString('hex')}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parent] })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const r = await this.req(`${UPLOAD}?uploadType=multipart&fields=id,md5Checksum`, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    });
    const j = await r.json();
    return { id: j.id, md5: j.md5Checksum };
  }
}

module.exports = { signIn, Drive };
