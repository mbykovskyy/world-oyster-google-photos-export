// Adds a selection checkbox to every Google Photos grid tile and a floating panel,
// keeps chrome.storage.local in sync with what you tick, and fills in each selected
// photo's details (date, location, type) from Google Photos' own photo-details RPC.
(() => {
  const SEL_PREFIX = 'sel:';
  const CONTENT_OPTIONS = ['Landscape / nature', 'City / architecture', 'People / street life'];
  const ID_RE = /photo\/(AF1Qip[\w-]+)/;
  const TILE_LINK = 'a[href*="photo/AF1Qip"]';
  const VIDEO_EXT = /\.(mp4|mov|m4v|3gp|avi|mkv|webm|mts|m2ts|wmv)$/i;
  const PIN_OFF_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/><path d="M3.5 3.5l17 17" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';

  let enabled = true;
  let loggedIn = false;
  let reportedLoggedIn = null;
  let contentDefault = CONTENT_OPTIONS[0];
  const records = new Map(); // id -> stored selection record
  let lastClickedId = null;
  let panel = null;

  // ---------- helpers ----------

  const accountIndex = () => (location.pathname.match(/^\/u\/(\d+)\//) || [])[1] || '0';
  const canonicalUrl = (id) => `https://photos.google.com/photo/${id}`;
  const hasLocation = (r) => r.latitude != null && r.longitude != null;

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Base thumbnail URL (size suffix stripped), from the tile's background image.
  function thumbFromTile(link) {
    for (const el of link.querySelectorAll('*')) {
      const m = getComputedStyle(el).backgroundImage.match(/url\("?(https:\/\/[^")]+)"?\)/);
      if (m && /usercontent/.test(m[1])) return m[1].replace(/=[whs]\d[^/]*$/, '');
    }
    return null;
  }

  function thumbFromViewer() {
    let best = null;
    for (const img of document.querySelectorAll('img[src*="usercontent"]')) {
      const r = img.getBoundingClientRect();
      if (r.width && (!best || r.width * r.height > best.area)) best = { img, area: r.width * r.height };
    }
    return best ? best.img.src.replace(/=[whs]\d[^/]*$/, '') : null;
  }

  const typeFromLabel = (label) => (/^video/i.test(label || '') ? 'video' : label ? 'photo' : null);

  // New record; details are filled in asynchronously by the details queue.
  function newRecord(id, link) {
    const label = link?.getAttribute('aria-label');
    return {
      id,
      account: accountIndex(),
      sha: null,
      url: canonicalUrl(id),
      date_local: null,
      content: contentDefault,
      place: null,
      latitude: null,
      longitude: null,
      location_method: null,
      type: typeFromLabel(label),
      thumb: link ? thumbFromTile(link) : thumbFromViewer(),
      status: 'pending',
      error: null,
      addedAt: Date.now(),
    };
  }

  const viewerPhotoId = () => (location.pathname.match(/\/photo\/(AF1Qip[\w-]+)/) || [])[1] || null;

  function detectLogin() {
    if (location.pathname.startsWith('/about') || location.pathname.startsWith('/login')) return false;
    // Once seen in this page session we stay logged in (the header can be hidden in the photo viewer).
    return loggedIn || !!document.querySelector('a[href*="SignOutOptions"]');
  }

  // ---------- RPC bridge to page-rpc.js (MAIN world) ----------

  const rpcPending = new Map();
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'wo-rpc-res') return;
    const p = rpcPending.get(e.data.reqId);
    if (!p) return;
    rpcPending.delete(e.data.reqId);
    e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.result);
  });

  function rpc(rpcid, args) {
    return new Promise((resolve, reject) => {
      const reqId = `${Date.now()}-${Math.random()}`;
      rpcPending.set(reqId, { resolve, reject });
      window.postMessage({ source: 'wo-rpc-req', reqId, rpcid, args }, location.origin);
      setTimeout(() => rpcPending.delete(reqId) && reject(new Error('RPC timed out')), 20000);
    });
  }

  // ---------- preview thumbnail ----------
  // Google's thumbnail URLs only work with your Google cookies, which the popup
  // (a chrome-extension:// page) doesn't get. So the content script, which runs on
  // photos.google.com, fetches a small copy and stores it as a WebP data URL (~5 KB).

  // Google image URLs need the owning account's authuser, or the request fails.
  async function fetchImage(thumb, account, size) {
    const res = await fetch(`${thumb}=${size}?authuser=${account}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`image HTTP ${res.status}`);
    return res.blob();
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  // Draw a region of an image into a w×h canvas and encode it as WebP.
  async function encodeWebp(blob, w, h, quality, crop) {
    const bitmap = await createImageBitmap(blob);
    const [sx, sy, sw, sh] = crop ? crop(bitmap) : [0, 0, bitmap.width, bitmap.height];
    const canvas = new OffscreenCanvas(w || sw, h || sh);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.convertToBlob({ type: 'image/webp', quality });
  }

  const centreSquare = (b) => {
    const side = Math.min(b.width, b.height);
    return [(b.width - side) / 2, (b.height - side) / 2, side, side];
  };

  async function makePreview(thumb, account) {
    const blob = await fetchImage(thumb, account, 'w104-h104-c-k-no');
    return blobToDataUrl(await encodeWebp(blob, 0, 0, 0.7));
  }

  // null = tried and failed (don't retry endlessly); undefined = not tried yet.
  const previewFor = (rec) => (rec.thumb ? makePreview(rec.thumb, rec.account).catch(() => null) : Promise.resolve(null));

  // ---------- photo details ----------

  // ---------- location from the nearest located photo the same day ----------
  // lcxiM lists library items newest first, taken at or before a timestamp:
  //   [items, nextPageToken, ...]; item = [id, [thumb, w, h, ...], takenUtcMs, _, tzOffsetMs, ..., item[9] = {...}]
  //   item[9]["129168200"][1] = [[lat*1e7, lng*1e7], _, _, _, [[_, [[placeName, ...]]], ...]] when it has a location.

  const DAY_MS = 86400000;
  const dayCache = new Map(); // `${account}:${dayStart}` -> Promise<items>

  const itemLocation = (item) => {
    const loc = item?.[9]?.['129168200']?.[1];
    if (!Array.isArray(loc?.[0]) || loc[0][0] == null) return null;
    return { lat: loc[0][0], lng: loc[0][1], place: loc[4]?.[0]?.[1]?.[0]?.[0] || null };
  };

  // Library items taken on the local day [dayStart, dayStart + 1 day) (UTC ms bounds).
  function itemsOfDay(dayStart) {
    const key = `${accountIndex()}:${dayStart}`;
    if (!dayCache.has(key)) {
      const load = async () => {
        const items = [];
        let token = null;
        for (let page = 0; page < 10; page++) {
          const r = await rpc('lcxiM', [token, dayStart + DAY_MS, 500, null, 1, 1]);
          const batch = r?.[0] || [];
          items.push(...batch.filter((i) => i[2] >= dayStart && i[2] < dayStart + DAY_MS));
          token = r?.[1];
          if (!token || !batch.length || batch.at(-1)[2] < dayStart) break;
        }
        return items;
      };
      const p = load();
      p.catch(() => dayCache.delete(key));
      dayCache.set(key, p);
      setTimeout(() => dayCache.delete(key), 10 * 60000); // library changes; don't keep stale lists forever
    }
    return dayCache.get(key);
  }

  const gapText = (ms) => {
    const min = Math.round(ms / 60000);
    return min < 60 ? `${min} min` : `${(ms / 3600000).toFixed(1)} h`;
  };

  // Nearest-in-time photo with a location, taken the same local day (in the photo's timezone).
  async function locationFromSameDay(id, takenUtc, tz) {
    const localMs = takenUtc + tz;
    const dayStart = Math.floor(localMs / DAY_MS) * DAY_MS - tz; // UTC ms of local midnight
    let best = null;
    for (const item of await itemsOfDay(dayStart)) {
      if (item[0] === id) continue;
      // Same calendar day in each photo's own local time.
      if (Math.floor((item[2] + (item[4] ?? tz)) / DAY_MS) !== Math.floor(localMs / DAY_MS)) continue;
      const loc = itemLocation(item);
      if (!loc) continue;
      const gap = item[2] - takenUtc;
      if (!best || Math.abs(gap) < Math.abs(best.gap)) best = { ...loc, gap };
    }
    return best;
  }

  // x[3] = taken-at UTC ms, x[4] = timezone offset ms, x[2] = filename,
  // x[9] = camera GPS [[lat*1e7, lng*1e7], ...], x[13] = Google's location [[lat*1e7, lng*1e7], _, [[_, [[placeName]]]]]
  async function fetchDetails(rec) {
    const x = (await rpc('fDcn4b', [rec.id, 1, null, null, 1]))?.[0];
    if (!x) throw new Error('Photo not found in this Google account');

    const out = { sha: await sha256Hex(canonicalUrl(rec.id)) };
    if (!rec.preview) out.preview = await previewFor(rec);
    if (typeof x[3] === 'number') out.date_local = new Date(x[3] + (x[4] || 0)).toISOString().slice(0, 19);
    out.type = VIDEO_EXT.test(x[2] || '') ? 'video' : rec.type || 'photo';

    const gps = x[9]?.[0];
    const google = x[13];
    const place = google?.[2]?.[0]?.[1]?.[0]?.[0] || null;
    const coord = (v) => Math.round(v / 10) / 1e6; // 1e7 fixed point -> 6 decimals
    out.place = place;
    out.latitude = out.longitude = null;
    out.location_method = null;

    if (Array.isArray(gps) && gps[0] != null) {
      [out.latitude, out.longitude] = [coord(gps[0]), coord(gps[1])];
      out.location_method = 'camera GPS';
    } else if (Array.isArray(google?.[0]) && google[0][0] != null) {
      [out.latitude, out.longitude] = [coord(google[0][0]), coord(google[0][1])];
      out.location_method = 'Google estimated';
    } else if (place) {
      // Place name but no coordinates: OpenStreetMap (Nominatim).
      const geo = await chrome.runtime.sendMessage({ type: 'placeToCoords', place });
      if (geo) {
        [out.latitude, out.longitude] = [geo.lat, geo.lng];
        out.location_method = `Google Photos recognised the place as "${place}"; coordinates from OpenStreetMap`;
      }
    }
    if (out.latitude == null && typeof x[3] === 'number') {
      // Still nothing: borrow the location of the nearest located photo taken the same day.
      out.sameDayChecked = true;
      const near = await locationFromSameDay(rec.id, x[3], x[4] || 0);
      if (near) {
        [out.latitude, out.longitude] = [coord(near.lat), coord(near.lng)];
        out.place = near.place;
        out.location_method = `estimated from nearest located photo (${gapText(Math.abs(near.gap))} ${near.gap >= 0 ? 'later' : 'earlier'})`;
      }
    }
    if (out.latitude != null) {
      // No place name, or only a country ("United States"): nearest GeoNames town instead.
      out.place = await chrome.runtime.sendMessage({ type: 'placeFor', lat: out.latitude, lng: out.longitude, googlePlace: out.place });
    }
    return out;
  }

  // Fill in details for pending records of the account this tab is signed into,
  // and previews for records saved before previews existed.
  const inFlight = new Set();
  const MAX_PARALLEL = 3;
  const needsPreviewOnly = (rec) => rec.status === 'ok' && rec.preview === undefined && !!rec.thumb;
  function pumpDetails() {
    if (!loggedIn) return;
    const account = accountIndex();
    for (const rec of records.values()) {
      if (inFlight.size >= MAX_PARALLEL) break;
      if (rec.account !== account || inFlight.has(rec.id)) continue;
      let work;
      if (rec.status === 'pending') {
        work = fetchDetails(rec)
          .then((details) => ({ ...details, status: 'ok', error: null }))
          .catch((err) => ({ status: 'error', error: String(err.message || err) }));
      } else if (needsPreviewOnly(rec)) {
        work = previewFor(rec).then((preview) => ({ preview }));
      } else continue;
      inFlight.add(rec.id);
      work
        .then(async (patch) => {
          // Merge into the latest stored version, unless it was deselected meanwhile.
          const key = SEL_PREFIX + rec.id;
          const { [key]: current } = await chrome.storage.local.get(key);
          if (current) await chrome.storage.local.set({ [key]: { ...current, ...patch } });
        })
        .finally(() => {
          inFlight.delete(rec.id);
          pumpDetails();
        });
    }
  }

  // ---------- export: one zip with photos.csv + photo/, thumbnail/, icon/ ----------
  // Runs here because only photos.google.com pages can fetch Google's images.
  // One progress step per photo; progress is kept in storage under "exportProgress"
  // so the popup can show it (and survive being closed and reopened).

  let exporting = false;

  // The three sizes for one photo: 2048 px and 400 px longest side (Google resizes),
  // and a 96×96 centre crop of the 400 px thumbnail at WebP quality 0.8.
  async function photoFiles(rec) {
    const asWebp = async (blob) => (blob.type === 'image/webp' ? blob : encodeWebp(blob, 0, 0, 0.9));
    const photo = await asWebp(await fetchImage(rec.thumb, rec.account, 's2048-rw'));
    const thumbnail = await asWebp(await fetchImage(rec.thumb, rec.account, 's400-rw'));
    const icon = await encodeWebp(thumbnail, 96, 96, 0.8, centreSquare);
    return { photo, thumbnail, icon };
  }

  function saveBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  async function runExport() {
    if (exporting) return;
    exporting = true;
    const all = [...records.values()];
    const ready = all.filter((r) => r.status === 'ok' && r.sha && r.thumb)
      .sort((a, b) => (a.date_local || '').localeCompare(b.date_local || ''));
    const d = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    const filename = `world-oyster-export-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.zip`;
    const progress = {
      running: true, filename, total: ready.length, done: 0, failed: [],
      skipped: all.length - ready.length, heartbeat: Date.now(), finishedAt: null,
    };
    const save = () => chrome.storage.local.set({ exportProgress: { ...progress, heartbeat: Date.now() } });
    await save();

    // Fetch two photos at a time, but add them to the zip in date order.
    const results = new Array(ready.length);
    let next = 0;
    const worker = async () => {
      while (next < ready.length) {
        const i = next++;
        try {
          results[i] = await photoFiles(ready[i]);
        } catch (err) {
          results[i] = null;
          progress.failed.push({ id: ready[i].id, error: String(err.message || err) });
        }
        progress.done++;
        await save();
      }
    };
    try {
      await Promise.all([worker(), worker()]);
      const exported = ready.filter((r, i) => results[i]);
      if (!exported.length) throw new Error('No photos could be exported');
      const zip = new ZipWriter(d);
      const csv = await chrome.runtime.sendMessage({ type: 'csv', ids: exported.map((r) => r.id) });
      await zip.add('photos.csv', csv);
      for (const [i, rec] of ready.entries()) {
        if (!results[i]) continue;
        for (const dir of ['photo', 'thumbnail', 'icon']) await zip.add(`${dir}/${rec.sha}.webp`, results[i][dir]);
        results[i] = null; // let the blobs go once they're in the zip
        if (i % 25 === 0) await save(); // heartbeat, so the popup knows we're still zipping
      }
      saveBlob(zip.finish(), filename);
    } catch (err) {
      progress.error = String(err.message || err);
    } finally {
      progress.running = false;
      progress.finishedAt = Date.now();
      await save();
      exporting = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'export') return;
    if (!loggedIn) return sendResponse({ error: 'Not signed in to Google Photos in this tab' });
    sendResponse({ started: !exporting });
    runExport();
  });

  // ---------- storage ----------

  async function select(newRecords) {
    const items = {};
    for (const r of newRecords) items[SEL_PREFIX + r.id] = r;
    await chrome.storage.local.set(items);
  }

  const deselect = (ids) => chrome.storage.local.remove(ids.map((id) => SEL_PREFIX + id));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key === 'enabled') enabled = newValue !== false;
      else if (key === 'contentDefault') contentDefault = newValue || CONTENT_OPTIONS[0];
      else if (key.startsWith(SEL_PREFIX)) {
        const id = key.slice(SEL_PREFIX.length);
        newValue ? records.set(id, newValue) : records.delete(id);
      }
    }
    render();
    pumpDetails();
  });

  // ---------- UI ----------

  function visibleTileLinks() {
    return [...document.querySelectorAll(TILE_LINK)].filter((a) => a.offsetWidth >= 40 && ID_RE.test(a.getAttribute('href')));
  }

  // Status pill shown on selected tiles: loading / no location / error.
  function statusOf(rec) {
    if (!rec) return null;
    if (rec.status === 'pending') return { cls: 'wo-loading', html: '<span class="wo-spin"></span>details…', title: 'Fetching photo details' };
    if (rec.status === 'error') return { cls: 'wo-error', html: '⚠ no details', title: rec.error || 'Could not fetch photo details' };
    if (!hasLocation(rec)) return { cls: 'wo-noloc', html: `${PIN_OFF_SVG}No location`, title: 'No location found for this photo or any photo from the same day' };
    return null;
  }

  function setPill(container, rec) {
    let pill = container.querySelector(':scope > .wo-pill');
    const s = statusOf(rec);
    if (!s) return pill?.remove();
    if (!pill) {
      pill = document.createElement('div');
      container.appendChild(pill);
    }
    if (pill.dataset.html !== s.html) {
      pill.innerHTML = s.html;
      pill.dataset.html = s.html;
    }
    pill.className = `wo-pill ${s.cls}`;
    pill.title = s.title;
  }

  function renderTiles() {
    const show = enabled && loggedIn;
    for (const link of document.querySelectorAll(TILE_LINK)) {
      const tile = link.parentElement;
      let box = tile.querySelector(':scope > .wo-check');
      if (!show || link.offsetWidth < 40) {
        box?.remove();
        tile.querySelector(':scope > .wo-pill')?.remove();
        tile.classList.remove('wo-selected');
        continue;
      }
      const id = link.getAttribute('href').match(ID_RE)?.[1];
      if (!id) continue;
      if (!box) {
        box = document.createElement('div');
        box.className = 'wo-check';
        box.setAttribute('role', 'checkbox');
        box.title = 'World Oyster: select for slideshow (Shift+click for a range)';
        tile.appendChild(box);
      }
      // Tiles are recycled while scrolling, so always re-read the id.
      box.dataset.id = id;
      const rec = records.get(id);
      box.setAttribute('aria-checked', String(!!rec));
      tile.classList.toggle('wo-selected', !!rec);
      setPill(tile, rec);
    }
  }

  function renderPanel() {
    if (!enabled || !loggedIn) {
      panel?.remove();
      panel = null;
      return;
    }
    // Google Photos prunes unknown children of <body>, so live under <html> and re-attach if removed.
    if (!panel?.isConnected) {
      panel = document.createElement('div');
      panel.className = 'wo-panel';
      panel.innerHTML = `
        <span class="wo-count"></span>
        <span class="wo-missing" title="Selected photos without a location"></span>
        <label class="wo-content" title="Content category for newly selected photos">
          <select>${CONTENT_OPTIONS.map((c) => `<option>${c}</option>`).join('')}</select>
        </label>
        <span class="wo-this-wrap"><button class="wo-this" type="button"></button></span>`;
      panel.querySelector('select').addEventListener('change', (e) => chrome.storage.local.set({ contentDefault: e.target.value }));
      document.documentElement.appendChild(panel);
    }
    const all = [...records.values()];
    const missing = all.filter((r) => r.status === 'ok' && !hasLocation(r)).length;
    const loading = all.filter((r) => r.status === 'pending').length;
    panel.querySelector('.wo-count').textContent = `🦪 ${all.length} selected${loading ? ` · ${loading} loading` : ''}`;
    const miss = panel.querySelector('.wo-missing');
    miss.hidden = !missing;
    if (missing && miss.dataset.n !== String(missing)) {
      miss.innerHTML = `${PIN_OFF_SVG}No location: ${missing}`;
      miss.dataset.n = String(missing);
    }
    const select = panel.querySelector('select');
    if (document.activeElement !== select) select.value = contentDefault;

    const id = viewerPhotoId();
    const wrap = panel.querySelector('.wo-this-wrap');
    const btn = panel.querySelector('.wo-this');
    wrap.hidden = !id;
    if (id) {
      const rec = records.get(id);
      btn.dataset.id = id;
      btn.textContent = rec ? '✓ In slideshow' : '+ Add this photo';
      btn.classList.toggle('wo-on', !!rec);
      setPill(wrap, rec);
    }
  }

  let scheduled = false;
  function render() {
    if (scheduled) return;
    scheduled = true;
    // setTimeout rather than requestAnimationFrame: rAF is paused in background tabs.
    setTimeout(() => {
      scheduled = false;
      renderTiles();
      renderPanel();
    }, 30);
  }

  // ---------- events ----------

  function onTileCheck(box, shiftKey) {
    const id = box.dataset.id;
    const turnOn = !records.has(id);
    let links = [];

    if (shiftKey && lastClickedId && lastClickedId !== id) {
      // Range in visual order among tiles currently rendered.
      const ordered = visibleTileLinks().sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return ra.top - rb.top || ra.left - rb.left;
      });
      const ids = ordered.map((a) => a.getAttribute('href').match(ID_RE)[1]);
      const i = ids.indexOf(lastClickedId), j = ids.indexOf(id);
      if (i !== -1 && j !== -1) links = ordered.slice(Math.min(i, j), Math.max(i, j) + 1);
    }
    if (!links.length) links = [box.parentElement.querySelector(':scope > a')];
    lastClickedId = id;

    const ids = links.map((a) => a.getAttribute('href').match(ID_RE)[1]);
    if (turnOn) {
      // Keep existing records (and their content choice) for photos already selected.
      select(links.filter((a, i) => !records.has(ids[i])).map((a) => newRecord(a.getAttribute('href').match(ID_RE)[1], a)));
    } else {
      deselect(ids);
    }
  }

  // Capture on window so Google's own handlers (open photo, drag-select, shortcuts) never see our events.
  const SWALLOW = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup', 'keypress'];
  for (const type of SWALLOW) {
    window.addEventListener(type, (e) => {
      const target = e.target instanceof Element ? e.target.closest('.wo-check, .wo-panel, .wo-pill') : null;
      if (!target) return;
      e.stopPropagation();
      if (target.classList.contains('wo-check')) e.preventDefault();
      if (type !== 'click') return;
      if (target.classList.contains('wo-check')) onTileCheck(target, e.shiftKey);
      else if (e.target.closest('.wo-this')) {
        const id = e.target.closest('.wo-this').dataset.id;
        records.has(id) ? deselect([id]) : select([newRecord(id, document.querySelector(`a[href*="photo/${id}"]`))]);
      }
    }, true);
  }

  function tick() {
    loggedIn = detectLogin();
    if (loggedIn !== reportedLoggedIn) {
      reportedLoggedIn = loggedIn;
      chrome.runtime.sendMessage({ type: 'status', loggedIn }).catch(() => {});
      pumpDetails();
    }
    render();
  }

  new MutationObserver(tick).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['href'],
  });
  setInterval(tick, 1500); // catches SPA navigations that don't mutate watched nodes

  chrome.storage.local.get(null).then(async (all) => {
    enabled = all.enabled !== false;
    contentDefault = all.contentDefault || CONTENT_OPTIONS[0];
    const upgrade = {};
    for (const [key, rec] of Object.entries(all)) {
      if (!key.startsWith(SEL_PREFIX)) continue;
      // Records from v0.1 had no details: queue them.
      if (!rec.status) upgrade[key] = { ...rec, url: canonicalUrl(rec.id), content: rec.content || contentDefault, status: 'pending' };
      // Located-less records from before the same-day rule: fetch again once.
      else if (rec.status === 'ok' && rec.latitude == null && !rec.sameDayChecked) upgrade[key] = { ...rec, status: 'pending' };
      records.set(rec.id, upgrade[key] || rec);
    }
    if (Object.keys(upgrade).length) await chrome.storage.local.set(upgrade);
    tick();
    pumpDetails();
    fixPlaces();
  });

  // Records saved before the current place rules: re-label region/country-only names
  // ("United States", "California, USA") and drop the old "Near " prefix, using GeoNames.
  async function fixPlaces() {
    for (const rec of [...records.values()]) {
      if (rec.status !== 'ok' || rec.latitude == null) continue;
      const near = rec.place?.startsWith('Near ');
      if (rec.place && !near && rec.place.split(',').length > 2) continue; // "Town, Region, Country" is fine
      const place = await chrome.runtime.sendMessage({
        type: 'placeFor', lat: rec.latitude, lng: rec.longitude, googlePlace: near ? null : rec.place,
      });
      if (!place || place === rec.place) continue;
      const key = SEL_PREFIX + rec.id;
      const { [key]: current } = await chrome.storage.local.get(key);
      if (current?.place === rec.place) await chrome.storage.local.set({ [key]: { ...current, place } });
    }
  }
})();
