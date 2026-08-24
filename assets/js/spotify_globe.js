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
    show: { countries: true, states: true, cities: true },
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
        fetch(`${DATA_DIR}/states.geojson`).then((r) => r.json()),
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
    const stateFeatures = (statesGeo.features || []).map((f) => {
      f.properties.row = stateCounts[f.properties.id];
      f.properties.layer = "state";
      return f;
    });

    // Each layer gets its own scale, rebuilt when the span or the knobs change.
    let scales = {};
    let visibleCities = [];
    function rebuildScales() {
      visibleCities = allCities.filter((c) => nOf(c) > 0);
      scales = {
        country: makeScale(Object.values(countryCounts).map(nOf), cfg.regions),
        state: makeScale(Object.values(stateCounts).map(nOf), cfg.regions),
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
      if (cfg.show.states) out.push(...stateFeatures);
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

    function showDetail(kind, obj) {
      if (!detail) return;
      const spanLabel = (SPANS.find((s) => s.key === span) || {}).label || span;

      if (!obj) {
        detail.innerHTML = `<p class="sg-detail-empty">Hover a country, state or
          city to see every artist from there.</p>`;
        detail.classList.remove("is-pinned");
        return;
      }
      const resolved = kind === "city" ? null : resolveRegion(obj);
      const row = kind === "city" ? obj : resolved.row;
      const list = artistsOf(row);
      if (!list.length) return;

      const title = kind === "city" ? obj.place : resolved.title;
      const where = kind === "city" ? obj.country : resolved.where;
      const subtitle =
        `${list.length} artist${list.length === 1 ? "" : "s"}` +
        (where ? ` · ${where}` : "") +
        ` · ${spanLabel}`;

      detail.innerHTML = detailHTML(title, subtitle, list);
      detail.classList.toggle("is-pinned", !!pinned);
    }

    function hoverHandler(kind) {
      return (obj) => {
        if (pinned) return;
        showDetail(kind, obj || null);
      };
    }
    function clickHandler(kind) {
      return (obj) => {
        const same =
          pinned && pinned.kind === kind && pinned.obj === obj;
        pinned = same || !obj ? null : { kind, obj };
        showDetail(kind, pinned ? pinned.obj : obj || null);
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

    showDetail(null, null); // start with the empty prompt

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
      showDetail(pinned ? pinned.kind : null, pinned ? pinned.obj : null);
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
    buildTuner(mount, cfg, refresh, globe);
    status("");
  }

  /**
   * Live controls for the colour scale. Hidden unless ?tune=1 or the toggle is
   * clicked -- this exists so the scale can be dialled in against real numbers
   * and then baked into DEFAULTS, not as a permanent visitor-facing feature.
   */
  function buildTuner(mount, cfg, refresh, globe) {
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
        ${["countries", "states", "cities"]
          .map(
            (l) => `<label class="sg-check"><input type="checkbox" data-k="show.${l}"
                ${cfg.show[l] ? "checked" : ""}> ${l}</label>`
          )
          .join("")}
        <label class="sg-check"><input type="checkbox" data-k="autoRotate"
          ${cfg.autoRotate ? "checked" : ""}> auto-rotate</label>
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
      if (path === "autoRotate") globe.controls().autoRotate = val;
      refresh();
    });

    panel.querySelector(".sg-copy").addEventListener("click", (ev) => {
      const text = JSON.stringify(
        { regions: cfg.regions, cities: cfg.cities, show: cfg.show, autoRotate: cfg.autoRotate },
        null,
        2
      );
      navigator.clipboard?.writeText(text);
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
