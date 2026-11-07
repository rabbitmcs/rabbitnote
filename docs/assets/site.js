(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.add('js');
  var LINE = 32;
  var calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function key(u) { return new URL(u, location.href).pathname.replace(/index\.(php|html)$/, ''); }

  document.addEventListener('DOMContentLoaded', function () {
    var notebook = document.querySelector('.notebook');
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.tabs a'));
    var main = document.querySelector('main.page');
    if (!notebook || !tabs.length || !main) return;
    // The address changes as pages turn, so relative links must be pinned first.
    Array.prototype.forEach.call(document.querySelectorAll('a[href]'), function (n) { n.setAttribute('href', n.href); });
    Array.prototype.forEach.call(document.querySelectorAll('img[src]'), function (n) { n.setAttribute('src', n.src); });
    var routes = tabs.map(function (a) { return { key: key(a.href), url: a.href, tab: a, title: '', blocks: [] }; });
    var here = key(location.href);

    function take(r, doc, base) {
      var m = doc.querySelector('main.page');
      r.title = doc.title;
      r.blocks = Array.prototype.slice.call(m.children).filter(function (el) { return !el.classList.contains('brand'); }).map(function (el) {
        var c = el.cloneNode(true);
        [c].concat(Array.prototype.slice.call(c.querySelectorAll('img,a'))).forEach(function (n) {
          ['src', 'href'].forEach(function (at) {
            if (n.getAttribute && n.getAttribute(at)) n.setAttribute(at, new URL(n.getAttribute(at), base).href);
          });
        });
        return c;
      });
    }

    Promise.all(routes.map(function (r) {
      if (r.key === here) { take(r, document, location.href); return null; }
      return fetch(r.url).then(function (x) { if (!x.ok) throw new Error('load'); return x.text(); }).then(function (t) {
        take(r, new DOMParser().parseFromString(t, 'text/html'), r.url);
      });
    })).then(function () { return document.fonts ? document.fonts.ready : null; }).then(start).catch(function () {
      root.classList.remove('js'); // ordinary linked pages still work
    });

    var book, pages = [], at = 0, busy = false, queued = null;

    function makeSheet() {
      var s = document.createElement('div'); s.className = 'sheet';
      var b = document.createElement('div'); b.className = 'sheet-body';
      s.appendChild(b); return s;
    }

    function paginate() {
      var old = at < pages.length ? pages[at].route : null;
      var probe = makeSheet();
      probe.style.visibility = 'hidden';
      book.appendChild(probe);
      var body = probe.firstChild;
      var room = Math.max(LINE * 6, Math.floor((book.clientHeight - 32 - 54) / LINE) * LINE);
      body.style.height = room + 'px';
      var out = [];
      routes.forEach(function (r) {
        var cur = [];
        function over() { return body.scrollHeight > room + 1; }
        function flush() { out.push({ route: r, nodes: cur }); cur = []; body.textContent = ''; }
        var queue = [];
        r.blocks.forEach(function (b) {
          if (b.tagName === 'UL') {
            Array.prototype.forEach.call(b.children, function (li) { var u = document.createElement('ul'); u.appendChild(li.cloneNode(true)); queue.push(u); });
          } else queue.push(b.cloneNode(true));
        });
        while (queue.length) {
          var el = queue.shift();
          if (el.classList && el.classList.contains('shot')) {
            // The app picture fills whatever is left of the page, or gets a page of its own.
            var last = body.lastElementChild;
            var used = last ? last.offsetTop + last.offsetHeight - body.offsetTop : 0;
            var left = Math.floor((room - used) / LINE) * LINE;
            if (left < LINE * 4) { if (cur.length) flush(); left = room - 8; }
            el.style.setProperty('--h', (left - 26) + 'px'); // leaves room for the tape above and the shadow below
            el.style.marginTop = '14px';
            body.appendChild(el); cur.push(el);
            continue;
          }
          body.appendChild(el); cur.push(el);
          if (!over()) continue;
          body.removeChild(el); cur.pop();
          if (el.tagName === 'P' && !el.children.length) { // fill the page, carry the rest over
            var words = el.textContent.split(' '), n = words.length, first = el.cloneNode(false);
            body.appendChild(first);
            var lo = 0, hi = n;
            while (lo < hi) { var mid = (lo + hi + 1) >> 1; first.textContent = words.slice(0, mid).join(' '); if (over()) hi = mid - 1; else lo = mid; }
            if (lo >= 4 && lo < n) {
              first.textContent = words.slice(0, lo).join(' '); cur.push(first);
              var rest = el.cloneNode(false); rest.textContent = words.slice(lo).join(' '); queue.unshift(rest);
              flush(); continue;
            }
            body.removeChild(first);
          }
          var carry = null;
          if (cur.length && cur[cur.length - 1].tagName === 'H2') carry = cur.pop();
          if (cur.length) flush();
          if (carry) queue.unshift(el), queue.unshift(carry);
          else if (!cur.length && !body.children.length && !el._forced) { el._forced = true; var fits = true; body.appendChild(el); fits = !over(); body.removeChild(el); if (fits) queue.unshift(el); else { cur.push(el); flush(); } }
          else queue.unshift(el);
        }
        if (cur.length) flush();
      });
      book.removeChild(probe);
      pages = out;
      if (old) { for (var i = 0; i < pages.length; i++) if (pages[i].route === old) { at = i; break; } }
      if (at >= pages.length) at = pages.length - 1;
      return room;
    }

    var room = 0;
    function render(i) {
      var p = pages[i], s = makeSheet(), b = s.firstChild;
      b.style.height = room + 'px';
      p.nodes.forEach(function (n) { b.appendChild(n.cloneNode(true)); });
      // Arrows only when this section runs over more than one page; tabs move between sections.
      var hasPrev = i > 0 && pages[i - 1].route === p.route, hasNext = i < pages.length - 1 && pages[i + 1].route === p.route;
      if (hasPrev || hasNext) {
        var foot = document.createElement('div'); foot.className = 'sheet-foot';
        var prev = document.createElement('button'); prev.type = 'button'; prev.textContent = '‹'; prev.setAttribute('aria-label', 'Previous page'); prev.disabled = !hasPrev; prev.onclick = function () { go(i - 1); };
        var next = document.createElement('button'); next.type = 'button'; next.textContent = '›'; next.setAttribute('aria-label', 'Next page'); next.disabled = !hasNext; next.onclick = function () { go(i + 1); };
        foot.appendChild(prev); foot.appendChild(next); s.appendChild(foot);
      }
      return s;
    }

    function mark(push) {
      var r = pages[at].route;
      routes.forEach(function (x) { if (x === r) x.tab.setAttribute('aria-current', 'page'); else x.tab.removeAttribute('aria-current'); });
      document.title = r.title;
      if (push && key(location.href) !== r.key) history.pushState({}, '', r.url);
    }

    function go(i, push) {
      if (i < 0 || i >= pages.length || i === at) return;
      if (busy) { queued = i; return; }
      var forward = i > at, old = book.querySelector('.sheet'), neu = render(i);
      at = i; mark(push !== false);
      var done = function () { if (old.parentNode) old.remove(); busy = false; neu.style.zIndex = ''; var q = queued; queued = null; if (q !== null) go(q); };
      if (calm || !old.animate) { book.appendChild(neu); done(); return; }
      busy = true;
      var turn = forward ? old : neu;
      if (forward) book.insertBefore(neu, old); else book.appendChild(neu);
      turn.classList.add('turning');
      var top = window.matchMedia('(max-width: 760px)').matches; // phones flip up like a notepad
      var r = function (d) { return top ? 'rotateX(' + (-d) + 'deg)' : 'rotateY(' + d + 'deg)'; };
      var frames = [
        { transform: r(0), filter: 'brightness(1)', opacity: 1, offset: 0 },
        { transform: r(-85), filter: 'brightness(.8)', opacity: 1, offset: .8 },
        { transform: r(-110), filter: 'brightness(.72)', opacity: 0, offset: 1 }
      ];
      var a = turn.animate(frames, { duration: 620, easing: 'cubic-bezier(.4,.1,.3,1)', direction: forward ? 'normal' : 'reverse', fill: 'both' });
      a.onfinish = function () { a.cancel(); turn.classList.remove('turning'); done(); };
    }

    function startOf(k) { for (var i = 0; i < pages.length; i++) if (pages[i].route.key === k) return i; return -1; }

    function start() {
      book = document.createElement('main'); book.id = 'book';
      notebook.replaceChild(book, main);
      room = paginate();
      at = Math.max(0, startOf(here));
      book.appendChild(render(at));
      mark(false);
      document.addEventListener('click', function (e) {
        if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        var a = e.target.closest && e.target.closest('a[href]');
        if (!a || a.origin !== location.origin) return;
        var i = startOf(key(a.href));
        if (i < 0) return;
        e.preventDefault();
        if (pages[at].route.key !== key(a.href) || at !== i) go(i);
      });
      document.addEventListener('keydown', function (e) {
        var d = (e.key === 'ArrowRight' || e.key === 'PageDown') ? 1 : (e.key === 'ArrowLeft' || e.key === 'PageUp') ? -1 : 0;
        if (d && pages[at + d] && pages[at + d].route === pages[at].route) go(at + d);
      });
      window.addEventListener('popstate', function () { var i = startOf(key(location.href)); if (i >= 0) go(i, false); });
      var t;
      window.addEventListener('resize', function () {
        clearTimeout(t);
        t = setTimeout(function () {
          room = paginate();
          var cur = book.querySelector('.sheet'); if (cur) cur.remove();
          book.appendChild(render(at)); mark(false);
        }, 150);
      });
    }
  });
})();
