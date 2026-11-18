// Geolocation helpers used by the background service worker.
//
//   placeToCoords(place)  place name -> { lat, lng } via Nominatim (OpenStreetMap)
//   coordsToPlace(lat, lng) coordinates -> "Town, Region, Country" via the bundled
//                           GeoNames town list (data/places.tsv), offline
//
// GeoNames data: CC BY 4.0, https://www.geonames.org

// ---------- place name -> coordinates (Nominatim) ----------
// Nominatim allows 1 request/second; requests are queued and results cached in
// chrome.storage.local under "geo:<query>". (Browsers don't let extensions set a
// custom User-Agent; requests are identified by the extension's Origin header.)

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
let nominatimQueue = Promise.resolve();

function nominatim(query) {
  const key = `geo:${query}`;
  const run = async () => {
    const cached = await chrome.storage.local.get(key);
    if (key in cached) return cached[key];
    const params = new URLSearchParams({ q: query, format: 'json', limit: '1' });
    const res = await fetch(`${NOMINATIM}?${params}`, { headers: { Accept: 'application/json' } });
    await new Promise((r) => setTimeout(r, 1100));
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    const [hit] = await res.json();
    const result = hit ? { lat: Math.round(hit.lat * 1e5) / 1e5, lng: Math.round(hit.lon * 1e5) / 1e5 } : null;
    await chrome.storage.local.set({ [key]: result });
    return result;
  };
  const p = nominatimQueue.then(run, run);
  nominatimQueue = p.catch(() => {});
  return p;
}

// Full name first, then its first and last parts ("Karantar, Manakamana, Gandaki
// Province, Nepal" -> "Karantar, Nepal"), like world-oyster's apply_admin.py.
export async function placeToCoords(place) {
  const parts = place.split(',').map((p) => p.trim()).filter(Boolean);
  const queries = [place, ...(parts.length > 2 ? [`${parts[0]}, ${parts.at(-1)}`] : [])];
  for (const q of queries) {
    const hit = await nominatim(q);
    if (hit) return hit;
  }
  return null;
}

// ---------- coordinates -> place name (GeoNames, offline) ----------

const EARTH_KM = 6371;
const CELL = 1; // grid cell size in degrees

let townsPromise = null;

function loadTowns() {
  townsPromise ??= (async () => {
    const text = await (await fetch(chrome.runtime.getURL('data/places.tsv'))).text();
    const suffixes = [], regions = new Set(), countries = new Set();
    const names = [], lats = [], lngs = [], sfx = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      const cols = line.split('\t');
      if (cols.length === 2) {
        if (cols[0] === 'S') suffixes.push(cols[1]);
        else if (cols[0] === 'R') regions.add(cols[1].toLowerCase());
        else if (cols[0] === 'C') countries.add(cols[1].toLowerCase());
        continue;
      }
      names.push(cols[0]);
      lats.push(+cols[1]);
      lngs.push(+cols[2]);
      sfx.push(+cols[3]);
    }
    // Bucket towns into 1° cells so a lookup only scans nearby cells.
    const grid = new Map();
    lats.forEach((lat, i) => {
      const k = `${Math.floor(lat / CELL)},${Math.floor(lngs[i] / CELL)}`;
      (grid.get(k) || grid.set(k, []).get(k)).push(i);
    });
    return { suffixes, names, lats, lngs, sfx, grid, regions, countries };
  })();
  return townsPromise;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export async function coordsToPlace(lat, lng) {
  const t = await loadTowns();
  const cy = Math.floor(lat / CELL), cx = Math.floor(lng / CELL);
  let best = -1, bestKm = Infinity, bounded = false;
  // Widen the search ring until a town is found and no closer one can lie outside it.
  // Near the poles cells get too narrow for this, so those go straight to the full scan.
  for (let ring = 0; ring <= 30 && Math.abs(lat) <= 60; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dy), Math.abs(dx)) !== ring) continue;
        const x = ((cx + dx + 180) % 360 + 360) % 360 - 180; // wrap longitude
        for (const i of t.grid.get(`${cy + dy},${x}`) || []) {
          const km = haversineKm(lat, lng, t.lats[i], t.lngs[i]);
          if (km < bestKm) { bestKm = km; best = i; }
        }
      }
    }
    // One cell is at least ~111 km * cos(lat) wide; stop once the best hit is inside the searched area.
    const searchedKm = ring * CELL * 111 * Math.max(0.1, Math.cos((Math.min(89, Math.abs(lat)) * Math.PI) / 180));
    if (best !== -1 && bestKm <= searchedKm) { bounded = true; break; }
  }
  if (!bounded) {
    // Polar or open-ocean point: scan every town (a few ms).
    for (let i = 0; i < t.names.length; i++) {
      const km = haversineKm(lat, lng, t.lats[i], t.lngs[i]);
      if (km < bestKm) { bestKm = km; best = i; }
    }
  }
  if (best === -1) return null;
  return t.names[best] + t.suffixes[t.sfx[best]];
}

const SAME_NAME_KM = 50;
const ADMIN_WORDS = /\b(province|state|county|prefecture|oblast|governorate|voivodeship|canton|territory)\b/i;

// Is there a town called `name` within SAME_NAME_KM of the point? ("Delhi" near Delhi.)
function townNamedNear(t, name, lat, lng) {
  const want = name.toLowerCase();
  const cy = Math.floor(lat / CELL), cx = Math.floor(lng / CELL);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = ((cx + dx + 180) % 360 + 360) % 360 - 180;
      for (const i of t.grid.get(`${cy + dy},${x}`) || []) {
        if (t.names[i].toLowerCase() === want && haversineKm(lat, lng, t.lats[i], t.lngs[i]) <= SAME_NAME_KM) return true;
      }
    }
  }
  return false;
}

// True when a place name only names a region and/or country: "United States",
// "California, USA", "Baja California Sur, Mexico". A name that is also a town near
// the photo ("Delhi, India", "New York, USA") counts as a real place.
export async function isCoarsePlace(place, lat, lng) {
  if (!place) return false;
  const t = await loadTowns();
  const parts = place.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  // Region names GeoNames spells differently ("Gandaki Province" vs "Gandaki Pradesh", "County Cork").
  const isRegion = (p) => t.regions.has(p) || ADMIN_WORDS.test(p);
  if (parts.length === 1) return t.countries.has(parts[0]) || (isRegion(parts[0]) && !townNamedNear(t, parts[0], lat, lng));
  if (parts.length === 2) {
    return (isRegion(parts[0]) || t.countries.has(parts[0])) && t.countries.has(parts[1]) &&
      !townNamedNear(t, parts[0], lat, lng);
  }
  return false;
}

// Place label for a photo: Google's name, unless it's missing or only a
// region/country, then the nearest GeoNames town.
export async function placeFor(lat, lng, googlePlace) {
  if (googlePlace && !(await isCoarsePlace(googlePlace, lat, lng))) return googlePlace;
  return (await coordsToPlace(lat, lng)) || googlePlace || null;
}
