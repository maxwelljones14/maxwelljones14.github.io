#!/usr/bin/env python3
"""
Step 2 of 3: figure out where each artist is from.

Spotify has no location data at all, so we resolve hometowns externally:

  1. MusicBrainz. Free, no API key, hard-capped at 1 request/second. Crucially
     it stores Spotify URLs as artist *relations*, so we can match on your exact
     Spotify artist ID instead of fuzzy-matching "Common" against 40 wrong
     entries. Gives us `begin-area` (hometown / founding city) and `area`
     (usually country).
  2. Wikidata. Turns an area name into lat/lon, and backfills artists
     MusicBrainz matched but left without a begin-area.
  3. overrides.json. Whatever the robots got wrong or missed, you fix by hand.

Everything is cached in geocache.json (committed, NOT under the gitignored
data/), so re-runs only pay for artists that are new -- and a fresh clone or a
second machine inherits the whole cache. The first run is the expensive one:
about 17s per artist in practice, so ~3.5h for 750 artists, almost all of it
MusicBrainz rate limiting. It is resumable -- ^C is safe, progress is flushed
every 10 artists.

Usage:
    python3 enrich_hometowns.py            # resolve anything not yet cached
    python3 enrich_hometowns.py --report   # just show coverage, no network
    python3 enrich_hometowns.py --retry-failed
"""

import argparse
import json
import sys
import time
import unicodedata
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
RAW = DATA / "artists_raw.json"
OVERRIDES = HERE / "overrides.json"
OUT = DATA / "artists_located.json"

# The hometown cache is the single most expensive artefact in this repo: at one
# MusicBrainz request per second it costs hours to rebuild from nothing. So it
# lives OUTSIDE the gitignored data/ directory and is committed, which means a
# fresh clone -- or a second machine -- inherits all of it and only pays for
# artists it has never seen.
#
# It holds nothing private: Spotify artist id -> public hometown facts, for
# artists whose names are already published in globe_data.json.
CACHE = HERE / "geocache.json"
LEGACY_CACHE = DATA / "geocache.json"  # where it used to live

# MusicBrainz requires a descriptive UA with contact info, and will block you
# without one. Change the email if you fork this.
UA = "maxwelljones-globe/1.0 (https://maxwelljones.dev; mjones2@andrew.cmu.edu)"
MB = "https://musicbrainz.org/ws/2"
WD_SPARQL = "https://query.wikidata.org/sparql"

MB_DELAY = 1.1  # seconds between MusicBrainz calls; do not lower this


def norm(s: str) -> str:
    """Casefold + strip accents, for comparing artist names."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.casefold().strip()


class Cache:
    def __init__(self, path: Path, legacy: Path | None = None):
        self.path = path
        if path.exists():
            self.data = json.loads(path.read_text())
        elif legacy is not None and legacy.exists():
            # one-time migration from the old gitignored location
            self.data = json.loads(legacy.read_text())
            print(f"Migrated {len(self.data)} cached lookups from {legacy.name} "
                  f"-> {path.name} (now committed).")
            self.flush()
        else:
            self.data = {}
        self._dirty = 0

    def get(self, key):
        return self.data.get(key)

    def put(self, key, value):
        self.data[key] = value
        self._dirty += 1
        if self._dirty >= 10:
            self.flush()

    def flush(self):
        self.path.write_text(json.dumps(self.data, indent=2, ensure_ascii=False))
        self._dirty = 0


_last_mb = [0.0]


def mb_get(path: str, **params) -> dict | None:
    """Rate-limited MusicBrainz GET."""
    wait = MB_DELAY - (time.time() - _last_mb[0])
    if wait > 0:
        time.sleep(wait)

    params["fmt"] = "json"
    for attempt in range(4):
        try:
            resp = requests.get(
                f"{MB}/{path}", params=params, headers={"User-Agent": UA}, timeout=30
            )
        except requests.RequestException as exc:
            print(f"      network error: {exc}")
            time.sleep(3 * (attempt + 1))
            continue
        finally:
            _last_mb[0] = time.time()

        if resp.status_code == 503:  # MB's "slow down"
            time.sleep(3 * (attempt + 1))
            continue
        if resp.status_code == 404:
            return None
        if resp.ok:
            return resp.json()
        time.sleep(2)
    return None


def mb_lookup_by_spotify(spotify_id: str) -> dict | None:
    """
    Find a MusicBrainz artist via its Spotify URL relation.

    This is the high-confidence path: no name ambiguity at all.
    """
    url = f"https://open.spotify.com/artist/{spotify_id}"
    res = mb_get("url", resource=url, inc="artist-rels")
    if not res:
        return None
    for rel in res.get("relations", []):
        artist = rel.get("artist")
        if artist and artist.get("id"):
            return mb_get(f"artist/{artist['id']}", inc="area-rels")
    return None


def mb_search_by_name(name: str) -> dict | None:
    """Fallback: search by name and accept only a confident exact-ish match."""
    res = mb_get("artist", query=f'artist:"{name}"', limit=5)
    if not res:
        return None
    target = norm(name)
    for cand in res.get("artists", []):
        # score is MB's own 0-100 match confidence
        if cand.get("score", 0) >= 90 and norm(cand.get("name", "")) == target:
            return mb_get(f"artist/{cand['id']}", inc="area-rels")
    return None


def extract_place(mb_artist: dict) -> tuple[str | None, str | None, str | None]:
    """Return (place_name, country_name, musicbrainz_area_id)."""
    if not mb_artist:
        return None, None, None
    begin = mb_artist.get("begin-area") or mb_artist.get("begin_area")
    area = mb_artist.get("area")

    place = (begin or {}).get("name") if begin else None
    place_id = (begin or {}).get("id") if begin else None
    country = (area or {}).get("name") if area else None

    # Solo artists often only have `area` (a country); bands often have both.
    if not place and country:
        place, place_id = country, (area or {}).get("id")
    return place, country, place_id


_WD_HEADERS = {"User-Agent": UA, "Accept": "application/sparql-results+json"}


def wd_query(sparql: str) -> list[dict]:
    for attempt in range(3):
        try:
            resp = requests.get(
                WD_SPARQL, params={"query": sparql}, headers=_WD_HEADERS, timeout=60
            )
        except requests.RequestException:
            time.sleep(3 * (attempt + 1))
            continue
        if resp.status_code == 429:
            time.sleep(int(resp.headers.get("Retry-After", "5")) + 1)
            continue
        if resp.ok:
            try:
                return resp.json()["results"]["bindings"]
            except (KeyError, json.JSONDecodeError):
                return []
        time.sleep(2)
    return []


def wd_coords_for_mb_area(area_id: str) -> tuple[float, float] | None:
    """Coordinates for a MusicBrainz area, joined via Wikidata P982."""
    rows = wd_query(
        f"""
        SELECT ?coord WHERE {{
          ?place wdt:P982 "{area_id}" ; wdt:P625 ?coord .
        }} LIMIT 1
        """
    )
    return _parse_point(rows[0]["coord"]["value"]) if rows else None


def wd_coords_for_name(place: str, country: str | None) -> tuple[float, float] | None:
    """
    Coordinates by place name. Restricted to things that are instances of a
    human settlement / administrative territory so we don't land on a band
    named after a city.
    """
    safe = place.replace('"', '\\"')
    rows = wd_query(
        f"""
        SELECT ?coord WHERE {{
          ?place rdfs:label "{safe}"@en ;
                 wdt:P31/wdt:P279* ?type ;
                 wdt:P625 ?coord .
          VALUES ?type {{ wd:Q486972 wd:Q56061 wd:Q6256 }}
        }} LIMIT 1
        """
    )
    return _parse_point(rows[0]["coord"]["value"]) if rows else None


def wd_place_for_spotify(spotify_id: str) -> dict | None:
    """
    Last resort: Wikidata sometimes knows the Spotify ID (P1902) directly and
    has place of birth (P19) or location of formation (P740).
    """
    rows = wd_query(
        f"""
        SELECT ?placeLabel ?coord ?countryLabel WHERE {{
          ?artist wdt:P1902 "{spotify_id}" .
          {{ ?artist wdt:P19 ?place }} UNION {{ ?artist wdt:P740 ?place }}
          ?place wdt:P625 ?coord .
          OPTIONAL {{ ?place wdt:P17 ?country }}
          SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en" }}
        }} LIMIT 1
        """
    )
    if not rows:
        return None
    row = rows[0]
    pt = _parse_point(row["coord"]["value"])
    if not pt:
        return None
    return {
        "place": row.get("placeLabel", {}).get("value"),
        "country": row.get("countryLabel", {}).get("value"),
        "lat": pt[0],
        "lon": pt[1],
        "source": "wikidata-spotify-id",
    }


def _parse_point(wkt: str) -> tuple[float, float] | None:
    """Wikidata returns 'Point(lon lat)'."""
    try:
        lon, lat = wkt.removeprefix("Point(").rstrip(")").split()
        return float(lat), float(lon)
    except (ValueError, AttributeError):
        return None


def resolve(artist: dict) -> dict:
    """Resolve one artist to a location. Returns a cache entry."""
    sid, name = artist["spotify_id"], artist["name"]

    mb = mb_lookup_by_spotify(sid)
    match = "spotify-relation"
    if not mb:
        mb = mb_search_by_name(name)
        match = "name-search"

    if mb:
        place, country, area_id = extract_place(mb)
        if place:
            coords = None
            if area_id:
                coords = wd_coords_for_mb_area(area_id)
            if not coords:
                coords = wd_coords_for_name(place, country)
            if coords:
                return {
                    "place": place,
                    "country": country,
                    "lat": coords[0],
                    "lon": coords[1],
                    "source": f"musicbrainz:{match}",
                    "mbid": mb.get("id"),
                }

    direct = wd_place_for_spotify(sid)
    if direct:
        return direct

    return {"place": None, "country": None, "lat": None, "lon": None, "source": "unresolved"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", action="store_true", help="show coverage, no network")
    ap.add_argument("--retry-failed", action="store_true", help="re-attempt unresolved")
    ap.add_argument("--limit", type=int, help="only process N artists (for testing)")
    args = ap.parse_args()

    if not RAW.exists():
        sys.exit(f"{RAW} not found -- run fetch_spotify.py first.")

    raw = json.loads(RAW.read_text())
    artists = raw["artists"]
    cache = Cache(CACHE, LEGACY_CACHE)
    overrides = json.loads(OVERRIDES.read_text()) if OVERRIDES.exists() else {}

    todo = [
        a
        for a in artists
        if a["spotify_id"] not in overrides
        and (
            cache.get(a["spotify_id"]) is None
            or (args.retry_failed and cache.get(a["spotify_id"]).get("source") == "unresolved")
        )
    ]
    if args.limit:
        todo = todo[: args.limit]

    reused = len(artists) - len(todo) - sum(1 for a in artists if a["spotify_id"] in overrides)
    if reused > 0:
        print(f"Reusing {reused} cached hometown lookups "
              f"(~{reused * 17 / 3600:.1f}h of MusicBrainz time skipped).")

    if not args.report and todo:
        mins = len(todo) * MB_DELAY * 2 / 60
        print(f"{len(todo)} artists to resolve (~{mins:.0f} min, resumable with ^C)\n")
        try:
            for i, artist in enumerate(todo, 1):
                entry = resolve(artist)
                cache.put(artist["spotify_id"], entry)
                mark = "  ok" if entry["place"] else "MISS"
                print(f"  [{i}/{len(todo)}] {mark}  {artist['name'][:34]:34} {entry['place'] or ''}")
        except KeyboardInterrupt:
            print("\nInterrupted -- progress saved, re-run to continue.")
        finally:
            cache.flush()

    cache.flush()

    # -- merge: cache, then hand-written overrides win -----------------------
    located, resolved_n = [], 0
    for artist in artists:
        entry = dict(cache.get(artist["spotify_id"]) or {})
        if artist["spotify_id"] in overrides:
            entry = {**entry, **overrides[artist["spotify_id"]], "source": "override"}
        row = {**artist, **{k: entry.get(k) for k in ("place", "country", "lat", "lon", "source")}}
        if row.get("lat") is not None:
            resolved_n += 1
        located.append(row)

    OUT.write_text(
        json.dumps(
            {
                "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "has_play_counts": raw.get("has_play_counts", False),
                "artist_count": len(located),
                "located_count": resolved_n,
                "artists": located,
            },
            indent=2,
            ensure_ascii=False,
        )
    )

    pct = 100 * resolved_n / len(located) if located else 0
    print(f"\nLocated {resolved_n}/{len(located)} artists ({pct:.0f}%)")

    misses = [a for a in located if a.get("lat") is None]
    if misses:
        print(f"\n{len(misses)} unresolved. Add them to overrides.json, e.g.:\n")
        for artist in misses[:5]:
            print(
                f'  "{artist["spotify_id"]}": {{"place": "?", "country": "?", '
                f'"lat": 0.0, "lon": 0.0}},   // {artist["name"]}'
            )
        if len(misses) > 5:
            print(f"  ... and {len(misses) - 5} more (full list in {OUT.name})")

    print("\nNext: python3 build_globe_data.py")


if __name__ == "__main__":
    main()
