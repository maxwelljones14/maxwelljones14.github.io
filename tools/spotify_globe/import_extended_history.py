#!/usr/bin/env python3
"""
Optional step: fold real lifetime play counts into the data.

The Spotify Web API has no play-count endpoint -- the only way to get true
counts is the GDPR "Extended streaming history" export:

    spotify.com/account/privacy -> Download your data
      -> tick "Extended streaming history" -> submit

It is free and arrives by email in roughly 5-30 days. Unzip it somewhere and
point this script at the folder. It rewrites data/artists_raw.json with a
`plays` value per artist, after which the affinity score in
build_globe_data.py uses real counts instead of the rank-based proxy.

Note the heat map itself is keyed on artist *count* per city, so this does not
change the colours -- it changes the "top artists here" ordering in tooltips,
and gives you the option to switch the map to a play-weighted encoding later.

Matching caveat: the export identifies artists by NAME only (there is no
artist URI in the payload), so this matches case-insensitively on name. Two
different artists sharing a name will merge; that is a limitation of the
export format, not of this script.

Usage:
    python3 import_extended_history.py ~/Downloads/my_spotify_data
    python3 import_extended_history.py <folder> --min-ms 30000
"""

import argparse
import json
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW = HERE / "data" / "artists_raw.json"

# Spotify itself counts a "stream" at 30 seconds; match that so the numbers
# line up with what Wrapped would tell you.
DEFAULT_MIN_MS = 30_000


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.casefold().strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder", help="unzipped extended streaming history folder")
    ap.add_argument("--min-ms", type=int, default=DEFAULT_MIN_MS,
                    help=f"ignore plays shorter than this (default {DEFAULT_MIN_MS})")
    args = ap.parse_args()

    folder = Path(args.folder).expanduser()
    if not folder.is_dir():
        sys.exit(f"{folder} is not a directory")

    files = sorted(folder.rglob("*Streaming_History_Audio*.json"))
    if not files:
        files = sorted(folder.rglob("*.json"))
    if not files:
        sys.exit(f"No JSON files found under {folder}")

    plays = defaultdict(int)
    ms_total = defaultdict(int)
    entries = skipped = 0

    for path in files:
        try:
            rows = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if not isinstance(rows, list):
            continue
        for row in rows:
            name = row.get("master_metadata_album_artist_name")
            ms = row.get("ms_played") or 0
            if not name:
                continue  # podcasts and local files have no artist
            entries += 1
            if ms < args.min_ms:
                skipped += 1
                continue
            key = norm(name)
            plays[key] += 1
            ms_total[key] += ms

    print(f"Read {len(files)} file(s), {entries} music entries, "
          f"{skipped} under {args.min_ms}ms")
    print(f"{len(plays)} distinct artists in your history")

    if not RAW.exists():
        sys.exit(f"{RAW} not found -- run fetch_spotify.py first.")

    payload = json.loads(RAW.read_text())
    matched = 0
    for artist in payload["artists"]:
        key = norm(artist["name"])
        if key in plays:
            artist["plays"] = plays[key]
            artist["ms_played"] = ms_total[key]
            matched += 1
        else:
            artist["plays"] = 0
            artist["ms_played"] = 0

    payload["has_play_counts"] = True
    RAW.write_text(json.dumps(payload, indent=2, ensure_ascii=False))

    total = len(payload["artists"])
    print(f"\nMatched {matched}/{total} of your library artists to the history.")

    top = sorted(payload["artists"], key=lambda a: -(a.get("plays") or 0))[:10]
    print("\nMost-played:")
    for artist in top:
        hours = (artist.get("ms_played") or 0) / 3_600_000
        print(f"  {artist['plays']:>5} plays  {hours:>6.1f} h  {artist['name']}")

    print("\nNext: python3 enrich_hometowns.py && python3 build_globe_data.py")


if __name__ == "__main__":
    main()
