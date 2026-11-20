# CLAUDE.md

Chrome extension (Manifest V3, plain JS, no build step) for picking Google Photos
for the World Oyster slideshow and exporting them as one zip. User-facing docs are
in `README.md`; this file is for working on the code.

## Architecture

Only pages on photos.google.com send the user's Google cookies, so everything that
talks to Google (photo details, image downloads, export) runs in the Google Photos
tab. Extension pages (side panel, service worker) never load Google URLs directly.

| file | runs in | job |
|---|---|---|
| `page-hook.js` | page MAIN world, `document_start` | reads Google's own grid data (fetch responses + embedded `AF_initDataCallback` data) and forwards each batch (ID, video?, thumbnail, taken time) with the view it belongs to; keeps nothing, only buffers until `content.js` is listening |
| `page-rpc.js` | page MAIN world, `document_idle` | makes Google's internal `batchexecute` requests for `content.js` (needs `WIZ_global_data` tokens) |
| `content.js` + `content.css` | content script (isolated world) | tile controls, viewer button, floating bar, details queue, previews, export, larger images for the panel viewer |
| `background.js` | service worker (module) | per-tab side panel and toolbar button, badge, CSV, geocoding |
| `geo.js` | imported by `background.js` | OpenStreetMap Nominatim (place → coords, 1 req/s, cached) and offline GeoNames (`data/places.tsv`, coords → place) |
| `panel.html/js/css` | side panel (per tab) | masonry grid of the selection, photo viewer, export progress |
| `shared.js` | imported by panel + background | storage layout, export columns, CSV |
| `zip.js` | content script | store-only zip writer |

The data model, one `sel:<photoId>` key per photo in `chrome.storage.local`, is documented at the top of `shared.js`.

## Rules

- **Don't parse UI text.** No dates, types or anything else from aria-labels, titles or
  visible text, and no obfuscated Google class names. Use Google's internal data
  (`fDcn4b` photo details, `lcxiM` library listing, grid data read by `page-hook.js`) or
  structural/ARIA hooks (`role="menubar"` for the viewer toolbar).
- **Photos only.** Videos get no tile control and no viewer button, and ranges skip them.
  A video that slips through is dropped when its details show a video file name.
- **Media lists are bounded** (`content.js`, "media lists"): `items` (facts for every item
  seen, any view) and `lists` (each view's order, for Shift+click), least recently used
  dropped first. Never clear them on view changes: Google re-shows cached views without
  re-fetching, so forgotten items wouldn't come back.
- **Shift+click** takes the range only from the backend's list order (a loaded list holding
  both photos, the current view's first), never from tile positions in the page. If either
  photo isn't in a loaded list, just the clicked photo, like Google.
- **Touch the page's DOM only on change.** A `MutationObserver` re-renders on DOM changes,
  so writing the same text or classes every render causes a render loop. See
  `setOysterState` (it caches the state in `data-state`).
- **One place for the oyster control's states.** Tile control and viewer button share
  `setOysterState` / `OYSTER_LABELS` (`content.js`) and the `.wo-oyster` styles
  (`content.css`). Only size and placement differ (`--size`, `--img`, `--badge`, `--gap`).
- Google prunes unknown children of `<body>`: the floating bar is attached to `<html>`.

## Fragile dependencies (check these first when Google changes something)

- RPC IDs `fDcn4b` and `lcxiM`, and their array positions (commented in `content.js`).
- Video marker: key `"76647426"` in an item's info object (`page-hook.js`).
- List requests and where the view's identity is: library `lcxiM`; album `snAcKc`
  (album ID = 1st argument, items at `data[1]`); search `EzkLib` (query = 8th argument).
  On a full load the first library/album batch is embedded in the page instead.
- `fetch` hook: copy the request before calling fetch and the response before the page
  reads it, or their bodies are already used.
- Viewer toolbar: `[role="menubar"]`, buttons in its right half (`viewerToolbarGroup`).
- Tile links `a[href*="photo/AF1Qip"]` and the thumbnail as a CSS background image.
- Sign-in detection: `a[href*="SignOutOptions"]`.

## Testing

No automated tests. Load `extension/` unpacked in `chrome://extensions`. After a code
change: reload the extension **and** refresh the Google Photos tab (a tab refresh alone
keeps running the old content scripts). Reopen the side panel for panel changes.

`tools/build_places.py` rebuilds `extension/data/places.tsv` from a GeoNames dump
(see README).
