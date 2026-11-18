#!/usr/bin/env python3
"""Build extension/data/places.tsv, the offline town list for reverse geocoding.

Usage: python3 tools/build_places.py /path/to/geonames

The geonames folder holds cities1000.txt (cities1000.zip unzipped),
admin1CodesASCII.txt and countryInfo.txt from https://download.geonames.org/export/dump/.
GeoNames data is CC BY 4.0 (https://www.geonames.org).

Labels follow world-oyster's old name_places.py: "Town, ST, United States" in the
US, "Town, Province, Country" elsewhere (province dropped if it equals the town).

Output format (tab separated, UTF-8):
  R<TAB><name>                        a region (state/province) name, e.g. "California"
  C<TAB><name>                        a country name or common short form, e.g. "United States", "USA"
  S<TAB><suffix>                      one line per distinct ", Region, Country" suffix, in index order
  <town><TAB><lat><TAB><lng><TAB><suffix index>

R and C lines let the extension tell a region- or country-only place name
("California, USA") from a real place.
"""
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "extension" / "data" / "places.tsv"

# Short country names Google Photos uses in place labels.
COUNTRY_ALIASES = ["USA", "United States of America", "UK", "Great Britain", "UAE", "Czechia", "Viet Nam"]


def main(folder):
    folder = Path(folder)
    countries = {}
    for line in (folder / "countryInfo.txt").read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#"):
            cols = line.split("\t")
            countries[cols[0]] = cols[4]
    regions = {}
    region_names = set()
    for line in (folder / "admin1CodesASCII.txt").read_text(encoding="utf-8").splitlines():
        code, name, ascii_name = line.split("\t")[:3]
        regions[code] = name
        region_names.update(n for n in (name, ascii_name) if n)
    country_names = set(countries.values()) | set(COUNTRY_ALIASES)

    suffixes, suffix_index, towns = [], {}, []
    with open(folder / "cities1000.txt", encoding="utf-8") as f:
        for line in f:
            cols = line.rstrip("\n").split("\t")
            name, lat, lng, cc, admin1 = cols[1], float(cols[4]), float(cols[5]), cols[8], cols[10]
            country = countries.get(cc, cc)
            if cc == "US":
                suffix = f", {admin1}, {country}"
            else:
                region = regions.get(f"{cc}.{admin1}")
                suffix = f", {region}, {country}" if region and region != name else f", {country}"
            if suffix not in suffix_index:
                suffix_index[suffix] = len(suffixes)
                suffixes.append(suffix)
            towns.append(f"{name}\t{lat:.4f}\t{lng:.4f}\t{suffix_index[suffix]}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        for n in sorted(region_names):
            f.write(f"R\t{n}\n")
        for n in sorted(country_names):
            f.write(f"C\t{n}\n")
        for s in suffixes:
            f.write(f"S\t{s}\n")
        f.write("\n".join(towns) + "\n")
    print(f"Wrote {len(towns)} towns, {len(suffixes)} region suffixes to {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
