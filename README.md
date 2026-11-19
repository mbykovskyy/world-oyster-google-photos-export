# World Oyster – Google Photos picker

Chrome extension (Manifest V3) for picking photos in Google Photos to use in the
World Oyster slideshow (`../world-oyster`).

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** → choose the `extension/` folder.
3. Pin the extension. After editing the code, press the reload icon on its card
   and refresh the Google Photos tab.

## Use

- Open <https://photos.google.com> while signed in. The toolbar button is only
  enabled there, after the page shows you're signed in.
- Every photo tile gets a box in its top-right corner. Click to select,
  **Shift+click** to select everything between the last box you clicked and this one.
  Only photos can be selected: video tiles get no box. (`page-hook.js` reads the
  media lists Google Photos loads for its grids, where videos carry extra video
  info, and a video that slips through is dropped once its details show a video file.)
- When a single photo is open, the floating panel (bottom-left) has an
  **Select this photo** button.
- The selection is saved in `chrome.storage.local` as you go (one `sel:<photoId>`
  key per photo), so you can close the tab and continue later.
- Clicking the toolbar button opens a side panel on the right, for that tab only:
  other tabs don't show it, and it comes back when you return to the tab. Each tab
  you click the button in gets its own panel. It shows your
  selection as a masonry grid (newest first; hover a tile for its place and date,
  untick its orange box to remove it; click to open it in Google Photos), lets you switch the picker
  off, and **Export** everything as one zip (see below).

## Export

**Export** in the side panel downloads one zip, `world-oyster-export-YYYY-MM-DD-HHMMSS.zip`:

```
photos.csv             sha,url,date_local,place,latitude,longitude
photo/<sha>.webp       longest side 2048 px   (Google resize: base + "=s2048-rw")
thumbnail/<sha>.webp   longest side 400 px    (base + "=s400-rw")
icon/<sha>.webp        96×96, centre-cropped from the 400 px thumbnail, WebP quality 0.8
```

The folders match `world-oyster/travel_photos/{photo,thumbnail,icon}/`. The
progress bar moves one step per photo (all three sizes), then the zip is put
together and downloaded. Google doesn't upscale, so a photo smaller than 2048 px
keeps its own size. Photos whose details are still loading (or failed) are
skipped, and `photos.csv` lists only the photos in the zip.

The export runs inside the Google Photos tab, because only pages on
photos.google.com can fetch Google's images. Keep that tab open until the zip
downloads. The zip is uncompressed (WebP is already compressed), and the
format limits it to 4 GB, about 8,000 photos.

## CSV columns

`photos.csv` columns:

`sha,url,date_local,place,latitude,longitude`

When a photo is selected, the extension stores a record right away and then
fills in its details with Google Photos' photo-details RPC (`fDcn4b`, called from
`page-rpc.js` in the page's own JS context):

| field | source |
|---|---|
| `sha` | SHA-256 hex of `https://photos.google.com/photo/<id>` (no `/u/N/`) |
| `url` | `https://photos.google.com/photo/<id>` |
| `date_local` | taken-at UTC time + the timezone offset Google stores for the photo |
| `place` | Google's place name for the photo; if Google has no name, or only a region/country ("California, USA"), the nearest town from GeoNames (offline) |
| `latitude`/`longitude` | camera GPS; otherwise Google's location; otherwise Google's place name looked up on OpenStreetMap; otherwise the location (and place) of the nearest-in-time photo with a location taken the same local day |

The same-day photos come from your whole library (Google Photos' `lcxiM`
library-by-date RPC), not just your selection. Photos with no location even then
get a red **No location** label on their tile, in the
floating bar and in the side panel, and their location fields are left empty in the export.

## Geolocation services

- **Place name → coordinates: [Nominatim](https://nominatim.org) (OpenStreetMap).**
  Free, no key, at most one request a second. Requests are queued, spaced 1.1 s
  apart and cached. It tries the full name, then its first and last parts
  ("Karantar, Manakamana, Gandaki Province, Nepal" → "Karantar, Nepal"), like
  `world-oyster/apply_admin.py`. Coordinates are rounded to 5 decimals.
- **Coordinates → place name: [GeoNames](https://www.geonames.org), offline.**
  `extension/data/places.tsv` lists every town of 1,000+ people (cities1000) with
  labels formatted like world-oyster's place names: "Town, ST, United States" in the US,
  "Town, Province, Country" elsewhere. The nearest town is used however far away it
  is. It's used when Google has no place name, or a name that is only a region
  and/or country ("United States", "California, USA", "Gandaki Province, Nepal").
  A region name that is also a town within 50 km of the photo ("Delhi, India")
  is kept. The file also lists region and country names (incl. short forms like
  "USA") so the extension can recognise such names.
  Rebuild it from a fresh
  [GeoNames dump](https://download.geonames.org/export/dump/) (`cities1000.zip`
  unzipped, `admin1CodesASCII.txt`, `countryInfo.txt`) with:

  ```
  python3 tools/build_places.py /path/to/geonames
  ```

  GeoNames data is CC BY 4.0; the side panel credits it.

Details can only be fetched from a Google Photos tab signed in to the account
that owns the photo (`/u/N/`). Pending photos fill in once you open that account.
