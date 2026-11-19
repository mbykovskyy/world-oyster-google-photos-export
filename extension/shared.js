// Shared by panel.js and background.js (content scripts can't use ES module imports,
// so content.js repeats SEL_PREFIX).
//
// Storage layout in chrome.storage.local:
//   "enabled"         -> boolean (default true): show the selection overlay on Google Photos
//   "geo:<query>"     -> cached OpenStreetMap geocode { lat, lng } or null
//   "exportProgress"  -> { running, filename, total, done, failed: [{ id, error }], skipped, heartbeat, finishedAt }
//   "sel:<photoId>"   -> selection record:
//      { id, account, sha, url, date_local, content, place, latitude, longitude,
//        location_method, type, thumb, preview, status: 'pending' | 'ok' | 'error', error, addedAt }
//      thumb   = Google's base thumbnail URL (only loads with Google cookies)
//      preview = small WebP data URL made from it on photos.google.com, shown in the side panel (null if it couldn't be made)
// One key per photo so selections made in different tabs never overwrite each other.

export const SEL_PREFIX = 'sel:';

// Export columns, same as world-oyster/google_photos_landscape_city_people.csv.
// "content" is kept as a column but left blank (no category is determined).
export const EXPORT_FIELDS = ['sha', 'url', 'date_local', 'content', 'place', 'latitude', 'longitude', 'location_method', 'type'];

export const byDate = (a, b) => (a.date_local || '').localeCompare(b.date_local || '') || a.addedAt - b.addedAt;

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(records) {
  const rows = records.slice().sort(byDate).map((r) => EXPORT_FIELDS.map((f) => csvCell(r[f])).join(','));
  return [EXPORT_FIELDS.join(','), ...rows].join('\n') + '\n';
}

export async function loadSelection() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith(SEL_PREFIX))
    .map(([, record]) => record);
}

export const hasLocation = (r) => r.latitude != null && r.longitude != null;

export function thumbUrl(record, size = 200) {
  if (!record.thumb) return null;
  return `${record.thumb}=w${size}-h${size}-c-k-no?authuser=${record.account || 0}`;
}

// Link that opens the photo in the right Google account.
export const accountUrl = (r) =>
  `https://photos.google.com/${r.account && r.account !== '0' ? `u/${r.account}/` : ''}photo/${r.id}`;
