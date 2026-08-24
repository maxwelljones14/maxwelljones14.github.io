#!/usr/bin/env python3
"""
Step 3 of 3: turn located artists into everything the globe needs.

Outputs into assets/json/spotify_globe/:
    globe_data.json    city points + per-region counts + distribution stats
    countries.geojson  simplified world borders
    states_us.geojson     US admin-1 borders (always loaded by the page)
    states_world.geojson  the rest, lazy-loaded only if the state layer is
                          switched to "all states"

Design note on weighting
------------------------
This script deliberately does NOT bake in a colour scale. It emits raw counts
plus the percentile distribution of those counts, and the browser does the
normalisation. That means you can retune the map with the on-page tuning panel
and never re-run Python -- which matters because the shape of the data
(one enormous US spike, a long thin international tail) is exactly the thing
you can't design a scale for until you've seen it.

Usage:
    python3 build_globe_data.py
    python3 build_globe_data.py --stats-only   # print distribution, write nothing
"""

import argparse
import json
import math
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

from shapely.geometry import MultiPolygon, Point, Polygon, shape
from shapely.geometry.polygon import orient
from shapely.strtree import STRtree

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
GEO_SRC = HERE / "geo_src"
REPO = HERE.parent.parent
OUT_DIR = REPO / "assets" / "json" / "spotify_globe"

LOCATED = DATA / "artists_located.json"

# Simplification tolerance in degrees. 0.02 keeps coastlines readable at globe
# scale while cutting the admin-1 file by well over an order of magnitude.
SIMPLIFY_COUNTRY = 0.05
SIMPLIFY_STATE = 0.06

# Ship admin-1 borders only for countries with at least this many states that
# actually have artists. Below it, state detail is noise and the geometry is
# pure page weight -- with real data, dropping the 1-state countries cut the
# admin-1 payload by more than half.
MIN_STATES_FOR_ADMIN1 = 2

# The page shows US states by default, so admin-1 geometry ships as two files:
# the US one always loads, the rest of the world only if asked for.
US_ISO = "USA"


# -- timespans --------------------------------------------------------------
# "all" is every artist in the library counted once -- the union of the top
# lists, followed artists, liked songs, saved albums and my own/collaborative
# playlists. The other three come straight from Spotify's top-artist windows,
# which the API caps near 99 artists each, so they are "my top ~100 in that
# window" rather than an exhaustive picture.
ALL_SPAN = "all"
SPAN_KEYS = (ALL_SPAN, "long_term", "medium_term", "short_term")
SPAN_LABELS = {
    ALL_SPAN: "all time",
    "long_term": "~1 year",
    "medium_term": "~6 months",
    "short_term": "~4 weeks",
}
SPAN_NOTES = {
    ALL_SPAN: "every artist across my liked songs, saved albums and playlists",
    "long_term": "my top artists over roughly the past year",
    "medium_term": "my top artists over roughly the past six months",
    "short_term": "my top artists over roughly the past four weeks",
}


def spans_for(artist: dict) -> list[str]:
    """Which timespans this artist belongs to."""
    out = [ALL_SPAN]
    ranks = artist.get("top_rank") or {}
    for span in SPAN_KEYS:
        if span != ALL_SPAN and ranks.get(span):
            out.append(span)
    return out


def load_geo(name: str) -> dict:
    path = GEO_SRC / name
    if not path.exists():
        sys.exit(
            f"Missing {path}.\nRe-download it -- see README.md 'Map geometry'."
        )
    return json.loads(path.read_text())


# MusicBrainz's `area` is not always a country and its `begin-area` is not
# always a city, so a resolved place name has to be classified before it can be
# trusted as a hometown. Names that are really whole countries or UK constituent
# countries geocode to a centroid, which would otherwise appear as a city.
#
# Kept deliberately narrow: only these four sub-country names are demoted, since
# they have no major same-named city. "New York" and "Texas" stay city-level,
# because demoting them would delete real clusters.
REGION_ONLY = {"england", "scotland", "wales", "northern ireland"}

# name fields worth matching on; NAME_ALT is pipe-delimited
_NE_NAME_FIELDS = (
    "SOVEREIGNT", "ADMIN", "GEOUNIT", "SUBUNIT", "NAME", "NAME_LONG",
    "BRK_NAME", "FORMAL_EN", "NAME_CIAWF", "NAME_SORT", "NAME_EN", "NAME_ALT",
)


def norm_name(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.casefold().strip()


def build_country_names(countries_fc: dict) -> set:
    """Every English name variant of every country, normalised."""
    out = set()
    for feat in countries_fc.get("features", []):
        props = feat.get("properties", {})
        for field in _NE_NAME_FIELDS:
            val = props.get(field)
            if not isinstance(val, str):
                continue
            for part in val.split("|"):
                part = norm_name(part)
                if part:
                    out.add(part)
    return out


def precision_of(place: str | None, country_names: set) -> str:
    """'city', 'region', or 'country' -- how precise the resolved place is."""
    key = norm_name(place)
    if not key:
        return "country"
    if key in country_names:
        return "country"
    if key in REGION_ONLY:
        return "region"
    return "city"


def songs_of(artist: dict) -> int:
    """
    How many distinct songs by this artist are in the library.

    fetch_spotify.py dedupes across Liked Songs, saved albums and playlists and
    stores the total as `songs`; the fallback keeps older data files and
    make_sample_data.py output working.
    """
    if artist.get("songs") is not None:
        return artist["songs"]
    return artist.get("saved_tracks", 0)


def affinity(artist: dict) -> float:
    """
    A 0..1-ish 'how much do I like them' score.

    NOT used for the heat map (you chose raw artist counts for that) -- this
    drives tooltip ordering and the "top artists here" list, and it is what
    we'd swap for real play counts once the GDPR export lands.

    Rank 1 in a top-50 list is worth much more than rank 50, hence the
    logarithmic decay rather than a linear one.
    """
    if artist.get("plays"):  # present only after the extended-history import
        return float(artist["plays"])

    score = 0.0
    weights = {"short_term": 1.0, "medium_term": 0.8, "long_term": 0.6}
    for rng, weight in weights.items():
        rank = (artist.get("top_rank") or {}).get(rng)
        if rank:
            score += weight * (1.0 - math.log(rank) / math.log(120))
    score += 0.30 * min(songs_of(artist), 12) / 12
    score += 0.15 if artist.get("followed") else 0.0
    score += 0.10 * min(artist.get("recent_plays", 0), 5) / 5
    return round(score, 4)


def percentiles(values: list[float]) -> dict:
    """Distribution summary the browser uses to build sensible default scales."""
    if not values:
        return {}
    ordered = sorted(values)

    def pct(p: float) -> float:
        idx = min(len(ordered) - 1, max(0, int(round(p / 100 * (len(ordered) - 1)))))
        return ordered[idx]

    return {
        "n": len(ordered),
        "min": ordered[0],
        "max": ordered[-1],
        "mean": round(sum(ordered) / len(ordered), 3),
        "p50": pct(50),
        "p75": pct(75),
        "p90": pct(90),
        "p95": pct(95),
        "p99": pct(99),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stats-only", action="store_true")
    args = ap.parse_args()

    if not LOCATED.exists():
        sys.exit(f"{LOCATED} not found -- run enrich_hometowns.py first.")

    payload = json.loads(LOCATED.read_text())
    artists = [a for a in payload["artists"] if a.get("lat") is not None]
    print(f"{len(artists)} artists with coordinates "
          f"(of {payload['artist_count']} total)\n")
    if not artists:
        sys.exit("Nothing to plot.")

    # -- load geometry ------------------------------------------------------
    countries_fc = load_geo("countries.geojson")
    states_fc = load_geo("states_10m.geojson")

    country_geoms, country_props = [], []
    for feat in countries_fc["features"]:
        try:
            country_geoms.append(shape(feat["geometry"]))
            country_props.append(feat["properties"])
        except Exception:
            continue
    country_tree = STRtree(country_geoms)

    state_geoms, state_props = [], []
    for feat in states_fc["features"]:
        try:
            state_geoms.append(shape(feat["geometry"]))
            state_props.append(feat["properties"])
        except Exception:
            continue
    state_tree = STRtree(state_geoms)

    def locate(tree, geoms, props, pt):
        """Point-in-polygon with a bbox prefilter; nearest-match fallback."""
        for idx in tree.query(pt):
            if geoms[idx].contains(pt):
                return props[idx]
        # coastal cities sometimes fall just outside a simplified polygon
        for idx in tree.query(pt.buffer(0.35)):
            if geoms[idx].intersects(pt.buffer(0.35)):
                return props[idx]
        return None

    # -- attribute every artist to a city / state / country -----------------
    # Each artist is bucketed into every span it belongs to, so the browser can
    # switch timespan instantly without refetching anything.
    cities = defaultdict(
        lambda: {
            "spans": defaultdict(list),
            "lat": 0.0,
            "lon": 0.0,
            "country": None,
            "state": None,
        }
    )
    country_counts = defaultdict(lambda: defaultdict(list))
    state_counts = defaultdict(lambda: defaultdict(list))
    state_meta = {}
    unplaced = []
    country_names = build_country_names(countries_fc)
    precision_counts = defaultdict(int)

    # One artist table for the whole file; regions store integer indices into
    # it rather than repeating names. Without this, listing every artist for
    # every region for every span roughly triples the payload.
    #   n = name, s = songs of theirs in my library, p = lifetime plays
    artist_table = []
    has_plays = bool(payload.get("has_play_counts"))

    for artist in artists:
        pt = Point(artist["lon"], artist["lat"])

        cprops = locate(country_tree, country_geoms, country_props, pt)
        sprops = locate(state_tree, state_geoms, state_props, pt)

        iso = (cprops or {}).get("ISO_A3") or (cprops or {}).get("ADM0_A3")
        cname = (cprops or {}).get("ADMIN") or artist.get("country")
        if iso in (None, "-99"):
            iso = None

        sid = None
        if sprops:
            sid = sprops.get("iso_3166_2") or f"{sprops.get('adm0_a3')}-{sprops.get('name')}"
            state_meta[sid] = {
                "name": sprops.get("name_en") or sprops.get("name"),
                "country": sprops.get("admin"),
                "iso": sprops.get("adm0_a3"),
            }

        row = {"n": artist["name"], "s": songs_of(artist)}
        if has_plays:
            row["p"] = artist.get("plays") or 0
        artist_table.append(row)
        entry = {
            "idx": len(artist_table) - 1,
            "affinity": affinity(artist),
            "songs": songs_of(artist),
        }

        grain = precision_of(artist.get("place"), country_names)
        precision_counts[grain] += 1

        # Only genuine city-level hometowns get a marker. An artist MusicBrainz
        # only located to "United States" would otherwise be plotted at the
        # country centroid -- a phantom city cluster in rural Kansas, which also
        # wrongly credits Kansas on the state layer.
        if grain == "city":
            key = f"{artist.get('place') or 'unknown'}|{cname or '?'}"
            city = cities[key]
            city["lat"], city["lon"] = artist["lat"], artist["lon"]
            city["country"], city["state"] = cname, sid
            city["place"] = artist.get("place")
        else:
            city = None

        for span in spans_for(artist):
            if city is not None:
                city["spans"][span].append(entry)
            if iso:
                country_counts[iso][span].append(entry)
            # a region-level hit ("England") is a valid state, just not a city
            if sid and grain in ("city", "region"):
                state_counts[sid][span].append(entry)

        if not iso and not sid:
            unplaced.append(artist["name"])

    # -- assemble -----------------------------------------------------------
    def pack(by_span):
        """
        Collapse {span: [entries]} into compact per-span totals.

        `i` is the *complete* artist list for that region and span, as indices
        into artist_table -- the hover panel shows all of them, so nothing is
        truncated here.

        Ordered by song count, then by affinity as a tie-break. Sorting by
        affinity alone (which is what this used to do) made the panel look
        broken: it prints the song count beside each name, and a visible number
        column in non-monotonic order reads as a bug even when the hidden
        ordering is meaningful.
        """
        out = {}
        for span, entries in by_span.items():
            if not entries:
                continue
            ranked = sorted(entries, key=lambda a: (-a["songs"], -a["affinity"]))
            out[span] = {
                "c": len(ranked),
                "a": round(sum(a["affinity"] for a in ranked), 3),
                "i": [a["idx"] for a in ranked],
            }
        return out

    city_rows = []
    for city in cities.values():
        packed = pack(city["spans"])
        if not packed:
            continue
        city_rows.append(
            {
                "place": city["place"],
                "country": city["country"],
                "state": city["state"],
                "lat": round(city["lat"], 4),
                "lon": round(city["lon"], 4),
                "spans": packed,
            }
        )
    city_rows.sort(key=lambda c: -c["spans"].get(ALL_SPAN, {}).get("c", 0))

    country_rows = {
        iso: {"spans": pack(by_span)}
        for iso, by_span in country_counts.items()
        if pack(by_span)
    }
    state_rows = {
        sid: {**state_meta.get(sid, {}), "spans": pack(by_span)}
        for sid, by_span in state_counts.items()
        if pack(by_span)
    }

    # Admin-1 geometry is by far the biggest thing shipped, so only keep it for
    # countries where the split actually says something. A country with artists
    # in a single state learns nothing from state borders -- the country fill
    # already carries that number, and the hover falls through to the country.
    populated_per_country = defaultdict(int)
    for row in state_rows.values():
        if row.get("iso"):
            populated_per_country[row["iso"]] += 1
    admin1_countries = {
        iso for iso, n in populated_per_country.items()
        if n >= MIN_STATES_FOR_ADMIN1
    }
    dropped_states = [
        sid for sid, row in state_rows.items()
        if row.get("iso") not in admin1_countries
    ]
    for sid in dropped_states:
        del state_rows[sid]  # keep data and geometry consistent

    def counts(rows, span):
        """Every non-zero count for one layer in one span."""
        it = rows.values() if isinstance(rows, dict) else rows
        return [r["spans"][span]["c"] for r in it if span in r["spans"]]

    span_stats = {}
    span_totals = {}
    for span in SPAN_KEYS:
        span_stats[span] = {
            "city": percentiles(counts(city_rows, span)),
            "country": percentiles(counts(country_rows, span)),
            "state": percentiles(counts(state_rows, span)),
        }
        span_totals[span] = {
            "artists": sum(1 for a in artists if span in spans_for(a)),
            "cities": len(counts(city_rows, span)),
            "countries": len(counts(country_rows, span)),
        }

    # -- report -------------------------------------------------------------
    print("Hometown precision (only city-level artists get a map marker):")
    for grain in ("city", "region", "country"):
        n = precision_counts.get(grain, 0)
        note = {"city": "plotted as cities",
                "region": "state + country only",
                "country": "country only -- no usable hometown"}[grain]
        print(f"  {grain:8} {n:>4}   {note}")
    print()

    print("Artists per timespan (top-artist windows are capped near 99 by the API):")
    for span in SPAN_KEYS:
        t = span_totals[span]
        print(f"  {SPAN_LABELS[span]:<12} {t['artists']:>4} artists  "
              f"{t['cities']:>3} cities  {t['countries']:>3} countries")

    print(f"\nDistribution for '{SPAN_LABELS[ALL_SPAN]}' (what you tune against):")
    for layer, s in span_stats[ALL_SPAN].items():
        if s:
            print(
                f"  {layer:8} n={s['n']:<4} max={s['max']:<4} "
                f"p50={s['p50']:<4} p90={s['p90']:<4} p95={s['p95']:<4} p99={s['p99']}"
            )

    def span_count(row, span):
        return row["spans"].get(span, {}).get("c", 0)

    print("\nTop 10 countries (all time):")
    for iso, row in sorted(
        country_rows.items(), key=lambda kv: -span_count(kv[1], ALL_SPAN)
    )[:10]:
        print(f"  {iso}  {span_count(row, ALL_SPAN):>4}")

    print("\nTop 10 cities (all time):")
    for city in city_rows[:10]:
        print(f"  {span_count(city, ALL_SPAN):>3}  {city['place']}, {city['country']}")

    if country_rows:
        vals = [span_count(r, ALL_SPAN) for r in country_rows.values()]
        top, total = max(vals), sum(vals)
        print(f"\nTop country holds {100 * top / total:.0f}% of all placed artists.")
        if top / total > 0.5:
            print("  -> Heavily skewed. Start with curve='rank' or a low gamma;")
            print("     the tuning panel on the page lets you dial it in visually.")

    if unplaced:
        print(f"\n{len(unplaced)} artists had coords but matched no polygon: "
              f"{', '.join(unplaced[:5])}{' ...' if len(unplaced) > 5 else ''}")

    if args.stats_only:
        print("\n--stats-only: nothing written.")
        return

    # -- write data ---------------------------------------------------------
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "globe_data.json").write_text(
        json.dumps(
            {
                "generated_at": payload.get("generated_at"),
                "has_play_counts": payload.get("has_play_counts", False),
                # carried through so the page can say so out loud -- otherwise
                # it is far too easy to commit make_sample_data.py output
                "is_sample": payload.get("is_sample", False),
                "artist_count": payload["artist_count"],
                "located_count": len(artists),
                "default_span": ALL_SPAN,
                "spans": [
                    {"key": k, "label": SPAN_LABELS[k], "note": SPAN_NOTES[k]}
                    for k in SPAN_KEYS
                    if span_totals[k]["artists"] > 0
                ],
                "artists": artist_table,
                "song_metric": "plays" if has_plays else "saved",
                "span_stats": span_stats,
                "span_totals": span_totals,
                "cities": city_rows,
                "countries": country_rows,
                "states": state_rows,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )

    # -- write geometry: countries simplified, states filtered + simplified --
    def round_coords(obj, nd=4):
        """
        Drop coordinate precision to ~11m. Invisible at globe scale and it
        meaningfully shrinks the files.

        Do NOT go coarser than this: at 3dp, rounding collapses adjacent
        vertices on small//intricate shapes into degenerate slivers, which is
        one of the ways a ring ends up with reversed winding.
        """
        if isinstance(obj, (int, float)):
            return round(obj, nd)
        if isinstance(obj, (list, tuple)):
            return [round_coords(x, nd) for x in obj]
        return obj

    def slim(feature, tol, props):
        """
        Simplify a feature and emit RFC-7946-correct GeoJSON.

        The winding normalisation is load-bearing, and the sign is the
        opposite of what RFC 7946 asks for. three-globe triangulates each ring
        as given: a ring wound the wrong way is filled as its own *complement*,
        so one bad sliver paints the entire sphere its colour. Natural Earth
        ships clockwise exterior rings and three-globe renders those correctly,
        so normalise to clockwise (sign=-1.0). This was verified by rendering
        Lagos three ways -- as simplified with CCW rings it swallowed the whole
        globe; as source geometry, and as the same simplified ring reversed
        back to CW, it drew correctly.

        buffer(0) first repairs any self-intersections; note it also normalises
        orientation on its own, which is why orient() has to come afterwards.
        """
        geom = shape(feature["geometry"])
        if not geom.is_valid:
            geom = geom.buffer(0)
        geom = geom.simplify(tol, preserve_topology=True)
        if geom.is_empty or not geom.is_valid:
            geom = geom.buffer(0)
        if geom.is_empty:
            return None

        # sign=-1.0 -> exterior rings clockwise, holes counter-clockwise
        if isinstance(geom, Polygon):
            geom = orient(geom, sign=-1.0)
        elif isinstance(geom, MultiPolygon):
            geom = MultiPolygon([orient(g, sign=-1.0) for g in geom.geoms])
        else:
            return None

        gj = json.loads(json.dumps(geom.__geo_interface__))
        gj["coordinates"] = round_coords(gj["coordinates"])
        return {"type": "Feature", "properties": props, "geometry": gj}

    out_countries = []
    for feat in countries_fc["features"]:
        p = feat["properties"]
        iso = p.get("ISO_A3") or p.get("ADM0_A3")
        slimmed = slim(
            feat,
            SIMPLIFY_COUNTRY,
            {"id": iso, "name": p.get("ADMIN"), "name_en": p.get("NAME_EN")},
        )
        if slimmed:
            out_countries.append(slimmed)

    # only ship admin-1 shapes for the countries selected above
    wanted = admin1_countries
    # Only ship geometry for states that actually have artists in some span.
    # An empty state is never drawn (a transparent cap would punch a hole
    # through the country fill), so its geometry is pure page weight.
    out_states = []
    for feat in states_fc["features"]:
        p = feat["properties"]
        if p.get("adm0_a3") not in wanted:
            continue
        sid_check = p.get("iso_3166_2") or f"{p.get('adm0_a3')}-{p.get('name')}"
        if sid_check not in state_rows:
            continue
        sid = p.get("iso_3166_2") or f"{p.get('adm0_a3')}-{p.get('name')}"
        slimmed = slim(
            feat,
            SIMPLIFY_STATE,
            {
                "id": sid,
                "name": p.get("name_en") or p.get("name"),
                "country": p.get("admin"),
                # lets the page fall back to the parent country when a state
                # itself has no artists -- otherwise the state layer would
                # permanently hide every country that has admin-1 shapes
                "iso": p.get("adm0_a3"),
            },
        )
        if slimmed:
            out_states.append(slimmed)

    # The page defaults to showing US states only, so the admin-1 geometry is
    # split in two: the US file always loads, the rest of the world is fetched
    # lazily and only if someone actually switches the state layer to "all".
    # That keeps ~200 KB gzipped off the default page load.
    us_states = [f for f in out_states if f["properties"].get("iso") == US_ISO]
    world_states = [f for f in out_states if f["properties"].get("iso") != US_ISO]

    for fname, feats in (
        ("countries.geojson", out_countries),
        ("states_us.geojson", us_states),
        ("states_world.geojson", world_states),
    ):
        (OUT_DIR / fname).write_text(
            json.dumps(
                {"type": "FeatureCollection", "features": feats},
                separators=(",", ":"),
            )
        )

    print(f"\nWrote to {OUT_DIR.relative_to(REPO)}/")
    for f in sorted(OUT_DIR.iterdir()):
        print(f"  {f.name:20} {f.stat().st_size / 1024:>8.0f} KB")
    print(f"\n{len(out_states)} admin-1 shapes kept for {len(wanted)} countries "
          f"(>= {MIN_STATES_FOR_ADMIN1} populated states): {', '.join(sorted(wanted))}")
    if dropped_states:
        print(f"{len(dropped_states)} single-state countries fall back to "
              f"country-level fill and hover.")


if __name__ == "__main__":
    main()
