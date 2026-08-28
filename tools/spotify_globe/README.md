# Spotify artist-hometown globe

> **New here?** Read [OVERVIEW.md](OVERVIEW.md) first — it covers what exists,
> why it's built this way, how to get your Spotify credentials, and the full
> go-live checklist. This file is the day-to-day runbook for the scripts.

Builds the rotating globe on `/hobbies`: a heat map of where my favourite
artists are from, at city, state and country level.

The site is static (Jekyll on GitHub Pages), so nothing here runs at page load.
These scripts run locally, write JSON into `assets/json/spotify_globe/`, and you
commit the result. Refreshing the data = re-run and push.

## What Spotify can and can't tell us

| Want | Available? |
|---|---|
| Which artists I listen to | Yes — `/me/top/artists`, `/me/following`, `/me/tracks`, `/me/albums`, `/me/playlists` |
| How recently I liked them | Yes — `short_term` vs `medium_term` vs `long_term` rank |
| How many times I played them | **No.** No such endpoint exists. See `import_extended_history.py` |
| Artist hometowns | **No.** Spotify has no location data at all. See step 2 |
| Wrapped / On Repeat playlists | **No.** Spotify-owned playlists 404 since Nov 2024 |

Note the Feb 2026 API changes: batch `GET /artists` is gone (single lookups
only) and `genres`/`popularity`/`followers` are deprecated on the artist object.
Nothing here depends on those.

## Setup

```bash
pip install -r requirements.txt
```

Create a Spotify app at <https://developer.spotify.com/dashboard>:

- Redirect URI: `http://127.0.0.1:8888/callback`
  (must be the literal loopback IP — Spotify rejects `localhost`)
- Which API: Web API

Then put the client ID in `.env` (gitignored):

```
SPOTIFY_CLIENT_ID=your_client_id_here
```

There is no client *secret* to store — the flow is Authorization Code + PKCE.
Development mode is fine; it only limits you to 25 users and you are one.

## The pipeline

```bash
python3 fetch_spotify.py        # 1. pull your library      -> data/artists_raw.json
python3 enrich_hometowns.py     # 2. resolve hometowns      -> data/artists_located.json
python3 build_globe_data.py     # 3. aggregate + geometry   -> assets/json/spotify_globe/
```

**Step 1** opens a browser once to authorize, then caches a refresh token in
`data/.token.json` (chmod 600, gitignored).

**Step 2** is the slow one: MusicBrainz is rate-limited to 1 request/second and
each artist needs several calls, so a cold run of ~750 artists takes about
**3.5 hours**. It is resumable (Ctrl-C is safe) and caches to `geocache.json`,
which is **committed** — so this cost is paid once ever, not once per refresh.
Re-runs only look up artists that are new.

It matches artists to MusicBrainz via the *Spotify URL relation* where possible
(exact, no name ambiguity), falling back to a confidence-gated name search, then
resolves the place to coordinates through Wikidata. Coverage runs ~87% — good
for well-known artists, patchy for small or very new ones.

The first real run resolved 87%. Anything it misses gets listed at the end;
fix those by hand in `overrides.json`:

```json
{
  "3TVXtAsR1Inumwj472S9r4": {
    "place": "Toronto", "country": "Canada", "lat": 43.6532, "lon": -79.3832
  }
}
```

Overrides always win over the automatic lookup.

**Step 3** does point-in-polygon attribution of each city to a state and
country, then writes the data plus simplified geometry. It prints the count
distribution, which is what you tune the colour scale against.

## Real play counts (optional)

```bash
python3 import_extended_history.py ~/Downloads/my_spotify_data
```

Request the export at <https://www.spotify.com/account/privacy> → "Extended
streaming history". Free, takes 5–30 days to arrive, and is the only source of
true lifetime play counts. Run this between steps 1 and 2.

Until then, `affinity` is a proxy built from top-artist rank across the three
time windows, liked-track count, follow status and recent plays.

## Timespans

The globe has a timespan control with four settings:

| Setting | What it is |
|---|---|
| **all time** (default) | Every artist in the library, counted once — liked songs, saved albums, my/collaborative playlists, top lists, follows |
| ~1 year | `long_term` top artists |
| ~6 months | `medium_term` top artists |
| ~4 weeks | `short_term` top artists |

Switching is instant: `build_globe_data.py` precomputes counts for every span
into each city/state/country row, so the browser just reads a different key.

**The three windowed views are not exhaustive.** Spotify's top-artist endpoint
caps out near 99 artists per window, so "~4 weeks" means *your top ~100 artists
of the last four weeks*, not everything you played. Only "all time" covers the
full library, because that one is built from liked songs, saved albums and
playlists rather than the ranked lists. The page says as much in its caption.

Each span normalises its colour scale against its own distribution, so a
four-week view (18 artists) is just as readable as an all-time view whose top
country holds 402.

## Search and spin

The toolbar above the globe has a search box and a spin checkbox.

Search covers cities, states and countries at once, limited to places with
artists in the active timespan. It folds case and accents (`sao paulo` finds
*São Paulo*) and ranks by match quality then artist count, so `london` puts
London UK above London, Canada. Arrow keys and Enter work.

Selecting a result flies there, pins the artist panel, and stops the spin.
Selecting a country also brings up its states, fetching `states_world.geojson`
first if that country isn't the US.

## Hovering

Hovering a city, state or country fills the panel beside the globe with **every**
artist from there and how many of their songs are in the library, most songs
first. Clicking pins the panel so you can move the mouse over and scroll a long
list; clicking again (or clicking empty space) releases it.

The cursor tooltip stays deliberately short — the US has 100+ artists and
globe.gl's tooltip ignores pointer events, so it could never be scrolled. The
panel is the place for the full list.

Two details worth knowing:

- **Empty states fall through to their country.** The state layer is drawn on
  top of the country layer, so without this the 24 countries that have admin-1
  shapes could never be hovered at all. Hover Kansas and you get the United
  States (402 artists); hover Georgia and you get Georgia. Same for Nigeria vs
  Lagos.
- **The panel's height is pinned to the globe's** in `resize()`. It has to be
  set in JS rather than CSS, because without an explicit cap the panel grows to
  fit its content and a 100-artist list stretches the whole flex row — globe
  included — to several thousand pixels instead of scrolling.

The number beside each artist is how many distinct tracks of theirs are in your
library — liked songs, saved albums and playlists combined, deduped. After `import_extended_history.py` runs it becomes lifetime play count
instead, and the panel footer relabels itself (`song_metric` in the JSON).

## Site theme

The site defaults to **dark** for visitors who have never touched the theme
toggle (`determineThemeSetting()` in `assets/js/theme.js` — the fallback is
`"dark"` instead of al-folio's stock `"system"`). Anyone who has used the
toggle keeps their choice, since that lives in localStorage. Change that one
string back to `"system"` to restore the upstream behaviour.

The globe reads `data-theme` off `<html>` and re-renders on change, so it
follows the toggle either way.

## Tuning the colour scale

The data files carry **raw counts, never colours** — normalisation happens in
the browser, so you can retune without re-running anything:

1. Open `/hobbies/?tune=1` (or click "tune scale" under the globe)
2. Drag the sliders until the map reads the way you want
3. Hit **copy config** and paste the JSON over `DEFAULTS` in
   `assets/js/spotify_globe.js`

The knobs, per layer:

- **curve** — `gamma` (default), `linear`, `log`, or `rank`
- **gamma** — below 1 lifts the tail; the whole point of this control is that
  US artists will dominate and linear scaling makes everywhere else invisible
- **floor** — minimum intensity for anywhere with ≥ 1 artist
- **clipPct** — normalise against a percentile instead of the max

Each layer normalises against its own distribution, so countries (max ~100)
and states (max ~20) stay independently readable.

Current defaults were swept against a US-dominated sample: `gamma 0.35` renders
a one-artist country at ~31% intensity where `linear` would give it 1%, while
still keeping the top two countries clearly apart.

## Local preview

Jekyll isn't required to work on the globe:

```bash
python3 -m http.server 8123        # from the repo root
# open http://127.0.0.1:8123/_globe_test.html
```

`_globe_test.html` mirrors the hobbies-page markup with light/dark buttons. The
leading underscore keeps Jekyll from publishing it.

To see the globe without touching Spotify at all:

```bash
python3 make_sample_data.py && python3 build_globe_data.py
```

## Map geometry

`geo_src/` holds the Natural Earth sources (gitignored — 42 MB). Re-download with:

```bash
curl -L -o geo_src/countries.geojson \
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson
curl -L -o geo_src/states_10m.geojson \
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson
```

The 50m admin-1 file only covers 9 countries, which is why this uses 10m.
`build_globe_data.py` filters admin-1 down to just the countries you have
artists in and simplifies both files, so the committed output stays small
(~60 KB + ~280 KB gzipped).

### One trap worth knowing about

Polygon rings are normalised to **clockwise** exterior winding (`orient(sign=-1.0)`),
which is the opposite of what RFC 7946 specifies. three-globe triangulates each
ring as given, so a ring wound the other way is filled as its own *complement* —
a single bad sliver silently paints the entire sphere its colour. This is exactly
what happened with Lagos during development. If the globe ever renders as one
solid colour, that is the first thing to check.
