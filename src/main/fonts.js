'use strict';
// Downloads a Google font once and keeps it, so it still works offline.
const fs = require('fs');
const path = require('path');

const NAME_RE = /^[\p{L}\p{N} '-]{1,80}$/u;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_FACES = 12;
const WANTED = new Set(['latin', 'latin-ext', 'vietnamese']);

function parseCss(css) {
  const all = [];
  for (const m of css.matchAll(/(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g)) {
    const url = m[2].match(/url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+)\)/);
    if (!url) continue;
    const range = m[2].match(/unicode-range:\s*([^;]+);/);
    all.push({ subset: m[1] || null, url: url[1], unicodeRange: range ? range[1].trim() : undefined });
  }
  const wanted = all.filter((f) => !f.subset || WANTED.has(f.subset));
  return (wanted.length ? wanted : all).slice(0, MAX_FACES);
}

async function getFont(name, cacheDir, fetchFn) {
  if (!NAME_RE.test(name)) throw new Error('That is not a Google font name.');
  const dir = path.join(cacheDir, name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-'));
  const index = path.join(dir, 'faces.json');
  if (!fs.existsSync(index)) {
    const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, '+')}&display=swap`;
    const r = await fetchFn(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`Google Fonts doesn't have "${name}".`);
    const faces = parseCss(await r.text());
    if (!faces.length) throw new Error(`Google Fonts doesn't have "${name}".`);
    const out = [];
    const files = [];
    for (let i = 0; i < faces.length; i++) {
      const fr = await fetchFn(faces[i].url);
      if (!fr.ok) throw new Error(`Could not download "${name}".`);
      files.push(Buffer.from(await fr.arrayBuffer()));
      out.push({ file: `${i}.font`, unicodeRange: faces[i].unicodeRange });
    }
    fs.mkdirSync(dir, { recursive: true });
    files.forEach((b, i) => fs.writeFileSync(path.join(dir, out[i].file), b));
    fs.writeFileSync(index, JSON.stringify(out));
  }
  return JSON.parse(fs.readFileSync(index, 'utf8')).map((f) => ({ unicodeRange: f.unicodeRange, data: new Uint8Array(fs.readFileSync(path.join(dir, path.basename(f.file)))) }));
}

module.exports = { getFont, parseCss };
