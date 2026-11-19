// Runs in the page's MAIN world at document_start, before Google Photos' own code.
// Reads the media lists Google Photos loads for its grids (library, albums, search)
// and tells content.js which items are photos and which are videos, so videos get no
// checkbox and no "Select this photo" button.
//
// Every list item looks like [id, [thumbUrl, w, h, ...], takenUtcMs, ..., {...}], and its
// trailing object has the key "76647426" (video info: duration ms, size, ...) only for videos.
(() => {
  const VIDEO_KEY = '76647426';
  const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);

  function scan(node, found, depth = 0) {
    if (!Array.isArray(node) || depth > 12) return;
    if (typeof node[0] === 'string' && node[0].startsWith('AF1Qip') && Array.isArray(node[1])) {
      const info = node.find(isMap); // items without it aren't media list entries
      if (info) (VIDEO_KEY in info ? found.videos : found.photos).push(node[0]);
      return;
    }
    for (const x of node) scan(x, found, depth + 1);
  }

  // Everything seen so far is kept: data embedded in the page is read while it loads,
  // before content.js listens, so content.js asks for the full lists when it starts.
  const all = { videos: new Set(), photos: new Set() };
  const post = (videos, photos) => window.postMessage({ source: 'wo-media', videos, photos }, location.origin);
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data?.source === 'wo-media-req') post([...all.videos], [...all.photos]);
  });

  function report(data) {
    const found = { videos: [], photos: [] };
    scan(data, found);
    if (!found.videos.length && !found.photos.length) return;
    for (const id of found.videos) all.videos.add(id);
    for (const id of found.photos) all.photos.add(id);
    post(found.videos, found.photos);
  }

  // batchexecute responses: lines of JSON; each ["wrb.fr", rpcid, "<payload JSON>", ...].
  function readBatch(text) {
    for (const line of text.split('\n')) {
      if (!line.includes('"wrb.fr"')) continue;
      try {
        for (const entry of JSON.parse(line)) {
          if (entry[0] === 'wrb.fr' && typeof entry[2] === 'string') report(JSON.parse(entry[2]));
        }
      } catch { /* not a complete JSON line */ }
    }
  }

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const res = origFetch.apply(this, args);
    try {
      const url = String(args[0]?.url || args[0]);
      if (url.includes('/data/batchexecute')) {
        res.then((r) => r.clone().text()).then(readBatch).catch(() => {});
      }
    } catch { /* never get in the page's way */ }
    return res;
  };

  // Data embedded in the page on a full load: AF_initDataCallback({ key, data: [...] }).
  let afCallback;
  try {
    Object.defineProperty(window, 'AF_initDataCallback', {
      configurable: true,
      get: () => afCallback,
      set(fn) {
        afCallback = typeof fn !== 'function' ? fn : function (arg) {
          try { if (Array.isArray(arg?.data)) report(arg.data); } catch { /* ignore */ }
          return fn.apply(this, arguments);
        };
      },
    });
  } catch { /* already defined: embedded data won't be read, fetches still are */ }
})();
