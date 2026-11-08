'use strict';
const $ = (id) => document.getElementById(id);
const call = window.rn.call;

const pad2 = (n) => String(n).padStart(2, '0');
const toStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fromStr = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayStr = () => toStr(new Date());

const IMG_RE = /\[\[img:([a-f0-9]{40})\]\]/g;
const LINE = 32;
const HL_COLORS = ['#ffe45c', '#ffb3c7', '#b5ec9a', '#a9dcf5', '#ffc27a'];
const MAX_PIC = 480;
const ed = $('editor');
const COLORS = [
  ['paper', 'Page', '#f7eebb'], ['kraft', 'Background', '#b39467'], ['ink', 'Text', '#1f2c55'], ['rule', 'Lines', '#a9bfd0'],
  ['margin', 'Margin line', '#d98c86'], ['caret', 'Cursor', '#b22a1e'], ['kraft-ink', 'Sidebar text', '#2b2014'], ['stitch', 'Stitching', '#f7eebb'],
  ['tape', 'Date tape', '#78aab2'], ['tape-ink', 'Date text', '#18243f'], ['paper-edge', 'Page edge', '#e9dc9d'], ['kraft-deep', 'Background shade', '#9b7d53'],
  ['err', 'Error messages', '#8e1f16'],
];

setTimeout(() => setHlColor(HL_COLORS[0]));
const S = window.S = { popKind: null, strokes: [], drawing: false, erasing: false, penW: 2, pen: null, hl: HL_COLORS[0], date: todayStr(), base: 0, loaded: '', view: new Date(), days: new Set(), tags: {}, timer: null, status: { state: 'off' }, gateMode: 'unlock', opening: false };

// ---------- theme ----------
let theme = { colors: {}, font: { builtin: 'typewriter' }, imageTape: true, toolProps: true };
const loadedFonts = new Set();

function applyColors() {
  for (const [k, , d] of COLORS) document.documentElement.style.setProperty(`--${k}`, theme.colors[k] || d);
}
async function alignRules() {
  const cs = getComputedStyle(document.body);
  const fam = cs.getPropertyValue('--text-font').trim();
  const size = cs.getPropertyValue('--text-size').trim();
  try { await document.fonts.load(`${size} ${fam}`, 'Hxg'); } catch { /* falls back to measuring the fallback font */ }
  const m = document.createElement('canvas').getContext('2d');
  m.font = `${size} ${fam}`;
  const t = m.measureText('Hxg');
  const baseline = (LINE - (t.fontBoundingBoxAscent + t.fontBoundingBoxDescent)) / 2 + t.fontBoundingBoxAscent;
  document.body.style.setProperty('--rule-shift', `${Math.round(baseline + 5 - (LINE - 1))}px`);
}
async function applyFont() {
  const f = theme.font || {};
  $('gfMsg').textContent = '';
  if (f.google) {
    try {
      if (!loadedFonts.has(f.google)) {
        const faces = await call('loadFont', f.google);
        await Promise.all(faces.map(async (x) => { const ff = new FontFace(f.google, x.data.buffer || x.data, x.unicodeRange ? { unicodeRange: x.unicodeRange } : {}); document.fonts.add(await ff.load()); }));
        loadedFonts.add(f.google);
      }
      document.body.dataset.font = 'google';
      document.body.style.setProperty('--text-font', `"${f.google}", serif`);
    } catch (e) {
      document.body.dataset.font = 'typewriter';
      document.body.style.removeProperty('--text-font');
      $('gfMsg').textContent = `Could not load ${f.google}. Check your connection and choose it again.`;
    }
  } else {
    document.body.style.removeProperty('--text-font');
    document.body.dataset.font = f.builtin || 'typewriter';
  }
  await alignRules();
}
function setThemeLocal(t) {
  theme = { colors: { ...(t?.colors || {}) }, font: t?.font || { builtin: 'typewriter' }, imageTape: t?.imageTape !== false, toolProps: t?.toolProps !== false };
  applyColors();
  document.body.dataset.picTape = theme.imageTape ? 'on' : 'off';
  return applyFont();
}
let themeTimer = null;
function saveTheme() { clearTimeout(themeTimer); themeTimer = setTimeout(() => call('setTheme', theme), 300); }
window.rn.on('theme-changed', (t) => { setThemeLocal(t); if ($('settings').open) renderThemeControls(); });

function renderThemeControls() {
  document.querySelectorAll('input[name=font]').forEach((r) => { r.checked = !theme.font.google && r.value === (theme.font.builtin || 'typewriter'); });
  $('gfInput').value = theme.font.google || '';
  $('imgTape').checked = theme.imageTape;
  $('toolProps').checked = theme.toolProps;
  const box = $('colors');
  if (!box.children.length) {
    for (const [k, label] of COLORS) {
      const l = document.createElement('label'); l.textContent = label;
      const i = document.createElement('input'); i.type = 'color'; i.dataset.key = k;
      i.addEventListener('input', () => { theme.colors[k] = i.value; applyColors(); saveTheme(); });
      l.append(i); box.append(l);
    }
  }
  box.querySelectorAll('input').forEach((i) => { i.value = theme.colors[i.dataset.key] || COLORS.find((c) => c[0] === i.dataset.key)[2]; });
}

// ---------- editor: plain text with images held as [[img:id]] markers ----------
function makePic(id) {
  const s = document.createElement('span');
  s.className = 'pic'; s.contentEditable = 'false'; s.dataset.img = id;
  return s;
}
const b64 = (str) => { const u = new TextEncoder().encode(str); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64 = (t) => { const s = atob(t.replace(/-/g, '+').replace(/_/g, '/')); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return new TextDecoder().decode(u); };
const TOKEN = /\[\[(img:[a-f0-9]{40}|\/?[biu]|hl:#[0-9a-fA-F]{6}|\/hl|tape:#[0-9a-fA-F]{6}|\/tape|table:[A-Za-z0-9_-]*|draw:[A-Za-z0-9_-]*)\]\]/g;
const plainOf = (t) => t.replace(TOKEN, (m, k) => {
  if (k.startsWith('table:')) { try { return ` ${JSON.parse(unb64(k.slice(6))).flat().join(' ')} `; } catch { return ' '; } }
  return k.startsWith('img:') || k.startsWith('draw:') ? ' ' : '';
});

function makeTapeTitle(color, text) {
  const d = document.createElement('div');
  d.className = 'tape-title'; d.dataset.color = color; d.style.setProperty('--c', color); d.textContent = text || '';
  return d;
}
function makeTable(rows) {
  const w = document.createElement('div'); w.className = 'sk-table'; w.contentEditable = 'false';
  const t = document.createElement('table');
  rows.forEach((r) => {
    const tr = t.insertRow();
    r.forEach((c) => { const td = tr.insertCell(); td.contentEditable = 'true'; td.textContent = c; });
  });
  w.append(t);
  return w;
}
const tableData = (w) => [...w.querySelector('table').rows].map((r) => [...r.cells].map((c) => c.innerText.replace(/\n$/, '')));

function parseInto(text) {
  const stack = [ed];
  const top = () => stack[stack.length - 1];
  const open = (el, tag) => { el.dataset.tok = tag; top().append(el); stack.push(el); };
  const close = (tag) => { for (let i = stack.length - 1; i > 0; i--) if (stack[i].dataset.tok === tag) { stack.length = i; return; } };
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > at) top().append(document.createTextNode(text.slice(at, m.index)));
    at = m.index + m[0].length;
    const k = m[1];
    if (k.startsWith('img:')) top().append(makePic(k.slice(4)));
    else if (k === 'b' || k === 'i' || k === 'u') open(document.createElement(k), k);
    else if (k === '/b' || k === '/i' || k === '/u') close(k.slice(1));
    else if (k.startsWith('hl:')) { const s = document.createElement('span'); s.style.backgroundColor = k.slice(3); open(s, 'hl'); }
    else if (k === '/hl') close('hl');
    else if (k.startsWith('tape:')) { const d = makeTapeTitle(k.slice(5)); open(d, 'tape'); }
    else if (k === '/tape') close('tape');
    else if (k.startsWith('table:')) { try { top().append(makeTable(JSON.parse(unb64(k.slice(6))))); } catch { /* unreadable table is skipped */ } }
    else if (k.startsWith('draw:')) { try { S.strokes.push(...JSON.parse(unb64(k.slice(5)))); } catch { /* unreadable drawing is skipped */ } }
  }
  if (at < text.length) top().append(document.createTextNode(text.slice(at)));
}
function setEditor(text) {
  ed.textContent = '';
  S.strokes = [];
  parseInto(text);
  ed.querySelectorAll('[data-tok]').forEach((n) => n.removeAttribute('data-tok'));
  const last = ed.lastChild;
  if (last?.classList?.contains('pic') || last?.classList?.contains('sk-table') || last?.classList?.contains('tape-title')) ed.append(document.createTextNode('\n'));
  ed.classList.toggle('empty', !text);
  hydratePics();
  renderInk();
  sketchTables();
}
const toHex = (c) => {
  const m = String(c).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!m || m[4] === '0') return null;
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
};
function serial(node) {
  let out = '';
  node.childNodes.forEach((n, i) => {
    if (n.nodeType === 3) { out += n.data; return; }
    if (n.nodeType !== 1 || n.classList.contains('ink')) return;
    if (n.nodeName === 'BR') { out += '\n'; return; }
    if (n.classList.contains('pic')) { out += `[[img:${n.dataset.img}]]`; return; }
    if (n.classList.contains('tape-title')) { out += `[[tape:${n.dataset.color}]]${n.textContent.replace(/\n/g, ' ')}[[/tape]]`; return; }
    if (n.classList.contains('sk-table')) { out += `[[table:${b64(JSON.stringify(tableData(n)))}]]`; return; }
    let inner = serial(n);
    if (!inner) return;
    const st = n.style; const name = n.nodeName;
    const hl = toHex(st.backgroundColor);
    if (hl) inner = `[[hl:${hl}]]${inner}[[/hl]]`;
    if (name === 'U' || (st.textDecorationLine || st.textDecoration || '').includes('underline')) inner = `[[u]]${inner}[[/u]]`;
    if (name === 'I' || name === 'EM' || st.fontStyle === 'italic') inner = `[[i]]${inner}[[/i]]`;
    if (name === 'B' || name === 'STRONG' || st.fontWeight === 'bold' || Number(st.fontWeight) >= 600) inner = `[[b]]${inner}[[/b]]`;
    out += (i && ['DIV', 'P'].includes(name) ? '\n' : '') + inner;
  });
  return out;
}
function getEditor() {
  const kids = [...ed.childNodes].filter((n) => !n.classList?.contains('ink'));
  let t = serial(ed);
  if (kids[kids.length - 1]?.nodeName === 'BR') t = t.slice(0, -1);
  return t + (S.strokes.length ? `[[draw:${b64(JSON.stringify(S.strokes))}]]` : '');
}

// ---------- hand-drawn table lines ----------
function wobble(x1, y1, x2, y2, seed) {
  let r = seed * 9301 + 49297;
  const rnd = () => { r = (r * 9301 + 49297) % 233280; return r / 233280 - 0.5; };
  const len = Math.hypot(x2 - x1, y2 - y1);
  const n = Math.max(2, Math.round(len / 46));
  const dx = (x2 - x1) / len; const dy = (y2 - y1) / len;
  let d = `M${(x1 - dx * 3 + rnd() * 2).toFixed(1)} ${(y1 - dy * 3 + rnd() * 2).toFixed(1)}`;
  for (let i = 1; i <= n; i++) {
    const f = i / n;
    d += `L${(x1 + (x2 - x1) * f + rnd() * 2.2).toFixed(1)} ${(y1 + (y2 - y1) * f + rnd() * 2.2).toFixed(1)}`;
  }
  return d;
}
const tableWatch = new ResizeObserver((es) => es.forEach((e) => sketchOne(e.target.closest('.sk-table'))));
function sketchOne(w) {
  if (!w || !w.isConnected) return;
  const t = w.querySelector('table');
  if (!t.rows.length) return;
  let svg = w.querySelector('.sk-lines');
  if (!svg) { svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'sk-lines'); w.append(svg); }
  const R = w.getBoundingClientRect(); const W = R.width; const H = R.height;
  const xs = [0]; const ys = [0];
  [...t.rows[0].cells].forEach((c) => xs.push(c.getBoundingClientRect().right - R.left));
  [...t.rows].forEach((r) => ys.push(r.getBoundingClientRect().bottom - R.top));
  let d = '';
  ys.forEach((y, i) => { d += wobble(0, y, W, y, i + 1); });
  xs.forEach((x, i) => { d += wobble(x, 0, x, H, i + 31); });
  svg.innerHTML = '';
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); svg.append(p);
}
function sketchTables() {
  ed.querySelectorAll('.sk-table').forEach((w) => { tableWatch.observe(w.querySelector('table')); sketchOne(w); });
}

// ---------- free drawing ----------
const SVGNS = 'http://www.w3.org/2000/svg';
function strokePath(s) {
  const p = s.p; let d = `M${p[0]} ${p[1]}`;
  if (p.length === 2) d += `l.1 .1`;
  for (let i = 2; i < p.length - 2; i += 2) d += `Q${p[i]} ${p[i + 1]} ${(p[i] + p[i + 2]) / 2} ${(p[i + 1] + p[i + 3]) / 2}`;
  if (p.length > 2) d += `L${p[p.length - 2]} ${p[p.length - 1]}`;
  const el = document.createElementNS(SVGNS, 'path');
  el.setAttribute('d', d); el.setAttribute('stroke', s.c); el.setAttribute('stroke-width', s.w);
  return el;
}
const inkBox = $('inkBox');
function inkEl() { return $('inkSvg'); }
function sizeInk() {
  const svg = inkEl();
  svg.style.height = `${ed.scrollHeight}px`;
  svg.style.transform = `translateY(${-ed.scrollTop}px)`;
}
ed.addEventListener('scroll', () => { inkEl().style.transform = `translateY(${-ed.scrollTop}px)`; });
function renderInk() {
  const svg = inkEl();
  svg.textContent = '';
  S.strokes.forEach((s) => svg.append(strokePath(s)));
  sizeInk();
}
function sizePic(pic) {
  const img = pic.querySelector('img');
  if (!img || !img.naturalWidth) return;
  const c = getComputedStyle(ed);
  const room = ed.clientWidth - parseFloat(c.paddingLeft) - parseFloat(c.paddingRight) - 12;
  const scale = Math.min(1, room / img.naturalWidth, MAX_PIC / img.naturalHeight);
  // Height snaps to whole ruled lines so writing below stays on the lines.
  const lines = Math.max(2, Math.floor((img.naturalHeight * scale + 10) / LINE));
  img.style.height = `${lines * LINE - 10}px`;
  img.style.width = 'auto';
}
function hydratePics() {
  ed.querySelectorAll('.pic').forEach(async (pic) => {
    if (pic.querySelector('img')) return;
    const id = pic.dataset.img;
    let url = null;
    try { url = await call('getImage', id); } catch { /* shown as missing below */ }
    if (!pic.isConnected || pic.querySelector('img')) return;
    pic.textContent = '';
    if (!url) { pic.classList.add('missing'); pic.textContent = 'This image is still syncing.'; return; }
    pic.classList.remove('missing');
    const img = document.createElement('img');
    img.alt = ''; img.draggable = false;
    img.onload = () => sizePic(pic);
    img.src = url;
    const x = document.createElement('button');
    x.className = 'pic-x'; x.type = 'button'; x.textContent = '×'; x.title = 'Remove image'; x.setAttribute('aria-label', 'Remove image');
    x.addEventListener('mousedown', (ev) => ev.stopPropagation());
    x.onclick = () => {
      const hasText = (n) => !!n && !!(n.textContent || '').trim();
      const between = hasText(pic.previousSibling) && hasText(pic.nextSibling);
      ed.focus();
      const r = document.createRange(); r.selectNode(pic);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      document.execCommand('delete');
      if (between) document.execCommand('insertLineBreak'); // keep the lines around it apart
    };
    pic.append(img, x);
  });
}
new ResizeObserver(() => ed.querySelectorAll('.pic').forEach(sizePic)).observe(ed);

let lastRange = null;
document.addEventListener('selectionchange', () => {
  const s = getSelection();
  if (s.rangeCount && ed.contains(s.anchorNode)) lastRange = s.getRangeAt(0).cloneRange();
});
function caretAtEnd() {
  const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
async function insertImages(files) {
  for (const file of files) {
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      const blob = await new Promise((res) => cv.toBlob(res, 'image/webp', 0.85));
      const id = await call('addImage', new Uint8Array(await blob.arrayBuffer()));
      ed.focus();
      const s = getSelection();
      if (lastRange && ed.contains(lastRange.startContainer)) { s.removeAllRanges(); s.addRange(lastRange); } else caretAtEnd();
      document.execCommand('insertHTML', false, `<span class="pic" contenteditable="false" data-img="${id}"></span>`);
      // Put the cursor on the line under the new picture.
      const pics = ed.querySelectorAll(`.pic[data-img="${id}"]`);
      const added = pics[pics.length - 1];
      let after = added?.nextSibling;
      if (added && after?.nodeType !== 3) { after = document.createTextNode('\n'); added.after(after); }
      else if (after && !after.data) after.data = '\n'; // an empty text node can't hold the cursor
      if (after) { const c = getSelection(); c.collapse(after, 0); lastRange = c.getRangeAt(0).cloneRange(); }
      ed.classList.remove('empty');
      hydratePics();
      onEdit();
    } catch (e) { updateFoot(`Could not add ${file.name || 'that image'}. Use a JPG, PNG, WebP or GIF file.`); }
  }
}
function onEdit() {
  ed.classList.toggle('empty', !getEditor());
  hydratePics();
  sizeInk();
  sketchTables();
  updateFoot('');
  clearTimeout(S.timer);
  S.timer = setTimeout(flush, 700);
}
ed.addEventListener('input', onEdit);
ed.addEventListener('blur', () => flush());
ed.addEventListener('keydown', (e) => {
  const here = getSelection().anchorNode;
  const el = here?.nodeType === 1 ? here : here?.parentElement;
  const tape = el?.closest?.('.tape-title');
  const cell = el?.closest?.('td');
  if (e.key === 'Enter' && tape) { e.preventDefault(); caretAfter(tape); return; }
  if (e.key === 'Backspace' && tape && !tape.textContent) { e.preventDefault(); const n = tape.nextSibling; tape.remove(); if (n) getSelection().collapse(n, 0); onEdit(); return; }
  if (e.key === 'Tab' && cell) {
    e.preventDefault();
    const cells = [...cell.closest('table').querySelectorAll('td')];
    const next = cells[cells.indexOf(cell) + (e.shiftKey ? -1 : 1)];
    if (next) { next.focus(); getSelection().selectAllChildren(next); getSelection().collapseToEnd(); }
    else caretAfter(cell.closest('.sk-table'));
    return;
  }
  if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertLineBreak'); }
});
ed.addEventListener('paste', (e) => {
  e.preventDefault();
  const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
  const inCell = getSelection().anchorNode?.parentElement?.closest?.('td, .tape-title') || getSelection().anchorNode?.closest?.('td, .tape-title');
  if (files.length && !inCell) insertImages(files);
  else if (!files.length) document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
});
ed.addEventListener('dragover', (e) => e.preventDefault());
ed.addEventListener('drop', (e) => {
  e.preventDefault();
  const r = document.caretRangeFromPoint(e.clientX, e.clientY);
  if (r) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); lastRange = r.cloneRange(); }
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
  if (files.length) insertImages(files);
  else { const t = e.dataTransfer.getData('text/plain'); if (t) document.execCommand('insertText', false, t); }
});
// ---------- tool props ----------
const propBox = $('prop');
Object.entries(window.PROPS).forEach(([k, svg]) => {
  propBox.insertAdjacentHTML('beforeend', svg);
  propBox.lastElementChild.setAttribute('class', `p-${k}`);
});
let propLinger = null; let propTimer = null;
function wantedProp() {
  if (S.drawing) return 'pencil';
  if (S.popKind) return S.popKind;
  if (propLinger) return propLinger;
  const n = getSelection().anchorNode; const el = n?.nodeType === 1 ? n : n?.parentElement;
  if (el && ed.contains(el)) {
    if (el.closest('.tape-title')) return 'tape';
    if (el.closest('.sk-table')) return 'ruler';
  }
  return null;
}
function updateProp() {
  if (!theme.toolProps) { propBox.querySelectorAll('svg').forEach((s) => s.classList.remove('on')); return; }
  const w = wantedProp();
  propBox.querySelectorAll('svg').forEach((s) => s.classList.toggle('on', s.classList.contains(`p-${w}`)));
}
function lingerProp(k) { propLinger = k; clearTimeout(propTimer); propTimer = setTimeout(() => { propLinger = null; updateProp(); }, 1400); updateProp(); }
document.addEventListener('selectionchange', () => updateProp());
function setHlColor(c) {
  S.hl = c; $('tHlSwatch').style.background = c;
  document.documentElement.style.setProperty('--hl', c);
  document.documentElement.style.setProperty('--hl-dark', `color-mix(in srgb, ${c} 80%, #000)`);
}

// ---------- toolbar ----------
function restoreCaret() {
  if (S.drawing) return false;
  ed.focus();
  const s = getSelection();
  if (lastRange && ed.contains(lastRange.startContainer)) { s.removeAllRanges(); s.addRange(lastRange); } else caretAtEnd();
  return true;
}
function caretAfter(el) {
  let n = el.nextSibling;
  if (!n || n.nodeType !== 3) { n = document.createTextNode('\n'); el.after(n); } else if (!n.data) n.data = '\n';
  ed.focus();
  getSelection().collapse(n, 0);
  lastRange = getSelection().getRangeAt(0).cloneRange();
  onEdit();
}
function placeBlock(el) {
  restoreCaret();
  const here = getSelection().getRangeAt(0).startContainer;
  const boxed = (here.nodeType === 1 ? here : here.parentElement).closest('td, .tape-title');
  if (boxed) caretAfter(boxed.closest('.sk-table, .tape-title'));
  el.dataset.fresh = '1';
  document.execCommand('insertHTML', false, el.outerHTML);
  const made = ed.querySelector('[data-fresh]');
  if (made) made.removeAttribute('data-fresh');
  ed.classList.remove('empty');
  return made;
}
function fmt(cmd) { document.execCommand('styleWithCSS', false, false); restoreCaret(); document.execCommand(cmd); onEdit(); syncTools(); }
const noSteal = (b) => b.addEventListener('mousedown', (e) => e.preventDefault());
document.querySelectorAll('.tools button').forEach(noSteal);
$('tBold').onclick = () => fmt('bold');
$('tItalic').onclick = () => fmt('italic');
$('tUnder').onclick = () => fmt('underline');
function syncTools() {
  if (!ed.contains(getSelection().anchorNode)) return;
  [['tBold', 'bold'], ['tItalic', 'italic'], ['tUnder', 'underline']].forEach(([id, c]) => $(id).classList.toggle('on', document.queryCommandState(c)));
}
document.addEventListener('selectionchange', syncTools);

const pop = $('pop');
function closePop() { pop.hidden = true; pop.textContent = ''; S.popKind = null; updateProp(); }
function openPop(x, y, kind) {
  S.popKind = kind || null; updateProp();
  pop.hidden = false;
  pop.style.left = `${Math.min(x, innerWidth - pop.offsetWidth - 10)}px`;
  pop.style.top = `${Math.min(y, innerHeight - pop.offsetHeight - 10)}px`;
}
const under = (btn) => { const r = btn.getBoundingClientRect(); return [r.left, r.bottom + 4]; };
document.addEventListener('mousedown', (e) => { if (!pop.hidden && !pop.contains(e.target)) closePop(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) closePop(); });

function applyHighlight(color) {
  restoreCaret();
  document.execCommand('styleWithCSS', false, true);
  document.execCommand('hiliteColor', false, color);
  document.execCommand('styleWithCSS', false, false);
  onEdit();
}
$('tHl').onclick = () => {
  closePop();
  const row = document.createElement('div'); row.className = 'pop-row';
  HL_COLORS.forEach((c) => {
    const b = document.createElement('button'); b.className = 'hl-dot'; b.style.background = c; b.title = 'Highlight'; b.setAttribute('aria-label', `Highlight ${c}`);
    noSteal(b);
    b.onclick = () => { setHlColor(c); applyHighlight(c); closePop(); lingerProp('highlighter'); };
    row.append(b);
  });
  const none = document.createElement('button'); none.className = 'hl-dot hl-none'; none.title = 'Remove highlight'; none.setAttribute('aria-label', 'Remove highlight'); noSteal(none);
  none.onclick = () => { applyHighlight('transparent'); closePop(); };
  row.append(none);
  const row2 = document.createElement('div'); row2.className = 'pop-row';
  const l = document.createElement('label'); l.textContent = 'Custom color';
  const c = document.createElement('input'); c.type = 'color'; c.value = S.hl;
  c.oninput = () => setHlColor(c.value);
  c.onchange = () => { setHlColor(c.value); applyHighlight(c.value); closePop(); lingerProp('highlighter'); };
  l.append(c); row2.append(l);
  pop.append(row, row2);
  openPop(...under($('tHl')), 'highlighter');
};
$('tTape').onclick = () => {
  const c = getComputedStyle(document.documentElement).getPropertyValue('--tape').trim();
  const made = placeBlock(makeTapeTitle(/^#[0-9a-f]{6}$/i.test(c) ? c : '#78aab2'));
  if (made) { made.append(document.createTextNode('')); ed.focus(); getSelection().selectAllChildren(made); onEdit(); }
};
$('tTable').onclick = () => {
  closePop();
  const grid = document.createElement('div'); grid.className = 'grid-pick';
  const label = document.createElement('div'); label.className = 'grid-label'; label.textContent = 'Choose a size';
  const cells = [];
  for (let r = 1; r <= 8; r++) {
    for (let k = 1; k <= 8; k++) {
      const b = document.createElement('button'); b.setAttribute('aria-label', `${k} columns, ${r} rows`); noSteal(b);
      const mark = () => { cells.forEach((x) => x.b.classList.toggle('on', x.r <= r && x.k <= k)); label.textContent = `${k} × ${r}`; };
      b.onmouseenter = mark; b.onfocus = mark;
      b.onclick = () => {
        closePop();
        const made = placeBlock(makeTable(Array.from({ length: r }, () => Array(k).fill(''))));
        if (made) { const after = made.nextSibling; if (!after || after.nodeType !== 3) made.after(document.createTextNode('\n')); sketchTables(); made.querySelector('td').focus(); onEdit(); }
      };
      cells.push({ b, r, k }); grid.append(b);
    }
  }
  pop.append(grid, label);
  openPop(...under($('tTable')), 'ruler');
};
ed.addEventListener('contextmenu', (e) => {
  const table = e.target.closest?.('.sk-table'); const tape = e.target.closest?.('.tape-title');
  if (!table && !tape) return;
  e.preventDefault(); closePop();
  if (table) {
    const data = tableData(table);
    const row = document.createElement('div'); row.className = 'pop-row';
    const mk = (t, v) => { const l = document.createElement('label'); l.textContent = t; const i = document.createElement('input'); i.type = 'number'; i.min = 1; i.max = 30; i.value = v; l.append(i); row.append(l); return i; };
    const cols = mk('Columns', data[0].length); const rows = mk('Rows', data.length);
    const row2 = document.createElement('div'); row2.className = 'pop-row';
    const ok = document.createElement('button'); ok.className = 'btn primary'; ok.textContent = 'Resize table';
    ok.onclick = () => {
      const R = Math.min(30, Math.max(1, +rows.value || 1)); const K = Math.min(30, Math.max(1, +cols.value || 1));
      const fresh = Array.from({ length: R }, (_, r) => Array.from({ length: K }, (__, k) => data[r]?.[k] ?? ''));
      const n = makeTable(fresh); table.replaceWith(n); sketchTables(); closePop(); onEdit();
    };
    const del = document.createElement('button'); del.className = 'btn'; del.textContent = 'Delete table';
    del.onclick = () => { table.remove(); closePop(); onEdit(); };
    row2.append(ok, del); pop.append(row, row2);
  } else {
    const row = document.createElement('div'); row.className = 'pop-row';
    const l = document.createElement('label'); l.textContent = 'Tape color';
    const c = document.createElement('input'); c.type = 'color'; c.value = tape.dataset.color;
    c.oninput = () => { tape.dataset.color = c.value; tape.style.setProperty('--c', c.value); onEdit(); };
    l.append(c);
    const del = document.createElement('button'); del.className = 'btn'; del.textContent = 'Delete title';
    del.onclick = () => { tape.remove(); closePop(); onEdit(); };
    row.append(l, del); pop.append(row);
  }
  openPop(e.clientX, e.clientY, table ? 'ruler' : 'tape');
});

// Draw mode
function setDrawing(on) {
  S.drawing = on; S.erasing = false;
  inkBox.classList.toggle('drawing', on); inkBox.classList.remove('erasing');
  ed.contentEditable = on ? 'false' : 'true';
  $('tDraw').setAttribute('aria-pressed', String(on));
  $('drawErase').setAttribute('aria-pressed', 'false');
  $('drawTools').hidden = !on;
  sizeInk();
  updateProp();
  if (!on) flush();
}
$('tDraw').onclick = () => setDrawing(!S.drawing);
document.querySelectorAll('.pen-size').forEach((b) => { b.onclick = () => { S.penW = +b.dataset.w; document.querySelectorAll('.pen-size').forEach((x) => x.classList.toggle('on', x === b)); }; });
$('drawErase').onclick = () => { S.erasing = !S.erasing; inkBox.classList.toggle('erasing', S.erasing); $('drawErase').setAttribute('aria-pressed', String(S.erasing)); };
$('drawUndo').onclick = () => { S.strokes.pop(); renderInk(); onEdit(); };
function eraseAt(x, y) {
  const hit = document.elementFromPoint(x, y);
  if (hit?.nodeName !== 'path' || !hit.closest('.ink')) return;
  const i = [...hit.parentNode.children].indexOf(hit);
  if (i >= 0) { S.strokes.splice(i, 1); hit.remove(); onEdit(); }
}
inkBox.addEventListener('wheel', (e) => { ed.scrollTop += e.deltaY; }, { passive: true });
inkBox.addEventListener('pointerdown', (e) => {
  if (!S.drawing || e.button) return;
  e.preventDefault();
  inkBox.setPointerCapture(e.pointerId);
  if (S.erasing) { eraseAt(e.clientX, e.clientY); S.pen = { erase: true }; return; }
  const r = inkEl().getBoundingClientRect();
  const s = { c: $('drawColor').value, w: S.penW, p: [Math.round(e.clientX - r.left), Math.round(e.clientY - r.top)] };
  S.pen = { s, el: strokePath(s) };
  inkEl().append(S.pen.el);
});
inkBox.addEventListener('pointermove', (e) => {
  if (!S.drawing || !S.pen) return;
  if (S.pen.erase) { eraseAt(e.clientX, e.clientY); return; }
  const r = inkEl().getBoundingClientRect(); const { s } = S.pen;
  const x = Math.round(e.clientX - r.left); const y = Math.round(e.clientY - r.top);
  if (Math.hypot(x - s.p[s.p.length - 2], y - s.p[s.p.length - 1]) < 2) return;
  s.p.push(x, y);
  const fresh = strokePath(s); S.pen.el.replaceWith(fresh); S.pen.el = fresh;
});
const penUp = () => {
  if (!S.pen) return;
  if (S.pen.s) { S.strokes.push(S.pen.s); onEdit(); }
  S.pen = null;
};
inkBox.addEventListener('pointerup', penUp);
inkBox.addEventListener('pointercancel', penUp);

$('imgBtn').onclick = () => $('imgFile').click();
$('imgFile').onchange = () => { const f = [...$('imgFile').files]; $('imgFile').value = ''; insertImages(f); };

// ---------- gate ----------
function showGate(mode) {
  S.gateMode = mode;
  $('app').hidden = true;
  $('gate').hidden = false;
  $('gateErr').textContent = '';
  $('gateChoose').hidden = mode !== 'choose';
  $('gatePass').hidden = !['new', 'unlock', 'unlockDrive', 'unlockBackup'].includes(mode);
  $('pass').value = ''; $('pass2').value = '';
  $('pass2Row').hidden = mode !== 'new';
  $('gatePassBack').hidden = mode !== 'new';
  $('gateGo').textContent = mode === 'new' ? 'Create notebook' : 'Unlock';
  $('passLabel').textContent = mode === 'new' ? 'Choose a passphrase' : 'Passphrase';
  $('gateHint').textContent = mode === 'new'
    ? 'Use at least 12 characters. If you forget it, nobody can recover your notes.'
    : mode === 'unlockDrive' ? 'Found your notebook. Enter its passphrase.'
      : mode === 'unlockBackup' ? 'Backup restored. Enter its passphrase.' : '';
  $('gateHint').hidden = !$('gateHint').textContent;
  if ($('gatePass').hidden === false) $('pass').focus();
}

$('gateNew').onclick = () => showGate('new');
$('gatePassBack').onclick = () => showGate('choose');
async function gateAction(btn, busy, fn) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = busy; $('gateErr').textContent = '';
  try { await fn(); } catch (e) { $('gateErr').textContent = e.message; }
  btn.disabled = false; btn.textContent = label;
}
$('gateFromDrive').onclick = () => gateAction($('gateFromDrive'), 'Waiting for your browser…', async () => {
  await call('driveOpenExisting');
  showGate('unlockDrive');
});
$('gateRestore').onclick = () => gateAction($('gateRestore'), 'Restoring…', async () => {
  if (await call('backupRestore')) showGate('unlockBackup');
});
$('gateForm').onsubmit = async (e) => {
  e.preventDefault();
  if ($('gatePass').hidden) return;
  const p = $('pass').value;
  const isNew = S.gateMode === 'new';
  if (isNew && p !== $('pass2').value) { $('gateErr').textContent = 'Those two passphrases are different.'; return; }
  const b = $('gateGo');
  const label = b.textContent;
  b.disabled = true; b.textContent = isNew ? 'Creating…' : 'Unlocking…'; $('gateErr').textContent = '';
  try {
    await call(isNew ? 'create' : 'unlock', p);
    $('pass').value = ''; $('pass2').value = '';
    await enterApp();
  } catch (err) { $('gateErr').textContent = err.message; $('pass').select(); }
  b.disabled = false; b.textContent = label;
};

// ---------- notebook ----------
async function enterApp() {
  $('gate').hidden = true; $('app').hidden = false;
  S.view = new Date();
  $('search').value = ''; showResults(false);
  const t = await call('getTheme');
  if (t) await setThemeLocal(t);
  await refreshOverview();
  await openDate(todayStr());
  const st = await call('state');
  if (st.status) renderStatus(st.status);
}

async function refreshOverview() {
  const o = await call('overview');
  S.days = new Set(o.days); S.tags = o.tags;
  renderCalendar(); renderTags();
}

function renderCalendar() {
  const y = S.view.getFullYear(); const m = S.view.getMonth();
  $('calTitle').textContent = S.view.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const grid = $('calGrid'); grid.textContent = '';
  const first = new Date(y, m, 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  for (let i = 0; i < 7; i++) {
    const c = document.createElement('div'); c.className = 'dow';
    c.textContent = new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' });
    grid.append(c);
  }
  for (let i = 0; i < mondayOffset; i++) { const c = document.createElement('span'); c.className = 'day other'; grid.append(c); }
  const count = new Date(y, m + 1, 0).getDate();
  for (let d = 1; d <= count; d++) {
    const ds = `${y}-${pad2(m + 1)}-${pad2(d)}`;
    const b = document.createElement('button');
    b.className = 'day'; b.textContent = d;
    if (S.days.has(ds)) b.classList.add('has');
    if (ds === todayStr()) b.classList.add('today');
    if (ds === S.date) b.classList.add('sel');
    b.setAttribute('aria-label', fromStr(ds).toLocaleDateString(undefined, { dateStyle: 'full' }) + (S.days.has(ds) ? ', has a note' : ''));
    b.onclick = () => openDate(ds);
    grid.append(b);
  }
}

function renderTags() {
  const box = $('tags'); box.textContent = '';
  Object.entries(S.tags).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).forEach(([t]) => {
    const b = document.createElement('button');
    b.className = 'tag'; b.textContent = `#${t}`;
    b.onclick = () => { $('search').value = `#${t}`; runSearch(); };
    box.append(b);
  });
}

async function openDate(date) {
  if (S.drawing) setDrawing(false);
  closePop();
  await flush();
  const e = await call('get', date);
  S.date = date; S.base = e.updatedAt; S.loaded = e.text;
  setEditor(e.text);
  S.loaded = getEditor();
  ed.scrollTop = 0;
  const d = fromStr(date);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  $('dateTitle').textContent = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) });
  $('todayBtn').hidden = date === todayStr();
  S.view = new Date(d.getFullYear(), d.getMonth(), 1);
  renderCalendar(); updateFoot('');
  ed.focus(); caretAtEnd();
}

function shiftDay(n) { const d = fromStr(S.date); d.setDate(d.getDate() + n); openDate(toStr(d)); }

function updateFoot(msg) {
  if (msg !== undefined) $('saved').textContent = msg;
  const w = (plainOf(getEditor()).match(/\S+/g) || []).length;
  $('words').textContent = w ? `${w} ${w === 1 ? 'word' : 'words'}` : '';
}

async function flush() {
  clearTimeout(S.timer); S.timer = null;
  const text = getEditor();
  if (text === S.loaded) return;
  S.loaded = text;
  const date = S.date;
  try {
    const e = await call('save', date, text, S.base);
    if (date === S.date) {
      S.base = e.updatedAt;
      if (e.text !== text && getEditor() === text) { setEditor(e.text); S.loaded = getEditor(); }
      updateFoot('Saved');
    }
    const had = S.days.has(date); const has = !!text.trim();
    const hasTags = text.includes('#') || Object.keys(S.tags).length;
    if (had !== has || hasTags) await refreshOverview();
  } catch (err) { S.loaded = null; updateFoot(`Not saved: ${err.message}`); }
}


$('calPrev').onclick = () => { S.view = new Date(S.view.getFullYear(), S.view.getMonth() - 1, 1); renderCalendar(); };
$('calNext').onclick = () => { S.view = new Date(S.view.getFullYear(), S.view.getMonth() + 1, 1); renderCalendar(); };
$('dayPrev').onclick = () => shiftDay(-1);
$('dayNext').onclick = () => shiftDay(1);
$('todayBtn').onclick = () => openDate(todayStr());

// ---------- search ----------
function showResults(on) { $('results').hidden = !on; $('browse').hidden = on; }
async function runSearch() {
  const q = $('search').value;
  if (!q.trim()) return showResults(false);
  await flush();
  const res = await call('search', q);
  const box = $('results'); box.textContent = '';
  showResults(true);
  if (!res.length) {
    const p = document.createElement('p'); p.className = 'none'; p.textContent = 'No notes match that.'; box.append(p);
    return;
  }
  res.forEach((r) => {
    const b = document.createElement('button'); b.className = 'result';
    const t = document.createElement('b'); t.textContent = fromStr(r.date).toLocaleDateString(undefined, { dateStyle: 'long' });
    const s = document.createElement('span'); s.textContent = r.snippet;
    b.append(t, s); b.onclick = () => openDate(r.date);
    box.append(b);
  });
}
$('search').addEventListener('input', runSearch);
$('search').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('search').value = ''; showResults(false); ed.focus(); } });

// ---------- sync status ----------
function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function renderStatus(s) {
  S.status = s;
  const el = $('syncLine');
  el.classList.toggle('bad', s.state === 'error');
  el.textContent = {
    off: 'Saved on this computer only',
    syncing: 'Syncing…',
    ok: s.at ? `Synced ${ago(s.at)}` : 'Synced',
    offline: "Offline. Your notes will sync when you're back.",
    error: s.message || 'Sync stopped. Open Settings.',
  }[s.state];
  if ($('settings').open) renderDrive();
}
window.rn.on('sync-status', renderStatus);
setInterval(() => { if (S.status.state === 'ok') renderStatus(S.status); }, 30000);
$('syncLine').onclick = openSettings;

window.rn.on('entries-changed', async (dates) => {
  await refreshOverview();
  ed.querySelectorAll('.pic.missing').forEach((p) => { p.classList.remove('missing'); p.textContent = ''; });
  hydratePics();
  if (dates.includes(S.date) && getEditor() === S.loaded) {
    const e = await call('get', S.date);
    if (getEditor() === S.loaded) { const top = ed.scrollTop; setEditor(e.text); S.loaded = getEditor(); S.base = e.updatedAt; ed.scrollTop = top; updateFoot(); }
  }
});

// ---------- lock / close ----------
async function lockNow() {
  if ($('gate').hidden === false) return;
  if (S.drawing) setDrawing(false);
  closePop();
  await flush();
  await call('lock');
  if ($('settings').open) $('settings').close();
  ed.textContent = ''; S.strokes = []; ed.classList.add('empty'); lastRange = null; S.loaded = ''; S.base = 0;
  $('search').value = ''; $('results').textContent = ''; $('dateTitle').textContent = ''; $('tags').textContent = ''; S.days = new Set(); S.tags = {};
  showGate('unlock');
}
$('lockBtn').onclick = lockNow;
window.rn.on('request-lock', lockNow);
window.rn.on('request-close', async () => { await flush(); await call('closeReady'); });

document.addEventListener('keydown', (e) => {
  if ($('app').hidden) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 'l') { e.preventDefault(); lockNow(); }
  else if (e.ctrlKey && k === 'f') { e.preventDefault(); $('search').focus(); $('search').select(); }
  else if (e.ctrlKey && k === 't') { e.preventDefault(); openDate(todayStr()); }
  else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); shiftDay(-1); }
  else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); shiftDay(1); }
});

// ---------- settings ----------
async function renderDrive() {
  const st = await call('state');
  $('driveOn').hidden = !st.driveConnected;
  $('driveSetup').hidden = st.driveConnected;
  $('driveStatus').textContent = st.driveConnected ? 'Connected. Your notes are encrypted before they upload.' : '';
  $('driveErr').textContent = st.status.state === 'error' ? st.status.message : '';
}
async function openSettings() {
  await flush();
  renderThemeControls();
  $('pwMsg').textContent = '';
  await renderDrive();
  $('settings').showModal();
}
$('settingsBtn').onclick = openSettings;
document.querySelectorAll('input[name=font]').forEach((r) => {
  r.onchange = () => { theme.font = { builtin: r.value }; $('gfInput').value = ''; applyFont(); saveTheme(); };
});
$('gfInput').addEventListener('focus', () => {
  if ($('gfList').children.length) return;
  const frag = document.createDocumentFragment();
  window.GOOGLE_FONTS.forEach((n) => { const o = document.createElement('option'); o.value = n; frag.append(o); });
  $('gfList').append(frag);
});
$('gfInput').addEventListener('change', async () => {
  const name = window.GOOGLE_FONTS.find((n) => n.toLowerCase() === $('gfInput').value.trim().toLowerCase());
  if (!name) { if ($('gfInput').value.trim()) $('gfMsg').textContent = 'Choose a font from the list.'; return; }
  $('gfInput').value = name;
  $('gfMsg').textContent = 'Loading…';
  theme.font = { google: name };
  document.querySelectorAll('input[name=font]').forEach((r) => { r.checked = false; });
  await applyFont();
  if (!$('gfMsg').textContent.startsWith('Could not')) saveTheme();
});
$('toolProps').onchange = () => { theme.toolProps = $('toolProps').checked; updateProp(); saveTheme(); };
$('imgTape').onchange = () => { theme.imageTape = $('imgTape').checked; document.body.dataset.picTape = theme.imageTape ? 'on' : 'off'; saveTheme(); };
$('resetColors').onclick = () => { theme = { colors: {}, font: { builtin: 'typewriter' }, imageTape: theme.imageTape, toolProps: theme.toolProps }; applyColors(); applyFont(); renderThemeControls(); saveTheme(); };
$('syncNow').onclick = () => call('syncNow');
$('driveOff').onclick = async () => { await call('driveDisconnect'); renderDrive(); };
$('driveOn2').onclick = async () => {
  const b = $('driveOn2');
  b.disabled = true; b.textContent = 'Waiting for your browser…'; $('driveErr').textContent = '';
  try {
    await call('driveConnect');
    await renderDrive();
  } catch (e) { $('driveErr').textContent = e.message; }
  b.disabled = false; b.textContent = 'Sign in with Google';
};
$('passForm').onsubmit = async (e) => {
  e.preventDefault();
  if ($('pwNew').value !== $('pwNew2').value) { $('pwMsg').textContent = 'Those two passphrases are different.'; return; }
  $('pwMsg').textContent = 'Changing…';
  try {
    await call('changePassphrase', $('pwCur').value, $('pwNew').value);
    $('passForm').reset();
    $('pwMsg').textContent = 'Passphrase changed.';
  } catch (err) { $('pwMsg').textContent = err.message; }
};
$('backupBtn').onclick = async () => {
  $('backupMsg').textContent = '';
  try { if (await call('backupCreate')) $('backupMsg').textContent = 'Backup saved.'; }
  catch (e) { $('backupMsg').textContent = `Backup failed: ${e.message}`; }
};
$('exportBtn').onclick = () => call('exportText');

// ---------- start ----------
(async () => {
  const st = await call('state');
  await setThemeLocal(st.theme);
  showGate(st.hasVault ? 'unlock' : 'choose');
})();
