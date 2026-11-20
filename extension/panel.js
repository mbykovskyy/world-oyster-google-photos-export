import { SEL_PREFIX, loadSelection, hasLocation, thumbUrl, accountUrl, byDate } from './shared.js';

const $ = (id) => document.getElementById(id);
// Trash bin (Material "delete" outline), for removing a photo from the selection.
const TRASH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM8 9h8v10H8V9zm7.5-5l-1-1h-5l-1 1H5v2h14V4h-3.5z"/></svg>';
const PIN_OFF_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/><path d="M3.5 3.5l17 17" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

// Height/width of a tile, from its decoded preview image; square without one.
const imageRatio = (img) => (img?.naturalWidth ? Math.min(3, Math.max(0.33, img.naturalHeight / img.naturalWidth)) : 1);

// One masonry tile: the image at its own shape, a status label (always visible), and
// place / date on hover. Resolves once the image is decoded, so its shape is known.
async function tile(r) {
  // The whole tile opens the preview (the trash bin is the only other click target).
  const node = el('div', { className: 'tile', title: 'Preview' });
  node.onclick = () => openViewer(r.id);

  const src = r.preview || thumbUrl(r, 240);
  const noPreview = () => el('div', { className: 'nopreview', textContent: 'no preview' });
  let img = null;
  if (src) {
    img = el('img', { src, alt: '' });
    img.onerror = () => img.replaceWith(noPreview());
    node.append(img);
    await img.decode().catch(() => { img = null; });
  } else {
    node.append(noPreview());
  }
  const ratio = imageRatio(img);
  node.style.aspectRatio = `1 / ${ratio}`;

  // Status label, top-left: failed / No location. (Loading photos aren't shown at all.)
  if (r.status === 'error') {
    node.append(el('span', { className: 'pill error', textContent: '⚠ no details', title: r.error || 'Could not fetch details' }));
  } else if (!hasLocation(r)) {
    node.append(el('span', { className: 'pill noloc-pill', innerHTML: `${PIN_OFF_SVG}No location`, title: 'No location found for this photo or any photo from the same day' }));
  }

  // Trash bin: removes the photo from the selection.
  const rm = el('button', { className: 'trash', type: 'button', title: 'Remove', innerHTML: TRASH_SVG });
  rm.setAttribute('aria-label', 'Remove');
  rm.onclick = (e) => {
    e.stopPropagation(); // don't also open the preview
    node.remove(); // update the grid right away; the storage change re-renders the rest
    chrome.storage.local.remove(SEL_PREFIX + r.id);
  };

  const place = el('div', { className: 'line', textContent: r.place || (hasLocation(r) ? `${r.latitude}, ${r.longitude}` : '') });
  const date = el('div', { className: 'line dim', textContent: r.date_local ? r.date_local.replace('T', ' ') : '' });
  node.append(rm, el('div', { className: 'info' }, place, date));
  return { node, ratio };
}

// ---------- masonry layout ----------
// Tiles go, newest first, into whichever column is currently shortest, so the order
// reads roughly left-to-right, top-to-bottom. Columns follow the panel's width.

const MIN_TILE_PX = 130;
let tiles = [];
let columnCount = 0;

function layout(force = false) {
  const grid = $('grid');
  const cols = Math.max(2, Math.floor((grid.clientWidth + 6) / (MIN_TILE_PX + 6)));
  if (!force && cols === columnCount) return;
  columnCount = cols;
  const columns = Array.from({ length: cols }, () => el('div', { className: 'col' }));
  const heights = new Array(cols).fill(0);
  for (const t of tiles) {
    const i = heights.indexOf(Math.min(...heights));
    columns[i].append(t.node);
    heights[i] += t.ratio + 0.05; // + gap, in tile-width units
  }
  grid.replaceChildren(...columns);
}

// Re-layout on the next frame, not inside the ResizeObserver callback: changing the
// grid there can resize it again in the same pass, which Chrome reports as a
// "ResizeObserver loop completed with undelivered notifications" error.
let layoutFrame = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(() => layout());
}).observe(document.getElementById('grid'));

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const all = await loadSelection();
  // Photos still loading their details aren't shown (or counted) until they're done,
  // so each tile appears once, already in its date position.
  const records = all.filter((r) => r.status !== 'pending').sort(byDate);
  const missing = records.filter((r) => r.status === 'ok' && !hasLocation(r)).length;
  const failed = records.filter((r) => r.status === 'error').length;

  const count = $('count');
  count.textContent = `${records.length} selected`;
  if (missing) count.append(' · ', el('span', { className: 'noloc', textContent: `No location: ${missing}` }));

  $('empty').hidden = all.length > 0;
  $('clear').disabled = !all.length;
  hasRecords = records.length > 0;
  $('export').disabled = !hasRecords || exportRunning;
  $('retry').hidden = !failed;
  $('retry').textContent = `Retry ${failed} failed`;

  const built = await Promise.all(records.slice().reverse().map(tile));
  if (seq !== renderSeq) return; // a newer render started while images decoded

  // Keep the scroll position across re-renders.
  const grid = $('grid');
  const scroll = grid.scrollTop;
  tiles = built;
  layout(true);
  grid.scrollTop = scroll;

  // The viewer steps through photos in the grid's order (newest first).
  byId = new Map(records.map((r) => [r.id, r]));
  viewerIds = records.map((r) => r.id).reverse();
  if (!$('viewer').hidden) {
    const i = viewerIds.indexOf(currentId);
    if (i < 0) closeViewer();
    else showPhoto(i, false);
  }
}

// ---------- photo viewer ----------
// The panel can't load Google's images itself (no Google cookies here), so the
// Google Photos tab fetches a larger version and sends it back as a data URL.
// Nothing is stored: a few recent images are kept in memory only.

let byId = new Map();
let viewerIds = [];
let currentId = null;
let showSeq = 0;

// Longest side to ask Google for: enough for the panel at this screen's pixel density,
// rounded up to a few fixed sizes so they can be cached and reused.
const VIEWER_SIZES = [800, 1200, 1600, 2048];
const viewerSize = () => {
  const px = Math.max(innerWidth, innerHeight) * (devicePixelRatio || 1);
  return VIEWER_SIZES.find((s) => s >= px) || VIEWER_SIZES.at(-1);
};

const largeCache = new Map(); // "<id>@<size>" -> Promise<data URL>, least recently used first
const LARGE_CACHE_MAX = 12;
function largeImage(r) {
  const key = `${r.id}@${viewerSize()}`;
  let p = largeCache.get(key);
  if (p) largeCache.delete(key); // re-insert below as most recent
  else {
    p = (async () => {
      const tab = await photosTab();
      if (!tab) throw new Error('Open Google Photos in this window to see a larger version.');
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'largeImage', thumb: r.thumb, account: r.account, size: viewerSize() });
      if (!res?.dataUrl) throw new Error(res?.error || 'No image returned');
      return res.dataUrl;
    })();
    p.catch(() => largeCache.delete(key));
  }
  largeCache.set(key, p);
  while (largeCache.size > LARGE_CACHE_MAX) largeCache.delete(largeCache.keys().next().value);
  return p;
}

function openViewer(id) {
  const i = viewerIds.indexOf(id);
  if (i < 0) return;
  $('viewer').hidden = false;
  $('viewer').focus();
  showPhoto(i, true);
}

function closeViewer() {
  showSeq++;
  currentId = null;
  $('viewer').hidden = true;
  $('v-img').removeAttribute('src');
}

// fresh = a different photo: reset the image; otherwise just refresh text (after a re-render).
function showPhoto(i, fresh) {
  const r = byId.get(viewerIds[i]);
  if (!r) return closeViewer();
  currentId = r.id;

  $('v-pos').textContent = `${i + 1} / ${viewerIds.length}`;
  $('v-prev').disabled = i === 0;
  $('v-next').disabled = i === viewerIds.length - 1;
  $('v-open').href = accountUrl(r);
  $('v-place').replaceChildren();
  if (r.status === 'error') $('v-place').append(el('span', { className: 'warn', textContent: `⚠ no details: ${r.error || 'could not fetch details'}` }));
  else if (!hasLocation(r)) $('v-place').append(el('span', { className: 'noloc', innerHTML: `${PIN_OFF_SVG}No location` }));
  else $('v-place').textContent = r.place || `${r.latitude}, ${r.longitude}`;
  $('v-date').textContent = r.date_local?.replace('T', ' ') || '';
  if (!fresh) return;

  const seq = ++showSeq;
  const img = $('v-img');
  const msg = $('v-msg');
  msg.replaceChildren();
  if (r.preview) img.src = r.preview;
  else img.removeAttribute('src');
  img.classList.add('low');
  $('v-spin').hidden = false;

  largeImage(r)
    .then((url) => {
      if (seq !== showSeq) return;
      img.src = url;
      img.classList.remove('low');
    })
    .catch((e) => {
      if (seq !== showSeq) return;
      img.classList.remove('low');
      msg.textContent = `Couldn't load a larger version: ${e.message}`;
    })
    .finally(() => {
      if (seq !== showSeq) return;
      $('v-spin').hidden = true;
      // Warm up the neighbours so ←/→ feel instant.
      for (const j of [i + 1, i - 1]) {
        const n = byId.get(viewerIds[j]);
        if (n) largeImage(n).catch(() => {});
      }
    });
}

function step(delta) {
  const i = viewerIds.indexOf(currentId) + delta;
  if (i >= 0 && i < viewerIds.length) showPhoto(i, true);
}

// Deselecting moves on to the next photo (the one → shows: older), or the previous one
// if it was the last; closes the viewer when nothing is left.
function deselectCurrent() {
  if (!currentId) return;
  const i = viewerIds.indexOf(currentId);
  chrome.storage.local.remove(SEL_PREFIX + currentId);
  viewerIds.splice(i, 1); // the storage change re-renders too; update now so the next photo shows at once
  if (!viewerIds.length) return closeViewer();
  showPhoto(Math.min(i, viewerIds.length - 1), true);
}

$('v-close').onclick = closeViewer;
$('v-prev').onclick = () => step(-1);
$('v-next').onclick = () => step(1);
$('v-remove').innerHTML = TRASH_SVG;
$('v-remove').onclick = deselectCurrent;
// Keep focus on the viewer, not on the last button clicked (so keys don't "click" it).
for (const b of $('viewer').querySelectorAll('button')) b.onpointerdown = (e) => e.preventDefault();

document.addEventListener('keydown', (e) => {
  if ($('viewer').hidden || e.altKey || e.ctrlKey || e.metaKey) return;
  const action = { ArrowLeft: () => step(-1), ArrowRight: () => step(1), d: deselectCurrent, D: deselectCurrent, Escape: closeViewer }[e.key];
  if (!action) return;
  e.preventDefault();
  action();
});

// ---------- export (runs in the Google Photos tab, saves one zip) ----------

let exportRunning = false;
let hasRecords = false;
const STALE_MS = 60000; // no progress for this long = the export's tab was closed or reloaded

function renderExport(p) {
  const box = $('export-status');
  exportRunning = !!p?.running && Date.now() - p.heartbeat < STALE_MS;
  $('export').disabled = exportRunning || !hasRecords;
  if (!p) return void (box.hidden = true);
  box.hidden = false;
  box.replaceChildren();
  const failed = p.failed || [];
  if (exportRunning) {
    const zipping = p.done >= p.total;
    box.append(zipping ? 'Creating zip…' : `Exporting photo ${p.done + 1} of ${p.total}…`,
      el('progress', { max: p.total || 1, value: p.done }),
      el('div', { className: 'muted', textContent: 'Keep the Google Photos tab open until the zip downloads.' }));
  } else if (p.running) {
    box.append(`Export stopped at ${p.done} of ${p.total} (the Google Photos tab was closed or reloaded). Click Export to start again.`);
  } else if (p.error) {
    box.append(el('span', { className: 'warn', textContent: `Export failed: ${p.error}` }));
  }
  // A finished export shows no "Exported …" message: only skipped/failed notes, if any.
  if (p.skipped) box.append(el('div', { className: 'muted', textContent: `${p.skipped} skipped: details still loading or failed.` }));
  if (failed.length) {
    const list = el('ul', {}, ...failed.map((f) => el('li', { textContent: `${f.id.slice(0, 16)}…: ${f.error}` })));
    box.append(el('details', {}, el('summary', { className: 'warn', textContent: `${failed.length} failed` }), list));
  }
  box.hidden = !box.childNodes.length;
}

// The panel belongs to the tab whose toolbar button opened it (?tab=<id>); export and
// the viewer's larger images go through there. Falls back to any Google Photos tab in
// this window if that tab is gone.
const ownerTabId = Number(new URLSearchParams(location.search).get('tab')) || null;

async function photosTab() {
  if (ownerTabId) {
    const tab = await chrome.tabs.get(ownerTabId).catch(() => null);
    if (tab?.url?.startsWith('https://photos.google.com/')) return tab;
  }
  const tabs = await chrome.tabs.query({ url: 'https://photos.google.com/*', currentWindow: true });
  return tabs.find((t) => t.active) || tabs[0] || null;
}

$('export').onclick = async () => {
  try {
    const tab = await photosTab();
    if (!tab) throw new Error('no Google Photos tab is open in this window');
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'export' });
    if (res?.error) throw new Error(res.error);
  } catch (e) {
    const box = $('export-status');
    box.hidden = false;
    box.textContent = `Couldn't start the export: ${e.message}. Open Google Photos in this window (refresh it after reloading the extension) and try again.`;
  }
};

chrome.storage.local.get('exportProgress').then(({ exportProgress }) => renderExport(exportProgress));
setInterval(() => chrome.storage.local.get('exportProgress').then(({ exportProgress }) => renderExport(exportProgress)), 5000);

$('retry').onclick = async () => {
  const items = {};
  for (const r of await loadSelection()) if (r.status === 'error') items[SEL_PREFIX + r.id] = { ...r, status: 'pending', error: null };
  await chrome.storage.local.set(items);
};

let clearArmed = null;
$('clear').onclick = async () => {
  const btn = $('clear');
  if (!clearArmed) {
    btn.textContent = 'Click again to clear';
    clearArmed = setTimeout(() => { clearArmed = null; btn.textContent = 'Clear all'; }, 3000);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = null;
  btn.textContent = 'Clear all';
  const keys = (await loadSelection()).map((r) => SEL_PREFIX + r.id);
  // The last export's notes ("3 failed", "2 skipped") are about photos no longer selected;
  // a running export keeps its progress.
  if (!exportRunning) keys.push('exportProgress');
  await chrome.storage.local.remove(keys);
};

$('enabled').onchange = (e) => chrome.storage.local.set({ enabled: e.target.checked });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('enabled' in changes) $('enabled').checked = changes.enabled.newValue !== false;
  if ('exportProgress' in changes) renderExport(changes.exportProgress.newValue);
  if (Object.keys(changes).some((k) => k.startsWith(SEL_PREFIX))) render();
});

chrome.storage.local.get('enabled').then(({ enabled }) => { $('enabled').checked = enabled !== false; });
render();
