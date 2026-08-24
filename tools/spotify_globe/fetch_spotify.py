#!/usr/bin/env python3
"""
Step 1 of 3: pull your listening data out of Spotify.

Writes tools/spotify_globe/data/artists_raw.json -- one entry per distinct
artist, with the raw signals we later turn into a heat map.

What Spotify actually gives us (verified against the Feb 2026 Web API):
  * /me/top/artists  -- ranked lists for 3 time windows, ~99 artists each
  * /me/following    -- every artist you follow, fully paginated
  * /me/tracks       -- every liked song, fully paginated, with added_at
  * /me/albums       -- albums saved to the library, plus their track lists
  * /me/playlists    -- your own and collaborative playlists (NOT ones you
                        merely follow -- those are someone else's taste)

Per-artist song counts are deduped across all three track sources, so a track
that is liked AND on a saved album AND in two playlists counts once.

What it does NOT give us: play counts. There is no endpoint for "how many
times did I play this artist". The `plays` field stays null here; it gets
filled in by import_extended_history.py if/when your GDPR export arrives.

Usage:
    python3 fetch_spotify.py

Credentials come from tools/spotify_globe/.env (gitignored). See README.md.
"""

import base64
import hashlib
import http.server
import json
import os
import secrets
import sys
import threading
import time
import urllib.parse
import webbrowser
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
DATA.mkdir(exist_ok=True)

TOKEN_CACHE = DATA / ".token.json"
OUT = DATA / "artists_raw.json"

# Spotify requires an explicit loopback IP now -- "localhost" is rejected.
REDIRECT_PORT = 8888
REDIRECT_URI = f"http://127.0.0.1:{REDIRECT_PORT}/callback"

SCOPES = " ".join(
    [
        "user-top-read",  # /me/top/artists
        "user-follow-read",  # /me/following
        "user-library-read",  # /me/tracks, /me/albums
        "user-read-recently-played",  # /me/player/recently-played
        "playlist-read-private",  # /me/playlists (incl. private ones)
        "playlist-read-collaborative",  # collaborative playlists
    ]
)

API = "https://api.spotify.com/v1"
TIME_RANGES = ("short_term", "medium_term", "long_term")


# --------------------------------------------------------------------------
# credentials
# --------------------------------------------------------------------------
def load_client_id() -> str:
    """Read SPOTIFY_CLIENT_ID from the environment or the local .env file."""
    cid = os.environ.get("SPOTIFY_CLIENT_ID")
    if cid:
        return cid.strip()

    envfile = HERE / ".env"
    if envfile.exists():
        for line in envfile.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            if key.strip() == "SPOTIFY_CLIENT_ID":
                return val.strip().strip("\"'")

    sys.exit(
        "No SPOTIFY_CLIENT_ID found.\n"
        f"Create {envfile} containing:\n\n"
        "    SPOTIFY_CLIENT_ID=your_client_id_here\n\n"
        "See README.md for how to create the Spotify app. Note we use PKCE, so\n"
        "there is no client *secret* to store anywhere."
    )


# --------------------------------------------------------------------------
# oauth (authorization code + PKCE, so no client secret is ever needed)
# --------------------------------------------------------------------------
class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    code = None
    error = None

    def do_GET(self):  # noqa: N802 (stdlib naming)
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        _CallbackHandler.code = (params.get("code") or [None])[0]
        _CallbackHandler.error = (params.get("error") or [None])[0]

        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        msg = (
            "Authorized. You can close this tab and go back to the terminal."
            if _CallbackHandler.code
            else f"Authorization failed: {_CallbackHandler.error}"
        )
        self.wfile.write(
            f"<html><body style='font:16px system-ui;padding:3rem'>{msg}</body></html>".encode()
        )

    def log_message(self, *_args):
        pass  # keep the console clean


def authorize(client_id: str) -> dict:
    """Run the browser OAuth flow once and return a token bundle."""
    verifier = secrets.token_urlsafe(64)[:128]
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .decode()
        .rstrip("=")
    )
    state = secrets.token_urlsafe(16)

    auth_url = "https://accounts.spotify.com/authorize?" + urllib.parse.urlencode(
        {
            "client_id": client_id,
            "response_type": "code",
            "redirect_uri": REDIRECT_URI,
            "scope": SCOPES,
            "code_challenge_method": "S256",
            "code_challenge": challenge,
            "state": state,
        }
    )

    server = http.server.HTTPServer(("127.0.0.1", REDIRECT_PORT), _CallbackHandler)
    threading.Thread(target=server.handle_request, daemon=True).start()

    print("Opening Spotify authorization in your browser...")
    print(f"If nothing opens, paste this into a browser:\n\n{auth_url}\n")
    try:
        webbrowser.open(auth_url)
    except Exception:
        pass

    # handle_request() serves exactly one request, then the thread ends
    for _ in range(300):
        if _CallbackHandler.code or _CallbackHandler.error:
            break
        time.sleep(1)
    server.server_close()

    if _CallbackHandler.error:
        sys.exit(f"Spotify returned an error: {_CallbackHandler.error}")
    if not _CallbackHandler.code:
        sys.exit("Timed out waiting for authorization.")

    resp = requests.post(
        "https://accounts.spotify.com/api/token",
        data={
            "grant_type": "authorization_code",
            "code": _CallbackHandler.code,
            "redirect_uri": REDIRECT_URI,
            "client_id": client_id,
            "code_verifier": verifier,
        },
        timeout=30,
    )
    resp.raise_for_status()
    tok = resp.json()
    tok["expires_at"] = time.time() + tok.get("expires_in", 3600) - 60
    tok["client_id"] = client_id
    tok["granted_scopes"] = SCOPES
    _save_token(tok)
    return tok


def _save_token(tok: dict) -> None:
    TOKEN_CACHE.write_text(json.dumps(tok, indent=2))
    os.chmod(TOKEN_CACHE, 0o600)


def get_token(client_id: str) -> str:
    """Return a valid access token, refreshing or re-authorizing as needed."""
    tok = None
    if TOKEN_CACHE.exists():
        try:
            tok = json.loads(TOKEN_CACHE.read_text())
        except json.JSONDecodeError:
            tok = None

    if tok and tok.get("client_id") != client_id:
        tok = None  # different app, start over

    # A cached token only carries the scopes it was granted. If SCOPES has grown
    # since it was issued, refreshing it would keep the old, narrower grant and
    # the new endpoints would 403 -- so force a fresh authorization instead.
    if tok and tok.get("granted_scopes") != SCOPES:
        print("Scopes changed since last login -- re-authorizing.")
        tok = None

    if tok and tok.get("expires_at", 0) > time.time():
        return tok["access_token"]

    if tok and tok.get("refresh_token"):
        resp = requests.post(
            "https://accounts.spotify.com/api/token",
            data={
                "grant_type": "refresh_token",
                "refresh_token": tok["refresh_token"],
                "client_id": client_id,
            },
            timeout=30,
        )
        if resp.ok:
            new = resp.json()
            # Spotify does not always return a fresh refresh_token
            new.setdefault("refresh_token", tok["refresh_token"])
            new["expires_at"] = time.time() + new.get("expires_in", 3600) - 60
            new["client_id"] = client_id
            new["granted_scopes"] = tok.get("granted_scopes", SCOPES)
            _save_token(new)
            return new["access_token"]
        print("Refresh token rejected, re-authorizing...")

    return authorize(client_id)["access_token"]


# --------------------------------------------------------------------------
# api helpers
# --------------------------------------------------------------------------
def api_get(path: str, token: str, **params) -> dict:
    """GET an API path, transparently handling 429 rate limiting."""
    url = path if path.startswith("http") else f"{API}{path}"
    for attempt in range(6):
        resp = requests.get(
            url,
            headers={"Authorization": f"Bearer {token}"},
            params=params or None,
            timeout=30,
        )
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", "2")) + 1
            print(f"    rate limited, sleeping {wait}s")
            time.sleep(wait)
            continue
        if resp.status_code == 401:
            sys.exit("Token rejected (401). Delete data/.token.json and re-run.")
        if resp.status_code >= 500:
            time.sleep(2 * (attempt + 1))
            continue
        resp.raise_for_status()
        return resp.json()
    raise RuntimeError(f"giving up on {url}")


class ArtistTable:
    """Accumulates per-artist signals from several endpoints."""

    def __init__(self):
        self.rows: dict[str, dict] = {}
        # artist id -> set of track ids seen for them, across ALL sources.
        # A track can be liked *and* on a saved album *and* in three playlists;
        # counting it once per source would badly inflate "songs I have by
        # this artist", so the headline number is the size of this set.
        self.tracks: dict[str, set] = {}

    def credit_track(self, artist: dict, track: dict, source: str) -> None:
        """Attribute one track to one artist, deduping by track id."""
        row = self.touch(artist)
        if not row:
            return
        aid = artist["id"]
        # local files have no id; fall back to the uri, then to name+source so
        # two different local files don't collapse into one
        tid = (
            track.get("id")
            or track.get("uri")
            or f"{source}:{track.get('name', '')}"
        )
        self.tracks.setdefault(aid, set()).add(tid)
        row[source] += 1

    def touch(self, artist: dict) -> dict:
        aid = artist.get("id")
        if not aid:
            return {}
        row = self.rows.get(aid)
        if row is None:
            row = {
                "spotify_id": aid,
                "name": artist.get("name", ""),
                "spotify_url": (artist.get("external_urls") or {}).get("spotify"),
                "image": (artist.get("images") or [{}])[0].get("url"),
                # rank in each top-artists window; None if absent from that window
                "top_rank": {r: None for r in TIME_RANGES},
                "followed": False,
                # distinct tracks by this artist across every source; filled in
                # at the end from ArtistTable.tracks
                "songs": 0,
                # per-source breakdown (these DO double-count across sources)
                "saved_tracks": 0,  # Liked Songs
                "album_tracks": 0,  # tracks on albums saved to the library
                "playlist_tracks": 0,  # tracks in my own / collaborative playlists
                "saved_track_dates": [],
                "recent_plays": 0,
                # only the GDPR export can fill this in
                "plays": None,
            }
            self.rows[aid] = row
        # top-artists gives richer objects than saved-tracks does; upgrade if we can
        if not row.get("image") and artist.get("images"):
            row["image"] = artist["images"][0].get("url")
        return row


def fetch_album_tracks(album_id: str, token: str) -> list:
    """All tracks on one album (the album object only inlines the first 50)."""
    out, offset = [], 0
    while True:
        page = api_get(f"/albums/{album_id}/tracks", token, limit=50, offset=offset)
        items = page.get("items", [])
        out.extend(items)
        offset += len(items)
        if len(items) < 50 or offset > 400:  # sanity stop on pathological albums
            break
    return out


def credit_playlist(pl: dict, table: "ArtistTable", token: str) -> int:
    """
    Attribute every track in one playlist. Returns the track count.

    Note the endpoint and the payload shape: as of the Feb 2026 API this is
    /playlists/{id}/items, not /tracks (which now returns 403), and each entry
    carries the track under `item` rather than `track`. Both fallbacks are kept
    so this keeps working if either name comes back.
    """
    pid = pl.get("id")
    if not pid:
        return 0
    offset, n = 0, 0
    while True:
        page = api_get(f"/playlists/{pid}/items", token, limit=50, offset=offset)
        items = page.get("items", [])
        for item in items:
            entry = item or {}
            track = entry.get("item") or entry.get("track") or {}
            # podcast episodes have no artists; removed tracks come back null
            if not track or track.get("type") == "episode":
                continue
            for artist in track.get("artists", []):
                if artist.get("id"):
                    table.credit_track(artist, track, "playlist_tracks")
            n += 1
        offset += len(items)
        if len(items) < 50:
            break
    return n


def main():
    client_id = load_client_id()
    token = get_token(client_id)

    me = api_get("/me", token)
    print(f"Authorized as {me.get('display_name') or me.get('id')}\n")

    table = ArtistTable()

    # -- top artists, per time window ---------------------------------------
    # offset is capped near 50 on this endpoint, so 0 + 49 is all we can get
    for rng in TIME_RANGES:
        got = 0
        for offset in (0, 49):
            page = api_get(
                "/me/top/artists", token, time_range=rng, limit=50, offset=offset
            )
            for i, artist in enumerate(page.get("items", [])):
                row = table.touch(artist)
                rank = offset + i + 1
                if row and (row["top_rank"][rng] is None or rank < row["top_rank"][rng]):
                    row["top_rank"][rng] = rank
                got += 1
            if len(page.get("items", [])) < 50:
                break
        print(f"top artists [{rng:12}] {got}")

    # -- followed artists ---------------------------------------------------
    after, followed = None, 0
    while True:
        page = api_get("/me/following", token, type="artist", limit=50, after=after)
        block = page.get("artists", {})
        for artist in block.get("items", []):
            row = table.touch(artist)
            if row:
                row["followed"] = True
            followed += 1
        after = (block.get("cursors") or {}).get("after")
        if not after or not block.get("items"):
            break
    print(f"followed artists          {followed}")

    # -- saved (liked) tracks -----------------------------------------------
    # This is where the long tail lives -- artists you like but never cracked
    # a top-50 list. Each liked track credits every credited artist.
    offset, saved = 0, 0
    while True:
        page = api_get("/me/tracks", token, limit=50, offset=offset)
        items = page.get("items", [])
        for item in items:
            track = item.get("track") or {}
            added = item.get("added_at")
            for artist in track.get("artists", []):
                table.credit_track(artist, track, "saved_tracks")
                if added:
                    row = table.rows.get(artist.get("id"))
                    if row:
                        row["saved_track_dates"].append(added)
            saved += 1
        offset += len(items)
        if len(items) < 50:
            break
        if offset % 500 == 0:
            print(f"    ...{offset} liked tracks")
    print(f"liked tracks              {saved}")

    # -- saved albums -------------------------------------------------------
    # Saving an album does NOT add its tracks to Liked Songs, so without this
    # an album-listener's favourite artists can be almost invisible.
    # Spotify retired several album endpoints in Feb 2026. /me/albums survived,
    # but don't let a future removal throw away the whole run.
    offset, albums, album_tracks = 0, 0, 0
    try:
        while True:
            page = api_get("/me/albums", token, limit=50, offset=offset)
            items = page.get("items", [])
            for item in items:
                album = item.get("album") or {}
                albums += 1
                tracks = (album.get("tracks") or {}).get("items", [])
                # the album object inlines only the first 50 tracks
                if (album.get("tracks") or {}).get("next") and album.get("id"):
                    tracks = fetch_album_tracks(album["id"], token)
                for track in tracks:
                    for artist in track.get("artists", []):
                        if artist.get("id"):
                            table.credit_track(artist, track, "album_tracks")
                    album_tracks += 1
            offset += len(items)
            if len(items) < 50:
                break
        print(f"saved albums              {albums} ({album_tracks} tracks)")
    except requests.HTTPError as exc:
        print(f"saved albums              SKIPPED -- /me/albums returned "
              f"{exc.response.status_code if exc.response is not None else '?'}")

    # -- playlists ----------------------------------------------------------
    # Mine and collaborative ones only. Playlists merely *followed* are someone
    # else's taste, so they are skipped.
    me_id = me.get("id")
    offset, kept, skipped, pl_tracks = 0, 0, 0, 0
    while True:
        page = api_get("/me/playlists", token, limit=50, offset=offset)
        items = page.get("items", [])
        for pl in items:
            if not pl:
                continue
            owner = (pl.get("owner") or {}).get("id")
            mine = owner == me_id
            collab = bool(pl.get("collaborative"))
            if not (mine or collab):
                skipped += 1
                continue
            kept += 1
            try:
                n = credit_playlist(pl, table, token)
            except requests.HTTPError as exc:
                code = exc.response.status_code if exc.response is not None else "?"
                print(f"    !! skipped {pl.get('name', '?')[:40]} (HTTP {code})")
                continue
            pl_tracks += n
            print(f"    {n:>5} tracks  {pl.get('name', '?')[:44]}"
                  f"{'  [collab]' if collab and not mine else ''}")
        offset += len(items)
        if len(items) < 50:
            break
    print(f"playlists                 {kept} used, {skipped} followed-only skipped "
          f"({pl_tracks} tracks)")

    # -- recently played (last 50 only, but it is free signal) --------------
    page = api_get("/me/player/recently-played", token, limit=50)
    for item in page.get("items", []):
        for artist in (item.get("track") or {}).get("artists", []):
            row = table.touch(artist)
            if row:
                row["recent_plays"] += 1
    print(f"recent plays              {len(page.get('items', []))}")

    # -- roll the deduped track sets up into the headline "songs" number ----
    for aid, row in table.rows.items():
        row["songs"] = len(table.tracks.get(aid, ()))

    artists = sorted(table.rows.values(), key=lambda r: r["name"].lower())
    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "user": me.get("display_name") or me.get("id"),
        "has_play_counts": False,
        "artist_count": len(artists),
        "artists": artists,
    }
    OUT.write_text(json.dumps(payload, indent=2))

    print(f"\n{len(artists)} distinct artists -> {OUT.relative_to(HERE.parent.parent)}")
    print("Next: python3 enrich_hometowns.py")


if __name__ == "__main__":
    main()
