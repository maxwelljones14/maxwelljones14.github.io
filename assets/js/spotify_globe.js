/* ---------------------------------------------------------------------------
 * Rotating globe of my favourite artists' hometowns.
 *
 * Three encodings, drawn bottom to top:
 *   1. country polygons  -- blue sequential ramp, artist count per country
 *   2. state polygons    -- same ramp, drawn above countries where we have
 *                           admin-1 shapes, so the US/UK/etc. get real detail
 *   3. city points       -- orange ramp, height + radius + colour by count
 *
 * Countries and cities are two *simultaneous* sequential contexts, which is
 * why they get different hues rather than different steps of one ramp.
 *
 * Everything about the colour scale is tunable at runtime -- append ?tune=1 to
 * the URL (or click "tune scale") to get sliders, then hit "copy config" and
 * paste the result over DEFAULTS below to make it permanent. The data files
 * carry raw counts, never pre-baked colours, precisely so this works.
 * ------------------------------------------------------------------------- */

(function () {
  "use strict";

  const MOUNT_ID = "spotify-globe";
  const DATA_DIR = "/assets/json/spotify_globe";
  const GLOBE_LIB =
    "https://cdn.jsdelivr.net/npm/globe.gl@2.46.2/dist/globe.gl.min.js";

  /* -- state layer modes ---------------------------------------------------
   * The admin-1 layer is all-or-nothing per country in the data file, but not
   * every country benefits from it on screen. Default to US-only: that is where
   * the overwhelming majority of the artists are, so state detail is genuinely
   * informative there and mostly noise elsewhere (many countries have artists
   * in just two or three regions, which the country fill already conveys).
   */
  const STATES_ALL = "all";
  const STATES_US = "us";
  const STATES_NONE = "none";
  const STATE_MODES = [
    { value: STATES_ALL, label: "all states" },
    { value: STATES_US, label: "US only" },
    { value: STATES_NONE, label: "off" },
  ];
  const US_ISO = "USA";

  // globe.gl draws the sphere at radius 100; altitude = distance / radius - 1
  const GLOBE_R = 100;

  /* -- tunables ----------------------------------------------------------- *
   * curve: how a raw artist count becomes a 0..1 intensity.
   *   linear -- v / max. Honest, but one big city flattens everything else.
   *   gamma  -- (v / max) ^ gamma. gamma < 1 lifts the tail. The good default.
   *   log    -- log1p(v) / log1p(max). Aggressive tail lift.
   *   rank   -- percentile rank. Ignores magnitude entirely; every region is
   *             spaced evenly. Use when one region dwarfs the rest.
   * floor: minimum intensity for anywhere with >= 1 artist, so a single-artist
   *   country in Iceland is still clearly visible against "no artists here".
   * clipPct: normalise against this percentile instead of the true max, so a
   *   single enormous outlier doesn't compress the whole scale. 100 = use max.
   *
   * Each layer normalises against its OWN distribution, so countries (max ~100)
   * and states (max ~20) stay independently readable.
   *
   * These defaults were swept against the sample distribution (one country at
   * ~58% of all artists, a long tail of 1s). gamma 0.35 keeps the top two
   * clearly apart while still rendering a one-artist country at ~31%
   * intensity; linear would have put it at 1%, i.e. invisible. Leaving clipPct
   * at 100 is deliberate -- gamma already does the tail lift, and clipping on
   * top of it collapses #1 and #2 into the same colour.
   */
  const DEFAULTS = {
    regions: { curve: "gamma", gamma: 0.35, floor: 0.14, clipPct: 100 },
    cities: { curve: "gamma", gamma: 0.45, floor: 0.22, clipPct: 100 },
    show: { countries: true, states: STATES_US, cities: true },
    autoRotate: true,
  };

  /* -- palette ------------------------------------------------------------ *
   * Blue sequential ramp is the reference palette's; the orange ramp is its
   * slot-2 hue extended into a one-hue ramp. The mid steps of the two ramps
   * were validated against each other in both modes (CVD dE 24.7 light /
   * 26.8 dark, both well clear of the >= 8 target).
   */
  const RAMPS = {
    light: {
      // low -> high magnitude gets darker, receding toward the light surface
      region: ["#cde2fb", "#9ec5f4", "#6da7ec", "#2a78d6", "#1c5cab", "#0d366b"],
      city: ["#f5a07b", "#f08050", "#eb6834", "#d95926", "#bd4a1d", "#9c3c17"],
      empty: "#dedbd4", // a region we have no artists from
      globe: "#f7f6f3",
      border: "#b8b7b1",
      text: "#0b0b0b",
      textDim: "#52514e",
      panel: "#fcfcfb",
    },
    dark: {
      // low -> high gets brighter, receding toward the dark surface
      region: ["#104281", "#1c5cab", "#256abf", "#3987e5", "#6da7ec", "#b7d3f6"],
      city: ["#7d2f11", "#9c3c17", "#bd4a1d", "#d95926", "#eb6834", "#f5a07b"],
      empty: "#2c2c2a",
      globe: "#1f1f1e",
      border: "#4a4a46",
      text: "#ffffff",
      textDim: "#c3c2b7",
      panel: "#1a1a19",
    },
  };

  /* -- helpers ------------------------------------------------------------ */

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /**
   * Always hand three.js an rgba() string, never #rrggbbaa -- three cannot
   * parse 8-digit hex, and a colour it fails to parse does not fail loudly.
   */
  function rgba(hex, alpha) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  /** Sample a discrete ramp with linear interpolation between stops. */
  function rampColor(stops, t, alpha) {
    const clamped = Math.max(0, Math.min(1, t));
    const pos = clamped * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(pos));
    const f = pos - i;
    const a = hexToRgb(stops[i]);
    const b = hexToRgb(stops[i + 1]);
    const mix = a.map((v, k) => Math.round(v + (b[k] - v) * f));
    return `rgba(${mix[0]},${mix[1]},${mix[2]},${alpha == null ? 1 : alpha})`;
  }

  /**
   * Build count -> intensity for one layer, using that layer's own values.
   * Returns a function; values <= 0 map to exactly 0 so "no data" stays
   * distinguishable from "the smallest amount of data".
   */
  function makeScale(values, opts) {
    const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
    if (!sorted.length) return () => 0;

    const pct = (p) =>
      sorted[
        Math.min(
          sorted.length - 1,
          Math.max(0, Math.round((p / 100) * (sorted.length - 1)))
        )
      ];
    const cap = Math.max(1, opts.clipPct >= 100 ? sorted[sorted.length - 1] : pct(opts.clipPct));

    return function (v) {
      if (!v || v <= 0) return 0;
      let t;
      if (opts.curve === "rank") {
        // how many distinct values sit at or below v
        let lo = 0;
        let hi = sorted.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (sorted[mid] < v) lo = mid + 1;
          else hi = mid;
        }
        t = sorted.length > 1 ? lo / (sorted.length - 1) : 1;
      } else if (opts.curve === "log") {
        t = Math.log1p(Math.min(v, cap)) / Math.log1p(cap);
      } else if (opts.curve === "linear") {
        t = Math.min(v, cap) / cap;
      } else {
        t = Math.pow(Math.min(v, cap) / cap, opts.gamma);
      }
      t = Math.max(0, Math.min(1, t));
      return opts.floor + (1 - opts.floor) * t;
    };
  }

  function currentMode() {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark" || attr === "light") return attr;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.Globe) return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error("could not load globe.gl"));
      document.head.appendChild(s);
    });
  }

  /**
   * Casefold and strip accents, so "sao paulo" matches "São Paulo" and
   * "dusseldorf" matches "Düsseldorf". Falls back gracefully on engines
   * without Unicode property escapes in normalize.
   */
  function foldText(s) {
    let out = String(s == null ? "" : s).toLowerCase();
    try {
      out = out.normalize("NFD").replace(/[̀-ͯ]/g, "");
    } catch (e) {
      /* normalize is universally supported; this is belt and braces */
    }
    return out.trim();
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  /* -- main --------------------------------------------------------------- */

  async function boot(mount) {
    const status = (msg) => {
      const el = mount.querySelector(".sg-status");
      if (el) el.textContent = msg;
    };

    let data, countriesGeo, statesGeo;
    try {
      status("loading data…");
      const [d, c, s] = await Promise.all([
        fetch(`${DATA_DIR}/globe_data.json`).then((r) => {
          if (!r.ok) throw new Error("globe_data.json");
          return r.json();
        }),
        fetch(`${DATA_DIR}/countries.geojson`).then((r) => r.json()),
        // Only the US admin-1 shapes up front (~32 KB gzipped). The rest of the
        // world is another ~217 KB that the default view never draws, so it is
        // fetched on demand -- see loadWorldStates().
        fetch(`${DATA_DIR}/states_us.geojson`).then((r) => r.json()),
      ]);
      data = d;
      countriesGeo = c;
      statesGeo = s;
      status("loading globe…");
      await loadScript(GLOBE_LIB);
    } catch (err) {
      mount.querySelector(".sg-stage").innerHTML =
        `<p class="sg-error">Couldn't load the globe (${esc(err.message)}).</p>`;
      return;
    }

    const cfg = JSON.parse(JSON.stringify(DEFAULTS));
    const stage = mount.querySelector(".sg-stage");
    stage.innerHTML = "";

    // -- shape the data for each layer ------------------------------------
    // Every row carries a `spans` map ({all, long_term, ...}); switching
    // timespan just re-reads a different key, no refetch and no recompute of
    // anything but the colour scales.
    const countryCounts = data.countries || {};
    const stateCounts = data.states || {};
    const allCities = data.cities || [];

    const SPANS = data.spans && data.spans.length
      ? data.spans
      : [{ key: "all", label: "all time", note: "" }];
    let span =
      SPANS.some((s) => s.key === data.default_span) ? data.default_span : SPANS[0].key;

    // Regions store integer indices into one shared artist table, so the full
    // artist list for a region costs a handful of small ints rather than a
    // repeated block of names.
    const artistTable = data.artists || [];
    // "songs" = that artist's tracks in my library; becomes lifetime plays
    // once the extended-history export has been imported.
    const METRIC = data.song_metric === "plays" ? "play" : "song";

    /** Artist count for a row in the active span; 0 if it isn't in that span. */
    const nOf = (row) => (row && row.spans && row.spans[span] ? row.spans[span].c : 0);
    /** Every artist for a row in the active span, most-liked first. */
    const artistsOf = (row) => {
      const idx = row && row.spans && row.spans[span] ? row.spans[span].i : null;
      return idx ? idx.map((i) => artistTable[i]).filter(Boolean) : [];
    };
    const namesOf = (row) => artistsOf(row).map((a) => a.n);
    const songsOf = (a) => (METRIC === "play" ? a.p || 0 : a.s || 0);

    const countryFeatures = (countriesGeo.features || []).map((f) => {
      f.properties.row = countryCounts[f.properties.id];
      f.properties.layer = "country";
      return f;
    });
    function prepStates(fc) {
      return (fc.features || []).map((f) => {
        f.properties.row = stateCounts[f.properties.id];
        f.properties.layer = "state";
        return f;
      });
    }
    // starts as US-only; grows once the rest of the world is fetched
    let stateFeatures = prepStates(statesGeo);

    /**
     * Fetch the non-US admin-1 geometry, once. Resolves to true if the layer is
     * usable afterwards, false if the fetch failed (in which case the caller
     * falls back rather than leaving the user on a silently empty layer).
     */
    let worldStates = null; // null = not requested yet
    function loadWorldStates() {
      if (worldStates) return worldStates;
      worldStates = fetch(`${DATA_DIR}/states_world.geojson`)
        .then((r) => {
          if (!r.ok) throw new Error("states_world.geojson");
          return r.json();
        })
        .then((fc) => {
          stateFeatures = stateFeatures.concat(prepStates(fc));
          return true;
        })
        .catch(() => {
          worldStates = null; // allow a retry on the next attempt
          return false;
        });
      return worldStates;
    }

    /**
     * Is this state polygon drawn right now?
     *
     * Note the artist-count test. A state with nothing in it must be left out
     * of the layer entirely, not merely painted transparent: three.js still
     * writes depth for a fully transparent cap, so an "invisible" state at a
     * higher altitude than its country punches a dark hole through the country
     * fill beneath it. Empty regions therefore hover as their country, which is
     * what you want anyway.
     */
    function stateShown(f) {
      if (cfg.show.states === STATES_NONE) return false;
      // STATES_US: the geometry carries the parent country's ISO code
      if (cfg.show.states === STATES_US && f.properties.iso !== US_ISO) return false;
      return nOf(f.properties.row) > 0;
    }

    /** The same test, against a row in globe_data.states. */
    function stateRowShown(row) {
      if (cfg.show.states === STATES_NONE) return false;
      if (cfg.show.states === STATES_ALL) return true;
      return row && row.iso === US_ISO;
    }

    // Each layer gets its own scale, rebuilt when the span or the knobs change.
    let scales = {};
    let visibleCities = [];
    let visibleStateFeatures = [];
    function rebuildScales() {
      visibleCities = allCities.filter((c) => nOf(c) > 0);
      visibleStateFeatures = stateFeatures.filter(stateShown);
      // Normalise the state ramp over the states actually on screen. In US-only
      // mode the worldwide distribution would waste most of the ramp on regions
      // nobody can see.
      const stateVals = Object.values(stateCounts).filter(stateRowShown).map(nOf);
      scales = {
        country: makeScale(Object.values(countryCounts).map(nOf), cfg.regions),
        state: makeScale(stateVals, cfg.regions),
        city: makeScale(visibleCities.map(nOf), cfg.cities),
      };
    }
    rebuildScales();

    // -- build the globe ---------------------------------------------------
    const globe = new Globe(stage);
    let mode = currentMode();
    let pal = RAMPS[mode];

    function polygons() {
      const out = [];
      if (cfg.show.countries) out.push(...countryFeatures);
      out.push(...visibleStateFeatures);
      return out;
    }

    function polyCap(f) {
      const p = f.properties;
      const t = scales[p.layer](nOf(p.row));
      // A state with no artists drops out entirely so the country beneath it
      // still reads; a country with none gets the flat "no data" tone.
      if (t <= 0) {
        return p.layer === "state" ? "rgba(0,0,0,0)" : rgba(pal.empty, 0.85);
      }
      return rampColor(pal.region, t, p.layer === "state" ? 0.95 : 0.85);
    }

    /**
     * What a hovered polygon should actually describe.
     *
     * The state layer sits on top of the country layer, so without a fallback
     * the 24 countries that have admin-1 shapes could never be hovered at all.
     * A state with no artists of its own therefore defers to its country:
     * hover Kansas and you get the United States, hover Georgia and you get
     * Georgia.
     */
    function resolveRegion(f) {
      const p = f.properties;
      if (p.layer === "state" && !nOf(p.row)) {
        const parent = p.iso && countryCounts[p.iso];
        if (parent && nOf(parent)) {
          return { row: parent, title: p.country || p.iso, where: "" };
        }
      }
      return { row: p.row, title: p.name, where: p.country || "" };
    }

    function polyLabel(f) {
      const { row, title } = resolveRegion(f);
      const n = nOf(row);
      if (!n) return "";
      const names = namesOf(row).slice(0, 5).join(", ");
      return `<div class="sg-tip"><strong>${esc(title)}</strong>
        <span>${n} artist${n === 1 ? "" : "s"}</span>
        ${names ? `<em>${esc(names)}</em>` : ""}</div>`;
    }

    /* -- hover detail panel ------------------------------------------------
     * The cursor tooltip stays short on purpose: the US has 100+ artists, and
     * a tooltip that long would run off the screen and can't be scrolled
     * (globe.gl's tooltip ignores pointer events). So hovering also fills a
     * panel beside the globe with the *complete* list and each artist's song
     * count, and clicking pins it so you can move the mouse over and scroll.
     */
    const detail = mount.querySelector(".sg-detail");
    let pinned = null;

    function detailHTML(title, subtitle, list) {
      const rows = list
        .map((a) => {
          const songs = songsOf(a);
          return `<li><span class="sg-a-name">${esc(a.n)}</span>
            <span class="sg-a-num">${songs}</span></li>`;
        })
        .join("");
      return `
        <div class="sg-detail-head">
          <strong>${esc(title)}</strong>
          <span>${esc(subtitle)}</span>
        </div>
        <ol class="sg-artists">${rows}</ol>
        <p class="sg-detail-foot">${METRIC === "play" ? "plays" : "songs in my library"}
          &middot; ${pinned ? "pinned, click the globe to release" : "click to pin"}</p>`;
    }

    /**
     * Normalise anything selectable -- a city point, a hovered polygon, or a
     * search hit -- into { title, where, row }, so one renderer serves all
     * three entry points.
     */
    function describe(kind, obj) {
      if (!obj) return null;
      if (kind === "city") return { title: obj.place, where: obj.country, row: obj };
      const r = resolveRegion(obj);
      return { title: r.title, where: r.where, row: r.row };
    }

    function showDetail(desc) {
      if (!detail) return;
      if (!desc || !desc.row) {
        detail.innerHTML = `<p class="sg-detail-empty">Hover or search a country,
          state or city to see every artist from there.</p>`;
        detail.classList.remove("is-pinned");
        return;
      }
      const list = artistsOf(desc.row);
      if (!list.length) return;

      const spanLabel = (SPANS.find((s) => s.key === span) || {}).label || span;
      const subtitle =
        `${list.length} artist${list.length === 1 ? "" : "s"}` +
        (desc.where ? ` · ${desc.where}` : "") +
        ` · ${spanLabel}`;

      detail.innerHTML = detailHTML(desc.title, subtitle, list);
      detail.classList.toggle("is-pinned", !!pinned);
    }

    function hoverHandler(kind) {
      return (obj) => {
        if (pinned) return;
        showDetail(describe(kind, obj));
      };
    }
    function clickHandler(kind) {
      return (obj) => {
        const same = pinned && pinned.kind === kind && pinned.obj === obj;
        pinned = same || !obj ? null : { kind, obj, desc: describe(kind, obj) };
        showDetail(pinned ? pinned.desc : describe(kind, obj));
      };
    }

    globe
      .backgroundColor("rgba(0,0,0,0)")
      .showAtmosphere(false)
      .polygonsData(polygons())
      .polygonCapColor(polyCap)
      .polygonSideColor(() => "rgba(0,0,0,0.05)")
      .polygonStrokeColor(() => pal.border)
      // states float just above countries so both outlines stay visible
      .polygonAltitude((f) => (f.properties.layer === "state" ? 0.013 : 0.008))
      .polygonLabel(polyLabel)
      .onPolygonHover(hoverHandler("region"))
      .onPolygonClick(clickHandler("region"))
      .pointsData(cfg.show.cities ? visibleCities : [])
      .pointLat("lat")
      .pointLng("lon")
      // short and stubby: tall thin spikes overlap each other badly in dense
      // regions and hide the state colours underneath
      .pointAltitude((c) => 0.012 + scales.city(nOf(c)) * 0.11)
      .pointRadius((c) => 0.22 + scales.city(nOf(c)) * 0.36)
      .pointColor((c) => rampColor(pal.city, scales.city(nOf(c)), 0.92))
      .pointLabel((c) => {
        const n = nOf(c);
        const who = namesOf(c).slice(0, 6).join(", ");
        return `<div class="sg-tip"><strong>${esc(c.place)}</strong>
          <span>${esc(c.country)} &middot; ${n} artist${n === 1 ? "" : "s"}</span>
          ${who ? `<em>${esc(who)}</em>` : ""}</div>`;
      })
      .onPointHover(hoverHandler("city"))
      .onPointClick(clickHandler("city"));

    showDetail(null); // start with the empty prompt

    // A plain coloured sphere, not a photo of Earth -- satellite imagery
    // competes with the data for attention and wrecks the colour scale.
    // Mutating the existing material avoids needing a THREE handle of our own.
    function paintGlobe() {
      try {
        const m = globe.globeMaterial();
        m.color.set(pal.globe);
        m.emissive.set(mode === "dark" ? "#0a0a0a" : "#ffffff");
        m.emissiveIntensity = mode === "dark" ? 0.08 : 0.25;
        m.shininess = 0.1;
      } catch (e) {
        /* material shape varies across versions; this is cosmetic only */
      }
    }
    paintGlobe();

    globe.controls().autoRotate = cfg.autoRotate;
    globe.controls().autoRotateSpeed = 0.45;
    globe.controls().enableZoom = true;
    // 65% of the artists are American, so open on North America rather than the
    // mid-Atlantic; auto-rotate brings Europe and Africa round soon enough.
    globe.pointOfView({ lat: 30, lng: -90, altitude: 2.3 });

    // pause the spin while the user is actually interacting
    stage.addEventListener("pointerdown", () => {
      globe.controls().autoRotate = false;
    });
    stage.addEventListener("pointerup", () => {
      if (cfg.autoRotate) globe.controls().autoRotate = true;
    });

    /* -- zoom ---------------------------------------------------------------
     * Bounds first. OrbitControls defaults let you dolly out to distance 10000
     * (altitude ~99), which on a stray two-finger swipe leaves the globe a dot
     * in the middle of the canvas with no obvious way back. globe.gl's globe
     * radius is 100 and altitude = distance / radius - 1.
     */
    const ZOOM_MIN = 0.18; // close enough to read city labels
    const ZOOM_MAX = 3.2; // whole globe, comfortably framed
    globe.controls().minDistance = GLOBE_R * (1 + ZOOM_MIN);
    globe.controls().maxDistance = GLOBE_R * (1 + ZOOM_MAX);

    function zoomTo(alt, ms) {
      globe.pointOfView(
        { altitude: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, alt)) },
        ms == null ? 180 : ms
      );
    }
    function zoomBy(factor) {
      zoomTo(globe.pointOfView().altitude * factor);
    }

    /* Safari's pinch problem.
     *
     * Chromium honours `touch-action: none` on the canvas, so OrbitControls
     * receives the two-finger stream and pinch-to-zoom works. iOS Safari does
     * not: pinch is a browser-level gesture there, `touch-action` does not
     * suppress it, and once Safari claims the gesture it stops delivering the
     * second pointer -- so the *page* zooms and the globe never moves.
     *
     * Safari signals this through the non-standard gesture* events, which are
     * both how we stop the page zoom and how we drive the globe instead.
     * Chromium and Firefox never fire them, so their working path is untouched.
     * The maxTouchPoints guard keeps desktop Safari out of it: a trackpad pinch
     * there also fires gesture* events, but OrbitControls already handles that
     * via ctrl+wheel and would otherwise zoom twice.
     */
    let gestureStartAlt = null;
    const touchDevice = (navigator.maxTouchPoints || 0) > 0;
    stage.addEventListener("gesturestart", (ev) => {
      ev.preventDefault();
      gestureStartAlt = globe.pointOfView().altitude;
      globe.controls().autoRotate = false;
    }, { passive: false });
    stage.addEventListener("gesturechange", (ev) => {
      ev.preventDefault();
      if (gestureStartAlt == null || !touchDevice) return;
      // ev.scale is cumulative from gesturestart; >1 means fingers spread
      zoomTo(gestureStartAlt / Math.max(ev.scale || 1, 0.05), 0);
    }, { passive: false });
    stage.addEventListener("gestureend", (ev) => {
      ev.preventDefault();
      gestureStartAlt = null;
      if (cfg.autoRotate) globe.controls().autoRotate = true;
    }, { passive: false });

    /* Explicit zoom buttons. Gesture support varies across mobile browsers in
     * ways that cannot all be verified, and these also help anyone who does not
     * realise the globe responds to scroll.
     */
    const zoomUI = document.createElement("div");
    zoomUI.className = "sg-zoom";
    zoomUI.setAttribute("role", "group");
    zoomUI.setAttribute("aria-label", "Zoom the globe");
    zoomUI.innerHTML =
      `<button type="button" class="sg-zoom-btn" data-z="in" aria-label="Zoom in">+</button>` +
      `<button type="button" class="sg-zoom-btn" data-z="out" aria-label="Zoom out">&minus;</button>`;
    zoomUI.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".sg-zoom-btn");
      if (btn) zoomBy(btn.dataset.z === "in" ? 0.65 : 1 / 0.65);
    });
    // The buttons sit inside .sg-stage, so their pointer events would otherwise
    // bubble to the stage's spin handlers and restart rotation on every tap.
    ["pointerdown", "pointerup"].forEach((t) =>
      zoomUI.addEventListener(t, (ev) => ev.stopPropagation())
    );
    stage.appendChild(zoomUI);

    function resize() {
      const w = stage.clientWidth || mount.clientWidth;
      const h = Math.max(340, Math.min(w * 0.78, 560));
      globe.width(w).height(h);
      // Pin the panel to the globe's height. Without an explicit cap it grows
      // to fit its content, and a 100+ artist list would stretch the flex row
      // (and the globe with it) to several thousand pixels instead of
      // scrolling inside the panel.
      if (detail && window.matchMedia("(min-width: 769px)").matches) {
        detail.style.maxHeight = h + "px";
      } else if (detail) {
        detail.style.maxHeight = "";
      }
    }
    resize();
    window.addEventListener("resize", resize);

    // -- theme switching ---------------------------------------------------
    function applyTheme() {
      mode = currentMode();
      pal = RAMPS[mode];
      globe.atmosphereColor(mode === "dark" ? "#3987e5" : "#9ec5f4");
      paintGlobe();
      refresh();
      renderLegend();
    }
    new MutationObserver(applyTheme).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", applyTheme);

    function refresh() {
      rebuildScales();
      // A pinned state can be hidden out from under the panel by switching the
      // state-layer mode, which would leave the detail stuck on a region that
      // is no longer drawn.
      if (
        pinned &&
        pinned.obj &&
        pinned.kind === "region" &&
        pinned.obj.properties.layer === "state" &&
        !stateShown(pinned.obj)
      ) {
        pinned = null;
        showDetail(null);
      }
      globe
        .polygonsData(polygons())
        .polygonCapColor(polyCap)
        .polygonStrokeColor(() => pal.border)
        .pointsData(cfg.show.cities ? visibleCities : []);
    }

    /** Everything that has to be redrawn when the timespan changes. */
    function setSpan(next) {
      if (next === span) return;
      span = next;
      refresh();
      renderLegend();
      renderCaption();
      renderTable();
      // a pinned region may have no artists at all in the new span
      if (pinned && !nOf(pinned.kind === "city" ? pinned.obj : resolveRegion(pinned.obj).row)) {
        pinned = null;
      }
      rebuildSearchIndex();
      closeResults();
      // a pin survives a span change, but its artist list must be re-read
      if (pinned) {
        // a search pin has no polygon behind it; re-read its row for the span
        if (pinned.obj) pinned.desc = describe(pinned.kind, pinned.obj);
        else if (!nOf(pinned.desc.row)) pinned = null;
      }
      showDetail(pinned ? pinned.desc : null);
      mount.querySelectorAll(".sg-span-btn").forEach((btn) => {
        const on = btn.dataset.span === span;
        btn.classList.toggle("is-active", on);
        btn.setAttribute("aria-pressed", String(on));
      });
    }

    // -- timespan control ---------------------------------------------------
    const spanBar = mount.querySelector(".sg-spans");
    if (spanBar) {
      spanBar.innerHTML =
        `<span class="sg-spans-label" id="sg-spans-label">timespan</span>` +
        SPANS.map(
          (s) =>
            `<button type="button" class="sg-span-btn${s.key === span ? " is-active" : ""}"
               data-span="${esc(s.key)}" title="${esc(s.note || "")}"
               aria-pressed="${s.key === span}">${esc(s.label)}</button>`
        ).join("");
      spanBar.setAttribute("role", "group");
      spanBar.setAttribute("aria-labelledby", "sg-spans-label");
      spanBar.addEventListener("click", (ev) => {
        const btn = ev.target.closest(".sg-span-btn");
        if (btn) setSpan(btn.dataset.span);
      });
    }

    /* -- search -------------------------------------------------------------
     * One flat index over cities, states and countries. It is rebuilt whenever
     * the timespan changes, because a place with no artists in the active span
     * has nothing to show and shouldn't be offered.
     */
    let searchIndex = [];
    function rebuildSearchIndex() {
      const idx = [];
      allCities.forEach((c) => {
        if (nOf(c) > 0) {
          idx.push({ kind: "city", name: c.place || "", where: c.country || "",
                     lat: c.lat, lon: c.lon, row: c, alt: 1.05 });
        }
      });
      Object.keys(stateCounts).forEach((sid) => {
        const r = stateCounts[sid];
        if (nOf(r) > 0 && r.lat != null) {
          idx.push({ kind: "state", name: r.name || sid, where: r.country || "",
                     lat: r.lat, lon: r.lon, row: r, iso: r.iso, alt: 1.5 });
        }
      });
      Object.keys(countryCounts).forEach((iso) => {
        const r = countryCounts[iso];
        if (nOf(r) > 0 && r.lat != null) {
          idx.push({ kind: "country", name: r.name || iso, where: "",
                     lat: r.lat, lon: r.lon, row: r, iso: iso, alt: 1.9 });
        }
      });
      idx.forEach((e) => {
        e.key = foldText(e.name);
        e.whereKey = foldText(e.where);
        e.count = nOf(e.row);
      });
      searchIndex = idx;
    }
    rebuildSearchIndex();

    /** Countries whose admin-1 shapes exist in the data (US file + world file). */
    const countriesWithStates = new Set(
      Object.keys(stateCounts)
        .map((sid) => stateCounts[sid].iso)
        .filter(Boolean)
    );

    function searchFor(qRaw) {
      const q = foldText(qRaw);
      if (q.length < 2) return [];
      const hits = [];
      for (const e of searchIndex) {
        // rank: name prefix beats name substring beats a match on the parent
        let rank = -1;
        if (e.key.startsWith(q)) rank = 0;
        else if (e.key.indexOf(q) !== -1) rank = 1;
        else if (e.whereKey.indexOf(q) === 0) rank = 2;
        if (rank >= 0) hits.push({ e, rank });
      }
      hits.sort(
        (a, b) =>
          a.rank - b.rank ||
          b.e.count - a.e.count ||
          a.e.name.length - b.e.name.length
      );
      return hits.slice(0, 8).map((h) => h.e);
    }

    const searchWrap = mount.querySelector(".sg-search");
    const searchInput = mount.querySelector(".sg-search-input");
    const searchList = mount.querySelector(".sg-search-results");
    let activeHit = -1;
    let currentHits = [];

    function closeResults() {
      if (!searchList) return;
      searchList.hidden = true;
      searchList.innerHTML = "";
      activeHit = -1;
      currentHits = [];
      if (searchInput) searchInput.setAttribute("aria-expanded", "false");
    }

    function renderResults(hits) {
      if (!searchList) return;
      currentHits = hits;
      activeHit = -1;
      if (!hits.length) {
        searchList.innerHTML = `<li class="sg-search-empty">no match in this timespan</li>`;
        searchList.hidden = false;
        searchInput.setAttribute("aria-expanded", "true");
        return;
      }
      searchList.innerHTML = hits
        .map(
          (e, i) =>
            `<li role="option" id="sg-hit-${i}" data-i="${i}" aria-selected="false">
               <span class="sg-hit-kind">${e.kind}</span>
               <span class="sg-hit-name">${esc(e.name)}</span>
               ${e.where ? `<span class="sg-hit-where">${esc(e.where)}</span>` : ""}
               <span class="sg-hit-n">${e.count}</span>
             </li>`
        )
        .join("");
      searchList.hidden = false;
      searchInput.setAttribute("aria-expanded", "true");
    }

    function highlight(i) {
      const items = searchList ? searchList.querySelectorAll("li[data-i]") : [];
      items.forEach((el, k) => {
        const on = k === i;
        el.classList.toggle("is-active", on);
        el.setAttribute("aria-selected", String(on));
      });
      activeHit = i;
      if (searchInput) {
        searchInput.setAttribute("aria-activedescendant", i >= 0 ? `sg-hit-${i}` : "");
      }
      if (items[i]) items[i].scrollIntoView({ block: "nearest" });
    }

    /**
     * Fly to a search hit and pin its artist list.
     *
     * Picking a country also brings up its states when the data has them, which
     * is the point of searching a country rather than just hovering it. That can
     * mean fetching the rest-of-world geometry and switching the state layer, so
     * this is async.
     */
    async function gotoHit(e) {
      if (!e) return;

      // spinning would immediately carry the target back off screen
      setSpin(false);

      const wantStates =
        (e.kind === "country" && countriesWithStates.has(e.iso)) ||
        e.kind === "state";
      if (wantStates) {
        const iso = e.iso || (e.row && e.row.iso);
        const needWorld = iso !== US_ISO;
        if (cfg.show.states === STATES_NONE || (needWorld && cfg.show.states === STATES_US)) {
          const ok = needWorld ? await loadWorldStates() : true;
          if (ok) {
            cfg.show.states = needWorld ? STATES_ALL : STATES_US;
            syncTuner();
          }
        }
      }

      refresh();
      globe.pointOfView({ lat: e.lat, lng: e.lon, altitude: e.alt }, 900);

      pinned = { kind: e.kind === "city" ? "city" : "region", obj: null,
                 desc: { title: e.name, where: e.where, row: e.row } };
      showDetail(pinned.desc);

      if (searchInput) searchInput.value = e.name;
      closeResults();
    }

    if (searchInput) {
      searchInput.addEventListener("input", () => {
        const v = searchInput.value.trim();
        if (v.length < 2) return closeResults();
        renderResults(searchFor(v));
      });
      searchInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") return closeResults();
        if (!currentHits.length) return;
        if (ev.key === "ArrowDown") {
          ev.preventDefault();
          highlight((activeHit + 1) % currentHits.length);
        } else if (ev.key === "ArrowUp") {
          ev.preventDefault();
          highlight((activeHit - 1 + currentHits.length) % currentHits.length);
        } else if (ev.key === "Enter") {
          ev.preventDefault();
          gotoHit(currentHits[activeHit >= 0 ? activeHit : 0]);
        }
      });
      searchInput.addEventListener("focus", () => {
        const v = searchInput.value.trim();
        if (v.length >= 2) renderResults(searchFor(v));
      });
    }
    if (searchList) {
      searchList.addEventListener("mousedown", (ev) => {
        // mousedown, not click: blur would close the list first
        const li = ev.target.closest("li[data-i]");
        if (li) {
          ev.preventDefault();
          gotoHit(currentHits[+li.dataset.i]);
        }
      });
    }
    document.addEventListener("click", (ev) => {
      if (searchWrap && !searchWrap.contains(ev.target)) closeResults();
    });

    // -- spin toggle (the visible one; the tuner has a mirror of it) --------
    const spinToggle = mount.querySelector(".sg-spin-toggle");
    function setSpin(on) {
      cfg.autoRotate = on;
      globe.controls().autoRotate = on;
      if (spinToggle) spinToggle.checked = on;
      syncTuner();
    }
    /** Keep the tuning panel's copy of the shared state honest. */
    function syncTuner() {
      const t = mount.querySelector('.sg-tuner input[data-k="autoRotate"]');
      if (t) t.checked = cfg.autoRotate;
      const s = mount.querySelector('.sg-tuner select[data-k="show.states"]');
      if (s) s.value = cfg.show.states;
    }
    if (spinToggle) {
      spinToggle.checked = cfg.autoRotate;
      spinToggle.addEventListener("change", () => setSpin(spinToggle.checked));
    }

    // -- legend ------------------------------------------------------------
    const legend = mount.querySelector(".sg-legend");
    function renderLegend() {
      const swatches = (stops) =>
        stops.map((s) => `<i style="background:${s}"></i>`).join("");
      const cMax = Math.max(0, ...Object.values(countryCounts).map(nOf));
      const cityMax = Math.max(0, ...visibleCities.map(nOf));
      legend.innerHTML = `
        <div class="sg-key">
          <span class="sg-key-label">countries &amp; states</span>
          <span class="sg-ramp">${swatches(pal.region)}</span>
          <span class="sg-key-range">1<span aria-hidden="true"> &rarr; </span>${cMax}</span>
        </div>
        <div class="sg-key">
          <span class="sg-key-label">cities</span>
          <span class="sg-ramp">${swatches(pal.city)}</span>
          <span class="sg-key-range">1<span aria-hidden="true"> &rarr; </span>${cityMax}</span>
        </div>`;
    }
    renderLegend();

    // -- caption -----------------------------------------------------------
    const caption = mount.querySelector(".sg-caption");
    function renderCaption() {
      if (!caption) return;
      const meta = SPANS.find((s) => s.key === span) || {};
      const totals = (data.span_totals || {})[span] || {};
      const nCountries = Object.values(countryCounts).filter((r) => nOf(r) > 0).length;

      caption.textContent =
        `${meta.label || span}: ${totals.artists || visibleCities.length} artists ` +
        `across ${visibleCities.length} cities and ${nCountries} countries` +
        (meta.note ? ` — ${meta.note}.` : ".") +
        (span === "all"
          ? ""
          : " Spotify caps each top-artist window near 100, so this is a sample of that window, not all of it.") +
        (data.has_play_counts ? "" : " Weighted by artist count, not play count.");

      if (data.is_sample) {
        const warn = document.createElement("strong");
        warn.className = "sg-sample-warning";
        warn.textContent = " Showing generated sample data, not a real library.";
        caption.appendChild(warn);
      }
    }
    renderCaption();

    // -- table view (accessibility + it's genuinely useful) ----------------
    const table = mount.querySelector(".sg-table-body");
    function renderTable() {
      if (!table) return;
      table.innerHTML = visibleCities
        .slice()
        .sort((a, b) => nOf(b) - nOf(a))
        .slice(0, 25)
        .map(
          (c) => `<tr><td>${esc(c.place)}</td><td>${esc(c.country)}</td>
            <td class="sg-num">${nOf(c)}</td>
            <td>${esc(namesOf(c).slice(0, 4).join(", "))}</td></tr>`
        )
        .join("");
    }
    renderTable();

    // -- tuning panel ------------------------------------------------------
    buildTuner(mount, cfg, refresh, globe, loadWorldStates, setSpin);
    status("");
  }

  /**
   * Live controls for the colour scale. Hidden unless ?tune=1 or the toggle is
   * clicked -- this exists so the scale can be dialled in against real numbers
   * and then baked into DEFAULTS, not as a permanent visitor-facing feature.
   */
  function buildTuner(mount, cfg, refresh, globe, loadWorldStates, onAutoRotate) {
    const panel = mount.querySelector(".sg-tuner");
    const toggle = mount.querySelector(".sg-tune-toggle");
    if (!panel || !toggle) return;

    const open = new URLSearchParams(location.search).has("tune");
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute("aria-expanded", String(!panel.hidden));
    });

    const group = (key, title) => `
      <fieldset class="sg-fs">
        <legend>${title}</legend>
        <label>curve
          <select data-k="${key}.curve">
            ${["gamma", "linear", "log", "rank"]
              .map(
                (c) =>
                  `<option value="${c}"${cfg[key].curve === c ? " selected" : ""}>${c}</option>`
              )
              .join("")}
          </select>
        </label>
        <label>gamma <output>${cfg[key].gamma}</output>
          <input type="range" min="0.2" max="1.5" step="0.05"
                 value="${cfg[key].gamma}" data-k="${key}.gamma">
        </label>
        <label>floor <output>${cfg[key].floor}</output>
          <input type="range" min="0" max="0.5" step="0.02"
                 value="${cfg[key].floor}" data-k="${key}.floor">
        </label>
        <label>clip pct <output>${cfg[key].clipPct}</output>
          <input type="range" min="80" max="100" step="1"
                 value="${cfg[key].clipPct}" data-k="${key}.clipPct">
        </label>
      </fieldset>`;

    panel.innerHTML = `
      ${group("regions", "regions")}
      ${group("cities", "cities")}
      <fieldset class="sg-fs">
        <legend>layers</legend>
        ${["countries", "cities"]
          .map(
            (l) => `<label class="sg-check"><input type="checkbox" data-k="show.${l}"
                ${cfg.show[l] ? "checked" : ""}> ${l}</label>`
          )
          .join("")}
        <label class="sg-check"><input type="checkbox" data-k="autoRotate"
          ${cfg.autoRotate ? "checked" : ""}> auto-rotate</label>
        <label>states
          <select data-k="show.states">
            ${STATE_MODES.map(
              (m) =>
                `<option value="${m.value}"${
                  cfg.show.states === m.value ? " selected" : ""
                }>${m.label}</option>`
            ).join("")}
          </select>
        </label>
        <button type="button" class="sg-copy">copy config</button>
      </fieldset>`;

    panel.addEventListener("input", (ev) => {
      const el = ev.target;
      const path = el.dataset.k;
      if (!path) return;
      const val =
        el.type === "checkbox"
          ? el.checked
          : el.type === "range"
            ? parseFloat(el.value)
            : el.value;
      const parts = path.split(".");
      if (parts.length === 1) cfg[parts[0]] = val;
      else cfg[parts[0]][parts[1]] = val;

      const out = el.parentElement.querySelector("output");
      if (out) out.textContent = val;
      if (path === "autoRotate") onAutoRotate(val);

      // "all states" needs geometry that isn't on the page yet
      if (path === "show.states" && val === STATES_ALL) {
        el.disabled = true;
        loadWorldStates().then((ok) => {
          el.disabled = false;
          if (!ok) {
            cfg.show.states = STATES_US; // don't strand the user on an empty layer
            el.value = STATES_US;
          }
          refresh();
        });
        return;
      }
      refresh();
    });

    panel.querySelector(".sg-copy").addEventListener("click", (ev) => {
      const text = JSON.stringify(
        { regions: cfg.regions, cities: cfg.cities, show: cfg.show, autoRotate: cfg.autoRotate },
        null,
        2
      );
      // Written long-hand on purpose: this file is minified at build time by
      // jekyll-minifier -> uglifier, whose bundled uglify-js predates optional
      // chaining and dies with "Unexpected token: punc (.)" on `?.`, failing
      // the whole deploy. Keep this file to ES2017-era syntax.
      if (navigator.clipboard) navigator.clipboard.writeText(text);
      ev.target.textContent = "copied ✓";
      setTimeout(() => (ev.target.textContent = "copy config"), 1600);
    });
  }

  /* -- lazy init: globe.gl bundles three.js, so ~1.9 MB. Don't pay for it
   *    until the section is actually about to be on screen. --------------- */
  function init() {
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;
    if (!("IntersectionObserver" in window)) return boot(mount);

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          boot(mount);
        }
      },
      { rootMargin: "300px" }
    );
    io.observe(mount);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
