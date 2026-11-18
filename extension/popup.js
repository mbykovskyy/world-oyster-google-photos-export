import { SEL_PREFIX, CONTENT_OPTIONS, loadSelection, hasLocation, thumbUrl, accountUrl, byDate } from './shared.js';

const $ = (id) => document.getElementById(id);
const PIN_OFF_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/><path d="M3.5 3.5l17 17" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

function row(r) {
  const thumb = el('div', { className: 'thumb', title: 'Open in Google Photos' });
  thumb.onclick = () => chrome.tabs.create({ url: accountUrl(r) });
  const src = r.preview || thumbUrl(r, 104);
  const noPreview = () => el('span', { className: 'nopreview', textContent: 'no preview' });
  if (src) {
    const img = el('img', { src, loading: 'lazy', alt: '' });
    img.onerror = () => img.replaceWith(noPreview());
    thumb.append(img);
  } else {
    thumb.append(noPreview());
  }
  if (r.type === 'video') thumb.append(el('span', { className: 'video', textContent: '▶ video' }));

  const date = el('div', { className: 'line muted', textContent: r.date_local ? r.date_local.replace('T', ' ') : '—' });
  const where = el('div', { className: 'line' });
  if (r.status === 'pending') {
    where.className += ' muted';
    where.textContent = 'Fetching details… (open Google Photos in this account)';
  } else if (r.status === 'error') {
    where.className += ' warn';
    where.textContent = `⚠ ${r.error || 'Could not fetch details'}`;
  } else if (!hasLocation(r)) {
    where.innerHTML = `<span class="noloc">${PIN_OFF_SVG}No location</span>`;
    if (r.place) where.append(` ${r.place}`);
  } else {
    where.textContent = r.place || `${r.latitude}, ${r.longitude}`;
    where.title = `${r.latitude}, ${r.longitude} — ${r.location_method}`;
  }

  const content = el('select', { title: 'Content' }, ...CONTENT_OPTIONS.map((c) => el('option', { textContent: c })));
  content.value = r.content || CONTENT_OPTIONS[0];
  content.onchange = async () => {
    const key = SEL_PREFIX + r.id;
    const { [key]: current } = await chrome.storage.local.get(key);
    if (current) await chrome.storage.local.set({ [key]: { ...current, content: content.value } });
  };

  const rm = el('button', { className: 'remove', textContent: '×', title: 'Remove from selection' });
  const li = el('li', {}, thumb, el('div', { className: 'meta' }, date, where, content), rm);
  rm.onclick = () => {
    li.remove(); // update the list right away; storage change re-renders the counts
    chrome.storage.local.remove(SEL_PREFIX + r.id);
  };
  return li;
}

async function render() {
  const records = (await loadSelection()).sort(byDate);
  const missing = records.filter((r) => r.status === 'ok' && !hasLocation(r)).length;
  const failed = records.filter((r) => r.status === 'error').length;
  const pending = records.filter((r) => r.status === 'pending').length;

  const count = $('count');
  count.textContent = `${records.length} selected`;
  if (pending) count.append(` · ${pending} loading`);
  if (missing) count.append(' · ', el('span', { className: 'noloc', textContent: `No location: ${missing}` }));

  $('empty').hidden = records.length > 0;
  $('clear').disabled = !records.length;
  hasRecords = records.length > 0;
  $('export').disabled = !hasRecords || exportRunning;
  $('retry').hidden = !failed;
  $('retry').textContent = `Retry ${failed} failed`;

  // Keep scroll position stable, and don't rebuild under a content dropdown you're using.
  const list = $('list');
  const scroll = list.scrollTop;
  if (document.activeElement?.tagName === 'SELECT' && list.contains(document.activeElement)) {
    document.activeElement.addEventListener('blur', render, { once: true });
    return;
  }
  list.replaceChildren(...records.slice().reverse().map(row));
  list.scrollTop = scroll;
}

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
  } else {
    box.append(`Exported ${p.total - failed.length} of ${p.total} photos to `, el('code', { textContent: p.filename }));
  }
  if (p.skipped) box.append(el('div', { className: 'muted', textContent: `${p.skipped} skipped: details still loading or failed.` }));
  if (failed.length) {
    const list = el('ul', {}, ...failed.map((f) => el('li', { textContent: `${f.id.slice(0, 16)}…: ${f.error}` })));
    box.append(el('details', {}, el('summary', { className: 'warn', textContent: `${failed.length} failed` }), list));
  }
}

$('export').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'export' });
    if (res?.error) throw new Error(res.error);
  } catch (e) {
    const box = $('export-status');
    box.hidden = false;
    box.textContent = `Couldn't start the export: ${e.message}. Open this popup from a Google Photos tab (refresh it after reloading the extension).`;
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
  await chrome.storage.local.remove((await loadSelection()).map((r) => SEL_PREFIX + r.id));
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
