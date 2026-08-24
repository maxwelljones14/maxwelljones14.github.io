#!/usr/bin/env python3
"""
Generate a plausible fake artists_located.json so the globe can be developed
and tuned before (or without) authorizing Spotify.

The distribution is deliberately US-skewed with a long international tail,
because that is the shape the real data will have and it is the shape the
colour scale has to survive.

Usage:
    python3 make_sample_data.py
    python3 build_globe_data.py
"""

import json
import random
import time
from pathlib import Path

DATA = Path(__file__).resolve().parent / "data"
DATA.mkdir(exist_ok=True)

# (place, country, lat, lon, roughly how many artists to invent there)
PLACES = [
    ("Atlanta", "United States", 33.7490, -84.3880, 14),
    ("Chicago", "United States", 41.8781, -87.6298, 11),
    ("Los Angeles", "United States", 34.0522, -118.2437, 19),
    ("New York", "United States", 40.7128, -74.0060, 22),
    ("Detroit", "United States", 42.3314, -83.0458, 7),
    ("Houston", "United States", 29.7604, -95.3698, 6),
    ("Philadelphia", "United States", 39.9526, -75.1652, 5),
    ("Nashville", "United States", 36.1627, -86.7816, 4),
    ("Seattle", "United States", 47.6062, -122.3321, 4),
    ("New Orleans", "United States", 29.9511, -90.0715, 3),
    ("Oakland", "United States", 37.8044, -122.2712, 3),
    ("Pittsburgh", "United States", 40.4406, -79.9959, 2),
    ("Minneapolis", "United States", 44.9778, -93.2650, 2),
    ("Miami", "United States", 25.7617, -80.1918, 3),
    ("Toronto", "Canada", 43.6532, -79.3832, 6),
    ("Montreal", "Canada", 45.5019, -73.5674, 2),
    ("London", "United Kingdom", 51.5074, -0.1278, 12),
    ("Manchester", "United Kingdom", 53.4808, -2.2426, 3),
    ("Glasgow", "United Kingdom", 55.8642, -4.2518, 2),
    ("Dublin", "Ireland", 53.3498, -6.2603, 2),
    ("Stockholm", "Sweden", 59.3293, 18.0686, 3),
    ("Reykjavik", "Iceland", 64.1466, -21.9426, 1),
    ("Berlin", "Germany", 52.5200, 13.4050, 3),
    ("Paris", "France", 48.8566, 2.3522, 3),
    ("Lagos", "Nigeria", 6.5244, 3.3792, 4),
    ("Accra", "Ghana", 5.6037, -0.1870, 1),
    ("Johannesburg", "South Africa", -26.2041, 28.0473, 2),
    ("Kingston", "Jamaica", 17.9714, -76.7936, 3),
    ("San Juan", "Puerto Rico", 18.4655, -66.1057, 4),
    ("Mexico City", "Mexico", 19.4326, -99.1332, 2),
    ("Bogota", "Colombia", 4.7110, -74.0721, 2),
    ("Sao Paulo", "Brazil", -23.5505, -46.6333, 3),
    ("Rio de Janeiro", "Brazil", -22.9068, -43.1729, 1),
    ("Buenos Aires", "Argentina", -34.6037, -58.3816, 1),
    ("Seoul", "South Korea", 37.5665, 126.9780, 5),
    ("Tokyo", "Japan", 35.6762, 139.6503, 4),
    ("Osaka", "Japan", 34.6937, 135.5023, 1),
    ("Mumbai", "India", 19.0760, 72.8777, 2),
    ("Melbourne", "Australia", -37.8136, 144.9631, 3),
    ("Sydney", "Australia", -33.8688, 151.2093, 2),
    ("Auckland", "New Zealand", -36.8485, 174.7633, 1),
    ("Tel Aviv", "Israel", 32.0853, 34.7818, 1),
    ("Istanbul", "Turkey", 41.0082, 28.9784, 1),
]

SYLLABLES = ["kai", "mor", "vex", "lun", "ash", "rio", "nyx", "sol", "dre", "vel",
             "juno", "wren", "cass", "orla", "bram", "isle", "veda", "koda"]


def fake_name(rng: random.Random, i: int) -> str:
    style = rng.random()
    if style < 0.35:
        return f"{rng.choice(SYLLABLES).title()} {rng.choice(SYLLABLES).title()}"
    if style < 0.6:
        return f"The {rng.choice(SYLLABLES).title()}s"
    if style < 0.8:
        return rng.choice(SYLLABLES).upper()
    return f"{rng.choice(SYLLABLES).title()}{i:02d}"


def main():
    rng = random.Random(14)  # deterministic
    artists = []
    idx = 0

    for place, country, lat, lon, n in PLACES:
        for _ in range(n):
            idx += 1
            # a few artists per city are "big", most are tail
            big = rng.random() < 0.25
            top_rank = {"short_term": None, "medium_term": None, "long_term": None}
            if big:
                for rng_key in top_rank:
                    if rng.random() < 0.7:
                        top_rank[rng_key] = rng.randint(1, 99)
            elif rng.random() < 0.2:
                top_rank["long_term"] = rng.randint(40, 99)

            artists.append(
                {
                    "spotify_id": f"sample{idx:04d}",
                    "name": fake_name(rng, idx),
                    "spotify_url": None,
                    "image": None,
                    "top_rank": top_rank,
                    "followed": rng.random() < 0.3,
                    "saved_tracks": rng.choice([0, 1, 1, 2, 3, 5, 8, 14]),
                    "saved_track_dates": [],
                    "recent_plays": rng.choice([0, 0, 0, 1, 3]),
                    "plays": None,
                    # jitter so multiple artists in one city aren't identical points
                    "lat": round(lat + rng.uniform(-0.05, 0.05), 4),
                    "lon": round(lon + rng.uniform(-0.05, 0.05), 4),
                    "place": place,
                    "country": country,
                    "source": "sample",
                }
            )

    out = DATA / "artists_located.json"
    out.write_text(
        json.dumps(
            {
                "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "has_play_counts": False,
                "is_sample": True,
                "artist_count": len(artists),
                "located_count": len(artists),
                "artists": artists,
            },
            indent=2,
        )
    )
    print(f"Wrote {len(artists)} sample artists across {len(PLACES)} cities -> {out}")
    print("Next: python3 build_globe_data.py")


if __name__ == "__main__":
    main()
