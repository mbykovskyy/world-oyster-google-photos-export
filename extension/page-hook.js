// Runs in the page's MAIN world at document_start, before Google Photos' own code.
// Reads the media lists Google Photos loads for its grids and forwards each batch to
// content.js, which keeps them (bounded): item facts (photo or video, thumbnail, taken
// time) for every view, and each view's order for Shift+click ranges.
//
// Every list item looks like [id, [thumbUrl, w, h, ...], takenUtcMs, ..., {...}]; its info
// object has the key "76647426" (video info: duration ms, size, ...) only for videos.
// Lists seen so far: library `lcxiM` (items at data[0], batches by date), album `snAcKc`
// (album id = 1st argument, items at data[1]), search `EzkLib` (query = 8th argument,
// items at data[0]). Batches of other requests are forwarded under a generic key.
//
// Nothing is kept here: batches are only buffered until content.js says it's listening
// (data embedded in the page is read while it loads, before content.js starts).
(() => {
  const VIDEO_KEY = '76647426';
  const IGNORE = new Set(['fDcn4b']); // single-photo details: no list, and no video marker
  const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);

  // Media items anywhere in a response, in order: [id, video, thumb, takenUtcMs].
  function scan(node, out, depth = 0) {
    if (!Array.isArray(node) || depth > 12) return out;
    if (typeof node[0] === 'string' && node[0].startsWith('AF1Qip') && Array.isArray(node[1])) {
      const info = node.find(isMap); // items without it aren't media list entries
      if (info) {
        const thumb = typeof node[1][0] === 'string' ? node[1][0] : null;
        out.push([node[0], VIDEO_KEY in info, thumb, typeof node[2] === 'number' ? node[2] : null]);
      }
      return out;
    }
    for (const x of node) scan(x, out, depth + 1);
    return out;
  }

  // Which view a batch belongs to.
  function listKey(rpcid, args) {
    if (rpcid === 'lcxiM') return 'library';
    if (rpcid === 'snAcKc' && typeof args?.[0] === 'string') return `album:${args[0]}`;
    if (rpcid === 'EzkLib') return `search:${JSON.stringify(args?.[7] ?? null)}`;
    return `rpc:${rpcid}`;
  }

  let listening = false;
  const buffer = [];
  function post(key, items) {
    if (!items.length) return;
    const msg = { source: 'wo-media', key, items };
    if (listening) window.postMessage(msg, location.origin);
    else buffer.push(msg);
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'wo-media-req') return;
    listening = true;
    for (const msg of buffer.splice(0)) window.postMessage(msg, location.origin);
  });

  // batchexecute: the request's f.req lists [rpcid, argsJSON, null, tag] per call; the
  // response has lines of JSON with ["wrb.fr", rpcid, "<payload JSON>", ..., tag].
  function readBatch(bodyText, text) {
    let calls = [];
    try { calls = JSON.parse(new URLSearchParams(bodyText).get('f.req'))[0] || []; } catch { /* no args */ }
    for (const line of text.split('\n')) {
      if (!line.includes('"wrb.fr"')) continue;
      try {
        for (const e of JSON.parse(line)) {
          if (e[0] !== 'wrb.fr' || typeof e[2] !== 'string' || IGNORE.has(e[1])) continue;
          const call = calls.find((c) => c[0] === e[1] && (c[3] ?? 'generic') === (e[6] ?? 'generic'))
            || calls.find((c) => c[0] === e[1]);
          let args = null;
          try { args = call ? JSON.parse(call[1]) : null; } catch { /* keep null */ }
          post(listKey(e[1], args), scan(JSON.parse(e[2]), []));
        }
      } catch { /* not a complete JSON line */ }
    }
  }

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    let request = null;
    try {
      const url = String(args[0]?.url || args[0]);
      // Copy the request now: once fetch has run, its body can't be read any more.
      if (url.includes('/data/batchexecute')) request = args[0] instanceof Request ? args[0].clone() : url;
    } catch { /* never get in the page's way */ }
    const res = origFetch.apply(this, args);
    if (request) {
      // Copy the response before the page reads it (this handler is attached first).
      const text = res.then((r) => r.clone().text());
      const body = typeof request === 'string' ? Promise.resolve(String(args[1]?.body ?? '')) : request.text();
      Promise.all([body, text]).then(([b, t]) => readBatch(b, t)).catch(() => {});
    }
    return res;
  };

  // Data embedded in the page on a full load: AF_initDataCallback({ key, data: [...] }).
  // There's no request to tell the view, so a block joins the library or album list only
  // when the page address says so and it has that list's batch shape (items, then a
  // continuation token); other blocks (the page can embed several) get their own key.
  const hasItems = (a) => Array.isArray(a) && a.some((x) => Array.isArray(x) && typeof x[0] === 'string' && x[0].startsWith('AF1Qip'));
  function embeddedKey(arg) {
    const p = location.pathname.replace(/^\/u\/\d+/, '');
    const d = arg.data;
    if ((p === '' || p === '/') && hasItems(d[0]) && typeof d[1] === 'string') return 'library';
    const album = p.match(/^\/(?:share|album)\/(AF1Qip[\w-]+)/);
    if (album && hasItems(d[1])) return `album:${album[1]}`;
    return `page:${p}:${arg.key}`;
  }
  let afCallback;
  try {
    Object.defineProperty(window, 'AF_initDataCallback', {
      configurable: true,
      get: () => afCallback,
      set(fn) {
        afCallback = typeof fn !== 'function' ? fn : function (arg) {
          try { if (Array.isArray(arg?.data)) post(embeddedKey(arg), scan(arg.data, [])); } catch { /* ignore */ }
          return fn.apply(this, arguments);
        };
      },
    });
  } catch { /* already defined: embedded data won't be read, fetches still are */ }
})();
