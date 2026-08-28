# Spotify hometown globe — what exists, and how to ship it

Written 2026-08-23, updated 2026-08-24 after the first real data run. This is the handoff doc: what got built, why it's built that
way, and the exact steps to take it live. `README.md` next to this file is the
operational runbook for the scripts themselves.

---

## 1. What it does

A rotating globe on `/hobbies` showing where the artists you listen to are from.

- **City markers** (orange) at each hometown, sized and coloured by how many of
  your artists come from there.
- **State and country fills** (blue) shaded by artist count. States are drawn on
  top of countries, so the US/UK/Canada get real within-country detail.
- **Timespan toggle** — all time (default), ~1 year, ~6 months, ~4 weeks.
- **Search** — type a city, state or country; the globe flies there and pins its
  artist list. Picking a country also brings up its states.
- **Spin toggle** — auto-rotation on/off, visible next to the search box.
- **Zoom** — scroll or pinch, plus explicit +/− buttons on the globe.
- **Hover panel** — hovering any city, state or country lists *every* artist
  from there with the number of their songs in your library. Click to pin.
- **Follows the site theme**, which now defaults to dark.

### The real numbers (first full run, 2026-08-24)

| | |
|---|---|
| Artists found | **726** |
| Reachable only via playlists | 403 |
| Hometown resolved | 633 (**87%**) |
| Plotted as cities | 556 across 318 cities |
| Country-only, no usable hometown | 76 |
| Countries | 47 — US 402, UK 87, Canada 20, Brazil 17 |
| Top cities | LA 25, Chicago 22, London 19, Atlanta 19, Brooklyn 15 |
| US share | **65%** of placed artists |

---

## 2. The one thing Spotify can't do

**There is no play-count endpoint.** The Web API will tell you *which* artists
you listen to and roughly how much you rank them, but never "I played this
artist 412 times."

| You want | Where it comes from |
|---|---|
| Which artists I listen to | `/me/top/artists`, `/me/following`, `/me/tracks` |
| How recently | `short_term` / `medium_term` / `long_term` rank |
| Songs per artist | distinct tracks across Liked Songs + saved albums + playlists |
| **Lifetime play counts** | **only the GDPR export — see §7** |
| Artist hometowns | **not Spotify at all — MusicBrainz + Wikidata** |

Everything on the globe today is weighted by *artist count*, not plays. The page
says so in its caption.

### What is and isn't a source

Included: Liked Songs, saved albums (full track lists), and playlists you own
**or** that are collaborative. Song counts are deduped by track id across all
three, so a track that is liked *and* on a saved album *and* in two playlists
counts once — 2,639 raw credits collapsed to 1,605 distinct songs on the first
real run.

Excluded, deliberately: playlists you merely *follow* (someone else's taste).

Excluded, **not by choice — Spotify blocks it**: every Spotify-generated
playlist. "Your Top Songs 20XX", "Your All-Time Top Songs", "On Repeat",
Discover Weekly, Daily Mix, Wrapped. These do not appear in `/me/playlists` at
all, and fetching a known Spotify-owned playlist by id returns **404** (verified
against Top 50 Global and Today's Top Hits). That's the November 2024 change
cutting third-party access to Spotify's own algorithmic and editorial
playlists. No scope fixes it and Development mode is not the cause.

The nearest substitutes are `/me/top/tracks` (same idea as "Your Top Songs",
capped at 50 per window × 3 windows — not currently used, would be cheap to
add) and the GDPR export, which strictly supersedes all of them.

---

## 3. Files

### Pipeline (`tools/spotify_globe/`, excluded from the built site)

| File | Role |
|---|---|
| `fetch_spotify.py` | OAuth (PKCE) + pull your library → `data/artists_raw.json` |
| `enrich_hometowns.py` | MusicBrainz + Wikidata → `data/artists_located.json` |
| `build_globe_data.py` | Aggregate + geometry → `assets/json/spotify_globe/` |
| `import_extended_history.py` | Optional: fold in real play counts from the GDPR export |
| `make_sample_data.py` | Fake but realistically-skewed data, for development |
| `overrides.json` | Manual hometown fixes, keyed by Spotify artist ID |
| `requirements.txt` | `requests`, `shapely` |
| `README.md` | Runbook |
| `geocache.json` | **Committed.** artist id → hometown. The most expensive artefact here |
| `data/`, `geo_src/`, `.env` | **gitignored** — local only |

Note `geocache.json` deliberately sits *outside* `data/`. A full rebuild is
~3.5 hours of MusicBrainz rate-limiting, so it is committed and a fresh clone
inherits all of it. It holds only public facts about artists already named in
`globe_data.json`.

### Front end (committed and published)

| File | Role |
|---|---|
| `assets/js/spotify_globe.js` | The whole component; globe.gl loaded lazily from CDN |
| `assets/css/spotify_globe.css` | Styles, with its own theme-aware tokens |
| `assets/json/spotify_globe/globe_data.json` | Counts, artist table, per-span stats (~21 KB gzipped) |
| `assets/json/spotify_globe/countries.geojson` | World borders (~59 KB gzipped) |
| `assets/json/spotify_globe/states_us.geojson` | US admin-1, always loaded (~15 KB gzipped) |
| `assets/json/spotify_globe/states_world.geojson` | The rest, lazy-loaded on demand (~24 KB gzipped) |
| `_pages/hobbies.md` | New "Music" section |
| `_globe_test.html` | Local dev harness, not published |

### Files I modified outside the feature

| File | Change | Revert by |
|---|---|---|
| `assets/js/theme.js` | Site default theme `system` → `dark` | Change that one string back |
| `purgecss.config.js` | Safelist `/^sg-/` + `canvas` | Remove the `safelist` block |
| `_config.yml` | Exclude `tools/` and `_globe_test.html` | Remove those two lines |
| `.gitignore` | Ignore `.env`, `data/`, `geo_src/`, `__pycache__/` | — |

---

## 4. Design decisions worth remembering

**Normalisation happens in the browser, not in Python.** The JSON carries raw
counts plus percentile stats; the colour scale is computed client-side. That's
what makes the on-page tuning panel possible without re-running anything.

**The US-dominance problem is handled with gamma, not clipping.** Real data is
even more skewed than the sample was: US 402 vs a median country of 1, i.e. 65%
of all placed artists. Linear scaling would render a one-artist country at 0.2%
intensity — invisible. `gamma 0.35` puts it near 25% while still leaving the US
(1.00) clearly ahead of the UK (0.64) and Canada (0.44). Clipping *and* gamma
over-corrects and collapses #1 into #2, so `clipPct` stays at 100.

**Each layer normalises against its own distribution.** Countries (max 402),
states (max 84) and cities (max 25) are independently scaled, and so is each
timespan — that's why the 4-week view (18 artists) is readable at all.

**Regions store integer indices into one shared artist table.** Listing every
artist for every region for every span would have tripled the payload; indices
keep the whole file at 21 KB gzipped even with complete 402-name lists.

**Artist lists are sorted by song count, not affinity.** The panel prints the
count beside each name, and a visible number column in non-monotonic order reads
as a bug even when the hidden ordering is meaningful. Affinity is the tie-break.

**Hometown precision is classified into three tiers.** MusicBrainz's `area` is
not always a country and `begin-area` is not always a city, so a resolved place
is checked against every English country-name variant Natural Earth carries
(368 of them — `SUBUNIT` gives "United States", exactly MusicBrainz's spelling):

| Tier | Example | Treatment |
|---|---|---|
| city | Los Angeles, Brooklyn, Moscow, Manchester | marker + state + country |
| region | England, Scotland, Wales, N. Ireland | state + country, no marker |
| country | United States, Nigeria, Brazil | country only |

76 artists on the first real run were country-only. Without this they'd have
become phantom city markers at country centroids — a fake cluster in rural
Kansas that also wrongly credited Kansas on the state layer. The `region` tier
is deliberately just those four names: they have no major same-named city,
whereas demoting "New York" or "Texas" would delete real clusters.

**Admin-1 geometry only ships where it earns its weight**, via three filters
that between them took the state payload from 582 KB gzipped to 15 KB on the
default load:

1. `MIN_STATES_FOR_ADMIN1 = 2` — a country with artists in a single state learns
   nothing from state borders. Drops 29 countries.
2. Only states that actually have artists are emitted at all. 804 features → 113.
3. The result is split into `states_us.geojson` (always loaded) and
   `states_world.geojson` (fetched only when the state layer is switched to
   "all states"), because the page defaults to US-only.

**The state layer is a three-way control, not a checkbox** — "all states",
"US only" (default), "off". US-only is the default because 65% of the artists
are American, so state detail is genuinely informative there and mostly noise
elsewhere; plenty of countries have artists in two or three regions, which the
country fill already conveys.

**Empty states fall through to their parent country.** The state layer covers
the country layer, so without this the countries with admin-1 shapes could never
be hovered. Hover Kansas → United States (402 artists); hover Georgia → Georgia.

**The globe is a plain coloured sphere, not satellite imagery.** A photo of
Earth competes with the data and wrecks the colour scale.

**Two simultaneous sequential scales get two hues** — blue for regions, orange
for cities. Their mid-steps were validated for colour-blind separation in both
themes (CVD ΔE 24.7 light / 26.8 dark, target ≥ 8).

---

## 5. Traps (things that already bit, don't re-litigate them)

**Polygon winding.** Rings are normalised to **clockwise** exterior
(`orient(sign=-1.0)`), which is the *opposite* of RFC 7946. three-globe
triangulates each ring as given, so a ring wound the other way is filled as its
own complement — one bad sliver paints the entire sphere its colour. This
happened with Lagos. **If the globe ever renders as one solid colour, check this
first.**

**Never hand three.js an 8-digit hex.** `#rrggbbaa` doesn't parse and fails
silently. Always use `rgba()`.

**The hover panel needs an explicit max-height.** Set in JS in `resize()` to
match the globe. Without it, a 100-artist list stretches the flex row — globe
included — to thousands of pixels instead of scrolling.

**Don't round geometry coordinates below 4 decimals.** At 3dp, rounding
collapses vertices on intricate shapes into degenerate slivers.

**Playlist items live at `/playlists/{id}/items`, not `/tracks`.** The old path
returns **403** as of the Feb 2026 API, and the payload moved from
`item.track` to `item.item`. Both key names are read as a fallback. Album tracks
are *not* renamed — `/albums/{id}/tracks` is still correct and `/items` 404s
there — and liked songs still use `item.track`. Don't "fix" them to match.

**A transparent polygon still occludes what's under it.** three.js writes depth
for a fully transparent cap, so an "invisible" state sitting at a higher
altitude than its country punches a dark hole through the country fill. Empty
regions must be left out of the layer entirely, not painted `rgba(0,0,0,0)`.
This showed up as black rectangles across the western US the moment the default
view centred on North America.

**Keep the JS to ES2017-era syntax.** `jekyll-minifier` runs it through the
`uglifier` gem, whose bundled uglify-js predates optional chaining: a single
`navigator.clipboard?.writeText()` failed the entire deploy with
`Unexpected token: punc (.)`. Avoid `?.`, `??` and anything newer.

Don't guess at what it accepts — **uglify-js 3.12.8 reproduces the CI parser**
(it rejects `?.` exactly like the deploy did, while accepting `const`, arrows,
template literals and `async`/`await`). Before pushing a JS change:

```bash
npx uglify-js@3.12.8 assets/js/spotify_globe.js -o /dev/null
```

Silence means the deploy will survive. `acorn.parse(src, {ecmaVersion: 2017})`
is a decent second opinion but does not model this specific minifier.

**Adding a scope invalidates the cached token.** A refresh keeps the old,
narrower grant, so the new endpoints 403 with no obvious cause. `get_token()`
stores `granted_scopes` and forces a fresh browser authorization when `SCOPES`
changes. If you add a scope and start seeing 403s, that's why.

**PurgeCSS runs on deploy** and the component builds most of its DOM at runtime,
so its classes never appear in the generated HTML. The `/^sg-/` safelist is what
keeps the styles alive.

---

## 6. Getting your Spotify credentials

> ### The live site never needs the client ID
>
> This is a **build-time** credential, not a runtime one. The pipeline runs on
> your machine, writes static JSON, and you commit that JSON. The published
> JavaScript makes exactly four network requests: the globe.gl CDN, and
> `fetch()` for the three files in `assets/json/spotify_globe/` on your own
> domain. It contains no Spotify endpoint and no credential — grep it.
>
> So **do not** put the client ID in `_config.yml`, in the JS, or in a repo
> secret. It belongs in `.env` on your laptop and nowhere else.
>
> It has to work this way: GitHub Pages serves static files only, so there is
> nowhere server-side to hold a token. A client ID shipped to the browser would
> be public, and the OAuth flow would prompt each *visitor* to log into their
> own Spotify account — showing them their data, not yours.
>
> The cost of this design is that the data is a snapshot. See §9 to refresh it.


1. Go to <https://developer.spotify.com/dashboard> and log in with your normal
   Spotify account.
2. **Create app.** Name and description can be anything.
3. **Redirect URI** — this must be exactly:

   ```
   http://127.0.0.1:8888/callback
   ```

   Use the literal loopback IP. Spotify rejects `localhost` now.
4. Under "Which API/SDKs are you planning to use", tick **Web API**. Save.
5. Open the app → **Settings** → copy the **Client ID**.

Then create `tools/spotify_globe/.env` (gitignored):

```
SPOTIFY_CLIENT_ID=paste_your_client_id_here
```

That file, and only that file, is where the credential goes. You can also just
export `SPOTIFY_CLIENT_ID` in your shell — the script checks the environment
first.

**You do not need the client secret.** The flow is Authorization Code + PKCE,
which is designed to work without one. The dashboard will show you a secret
anyway; leave it there and don't paste it into the repo or into a chat.

**Leave the app in Development mode.** It caps you at 25 users and you are the
only one. There's no quota extension to request.

---

## 7. Optional: real play counts

Request the export at <https://www.spotify.com/account/privacy> → tick
**Extended streaming history** → submit. It's free and arrives by email in
**5–30 days**, so request it now even if you don't use it yet.

When it lands, unzip it and run this *between* steps 1 and 2 of the pipeline:

```bash
python3 import_extended_history.py ~/Downloads/my_spotify_data
```

The panel's per-artist number switches from "songs in my library" to lifetime
plays automatically.

---

## 8. Going live — the full checklist

Getting the API key is **not** the only step. In order:

```bash
cd tools/spotify_globe
pip install -r requirements.txt
```

**1. Credentials** — §6 above.

**2. Map geometry.** `geo_src/` is gitignored, so it exists on the machine where
this was built but not in a fresh clone. If it's missing:

```bash
mkdir -p geo_src
curl -L -o geo_src/countries.geojson \
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson
curl -L -o geo_src/states_10m.geojson \
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson
```

**3. Run the pipeline.**

```bash
python3 fetch_spotify.py        # opens a browser once to authorize
python3 enrich_hometowns.py     # 30-45 min, resumable, Ctrl-C is safe
python3 build_globe_data.py
```

Step 2 is the slow one: ~17s per artist in practice, so **~3.5 hours for 750
artists** almost entirely from MusicBrainz's one-request-per-second cap. It is
resumable (^C is safe, progress flushes every 10 artists) and — importantly —
`geocache.json` is committed, so you only ever pay for artists you have never
looked up before. A refresh that adds 50 new artists is ~15 minutes. The first
real run resolved 87%; it prints paste-ready stubs for the misses to drop into
`overrides.json`.

**4. Confirm the sample data is gone.** The page currently shows a red
*"Showing generated sample data, not a real library"* line. It disappears
automatically once `build_globe_data.py` runs on real data. If you still see it,
you're looking at `make_sample_data.py` output — **do not push that.**

**5. Optionally tune the scale.** Open `/hobbies/?tune=1`, drag the sliders,
hit **copy config**, paste over `DEFAULTS` in `assets/js/spotify_globe.js`.

**6. Preview locally.** This needs Ruby, which was *not* installed on the
machine where this was built — so this step has never actually been run:

```bash
bundle install
bundle exec jekyll serve
```

The globe itself was verified in a real headless browser via
`_globe_test.html`, but the Jekyll page around it has not been built. Worth
doing once before pushing.

**7. Commit and push.**

```bash
git checkout -b spotify-globe     # or commit straight to master
git add -A
git status                        # sanity-check the list below
git commit -m "Add Spotify artist hometown globe to hobbies"
git push
```

`git add -A` is safe — `.env`, `data/`, `geo_src/` and `__pycache__/` are all
gitignored. Exactly these 20 paths should appear, and nothing else:

```
.gitignore                                   _globe_test.html
_config.yml                                  assets/css/spotify_globe.css
_pages/hobbies.md                            assets/js/spotify_globe.js
assets/js/theme.js   <- site-wide dark       assets/json/spotify_globe/countries.geojson
purgecss.config.js                           assets/json/spotify_globe/globe_data.json
                                             assets/json/spotify_globe/states_us.geojson
                                             assets/json/spotify_globe/states_world.geojson
tools/spotify_globe/OVERVIEW.md              tools/spotify_globe/import_extended_history.py
tools/spotify_globe/README.md                tools/spotify_globe/make_sample_data.py
tools/spotify_globe/build_globe_data.py      tools/spotify_globe/overrides.json
tools/spotify_globe/enrich_hometowns.py      tools/spotify_globe/requirements.txt
tools/spotify_globe/fetch_spotify.py
```

If you see `.env`, anything under `data/`, or any `.pyc`, stop and check
`.gitignore` before committing.

**8. Deploy is automatic.** Pushing to `master` triggers
`.github/workflows/deploy.yml`, which builds Jekyll, runs PurgeCSS, and
publishes `_site`. The live site is <https://maxwelljon.es>. Watch the run under
the repo's Actions tab; give it a couple of minutes.

---

## 9. Refreshing the data later

The globe shows a snapshot — it does not update on its own. To refresh it you
re-run the pipeline locally and push the new JSON.

```bash
cd tools/spotify_globe
python3 fetch_spotify.py && python3 enrich_hometowns.py && python3 build_globe_data.py
cd ../.. && git add assets/json/spotify_globe && git commit -m "Refresh globe data" && git push
```

The OAuth token is cached, so `fetch_spotify.py` won't reopen a browser.
`enrich_hometowns.py` only looks up artists it hasn't seen before, so a refresh
is a couple of minutes rather than the initial 30–45.

**Could this be automated?** Yes — a scheduled GitHub Action could re-run the
pipeline and commit the JSON. It would need the client ID *and* a refresh token
as repo secrets, and `data/geocache.json` would have to be committed instead of
gitignored, or every run would re-do the full 40-minute MusicBrainz crawl. Not
built; the data changes slowly enough that pushing by hand is cheaper than
maintaining that.

---

## 10. Known limitations

- **Windowed timespans are capped.** Spotify's top-artist endpoint returns at
  most ~99 artists per window, so "~4 weeks" is your top ~100 for that window,
  not everything you played. Only "all time" covers the full library.
- **Hometown coverage is 70–85%.** Good for well-known artists, patchy for small
  or very new ones. `overrides.json` is the escape hatch.
- **Border cities can land in the wrong region.** Point-in-polygon puts Detroit
  within a few km of Ontario; a coastal city can miss a simplified polygon and
  fall back to a nearest-match.
- **A country with admin-1 shapes is only reachable via its empty states.** If
  every state in a country has artists, you can't hover the country total. Not
  currently an issue at this data size.
- **globe.gl is ~1.9 MB** from jsDelivr (it bundles three.js). It's lazy-loaded
  when the section scrolls into view, so the rest of the page doesn't pay for it,
  but the globe does need a network round-trip to a CDN.
