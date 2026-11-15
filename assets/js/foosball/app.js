// Foosball ladder UI: leaderboard, games, profiles, game reporting and admin.
// Depends on the Firebase compat SDK (global `firebase`), config.js and elo.js.
// Keep this file ES2017 -- jekyll-minifier's uglifier rejects newer syntax
// (no ?., ??, object spread or optional catch binding).
(function () {
  "use strict";

  var cfg = window.FOOS_CONFIG;
  var root = document.getElementById("foosball");
  var nav = root.querySelector(".fb-nav");
  var authBox = root.querySelector(".fb-auth");
  var view = root.querySelector(".fb-view");
  var flash = root.querySelector(".fb-flash");

  if (!cfg || cfg.firebase.apiKey === "REPLACE_ME") {
    view.textContent = "The foosball ladder isn't connected to Firebase yet (see tools/foosball/README.md).";
    return;
  }

  firebase.initializeApp(cfg.firebase);
  var auth = firebase.auth();
  var db = firebase.firestore();
  var FieldValue = firebase.firestore.FieldValue;

  // ---- state -------------------------------------------------------------

  var state = {
    user: null, // firebase.User, only if on the allowed domain
    players: {}, // uid -> player doc
    confirmed: [], // confirmed games
    mine: {}, // id -> game, every game I'm in (any status)
    all: [], // every game, admin only
    emails: {}, // uid -> email, admin only
    elo: FoosElo.replay([]),
    loaded: { players: false, games: false },
  };
  var unsubMine = [];
  var unsubAdmin = [];

  function isAdmin() {
    return !!state.user && cfg.adminEmails.indexOf(state.user.email) !== -1;
  }

  // ---- helpers -----------------------------------------------------------

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function toMs(ts) {
    return ts && ts.toMillis ? ts.toMillis() : Date.now();
  }

  function gameFromDoc(doc) {
    var d = doc.data({ serverTimestamps: "estimate" });
    d.id = doc.id;
    d.playedAt = toMs(d.playedAt);
    return d;
  }

  function nameOf(uid) {
    var p = state.players[uid];
    if (!p) return "(deleted player)";
    return p.nickname ? p.displayName + ' "' + p.nickname + '"' : p.displayName;
  }

  function playerLink(uid) {
    return '<a href="#/player/' + esc(uid) + '">' + esc(nameOf(uid)) + "</a>";
  }

  function avatar(uid, size) {
    var p = state.players[uid];
    var src = p && p.photo && p.photo.indexOf("data:image/jpeg;base64,") === 0 ? p.photo : "";
    if (!src) return '<span class="fb-avatar fb-avatar-empty" style="width:' + size + "px;height:" + size + 'px"></span>';
    return '<img class="fb-avatar" src="' + src + '" width="' + size + '" height="' + size + '" alt="">';
  }

  function rating(uid) {
    var r = state.elo.ratings[uid];
    return Math.round(r == null ? FoosElo.START : r);
  }

  function record(uid) {
    return state.elo.records[uid] || { wins: 0, losses: 0 };
  }

  function fmtDate(ms) {
    return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function fmtScore(g) {
    if (g.scoreA == null) return "";
    return g.scoreA + "–" + g.scoreB;
  }

  function fmtDelta(d) {
    var r = Math.round(d);
    return (r >= 0 ? "+" : "") + r;
  }

  // Nobody has a real rating until their first confirmed game.
  function played(uid) {
    var r = record(uid);
    return r.wins + r.losses > 0;
  }

  function eloText(uid) {
    return played(uid) ? String(rating(uid)) : "—";
  }

  // Players ranked by rating, with those who haven't played yet at the bottom.
  function ranked() {
    return Object.keys(state.players).sort(function (a, b) {
      if (played(a) !== played(b)) return played(a) ? -1 : 1;
      var d = rating(b) - rating(a);
      if (d) return d;
      var ga = record(a).wins + record(a).losses;
      var gb = record(b).wins + record(b).losses;
      return gb - ga || nameOf(a).localeCompare(nameOf(b));
    });
  }

  // The leaderboard and graph show only players with MIN_GAMES+ games unless
  // the viewer flips the toggle. Remembered per browser.
  var MIN_GAMES = 5;
  var SHOW_ALL_KEY = "foosShowAll";
  var showAll = false;
  try { showAll = localStorage.getItem(SHOW_ALL_KEY) === "1"; } catch (err) { /* ignore */ }

  function gamesPlayed(uid) {
    var r = record(uid);
    return r.wins + r.losses;
  }

  function shown(uid) {
    return showAll || gamesPlayed(uid) >= MIN_GAMES;
  }

  function filterToggle() {
    return '<div class="fb-filter" role="group" aria-label="Which players to show">' +
      '<button type="button" data-show-all="0">' + MIN_GAMES + "+ games</button>" +
      '<button type="button" data-show-all="1">Everyone</button></div>';
  }

  function syncToggle(el) {
    var buttons = el.querySelectorAll("[data-show-all]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", String((buttons[i].getAttribute("data-show-all") === "1") === showAll));
    }
  }

  function hiddenNote() {
    var n = Object.keys(state.players).filter(function (u) { return !shown(u); }).length;
    return n ? '<p class="fb-muted fb-small">' + n + " player" + (n === 1 ? "" : "s") + " with fewer than " + MIN_GAMES +
      ' games hidden. <button type="button" class="fb-linkbtn" data-show-all="1">Show everyone</button></p>' : "";
  }

  view.addEventListener("click", function (e) {
    var b = e.target.closest("[data-show-all]");
    if (!b) return;
    showAll = b.getAttribute("data-show-all") === "1";
    try { localStorage.setItem(SHOW_ALL_KEY, showAll ? "1" : "0"); } catch (err) { /* ignore */ }
    refresh();
  });

  function showFlash(msg, isError) {
    flash.textContent = msg;
    flash.className = "fb-flash" + (isError ? " fb-error" : "");
    flash.hidden = !msg;
  }

  function fail(err) {
    console.error(err);
    showFlash((err && err.message) || String(err), true);
  }

  // Fill a <select> with players, keeping the current choice across re-renders.
  // Players who share a name get a short id so they can be told apart.
  function fillPlayerSelect(sel, excludeUid) {
    var keep = sel.value;
    var uids = Object.keys(state.players)
      .filter(function (u) { return u !== excludeUid; })
      .sort(function (a, b) { return nameOf(a).localeCompare(nameOf(b)); });
    var seen = {};
    uids.forEach(function (u) { seen[nameOf(u)] = (seen[nameOf(u)] || 0) + 1; });
    sel.innerHTML = '<option value="">— pick a player —</option>' + uids.map(function (u) {
      var tag = seen[nameOf(u)] > 1 ? " #" + u.slice(0, 4) : "";
      return '<option value="' + esc(u) + '">' + esc(nameOf(u) + tag) + "</option>";
    }).join("");
    sel.value = keep;
  }

  // Optional score pair from two inputs: both blank -> nulls, otherwise both required.
  function readScore(inA, inB) {
    var a = inA.value.trim();
    var b = inB.value.trim();
    if (a === "" && b === "") return { a: null, b: null };
    if (a === "" || b === "") throw new Error("Enter both scores, or leave both blank.");
    var na = Number(a);
    var nb = Number(b);
    if (!Number.isInteger(na) || !Number.isInteger(nb) || na < 0 || nb < 0 || na > 99 || nb > 99) {
      throw new Error("Scores must be whole numbers from 0 to 99.");
    }
    return { a: na, b: nb };
  }

  function checkScoreMatchesWinner(score, aWon) {
    if (score.a == null) return;
    if (aWon ? score.a <= score.b : score.b <= score.a) {
      throw new Error("The score doesn't match who won.");
    }
  }

  // Downscale an uploaded image to a square JPEG data URL small enough for a Firestore doc.
  function imageToDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        URL.revokeObjectURL(url);
        var size = 256;
        var side = Math.min(img.width, img.height);
        var canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        canvas.getContext("2d").drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        var q = 0.85;
        var out = canvas.toDataURL("image/jpeg", q);
        while (out.length > 190000 && q > 0.3) {
          q -= 0.15;
          out = canvas.toDataURL("image/jpeg", q);
        }
        resolve(out);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("Couldn't read that image."));
      };
      img.src = url;
    });
  }

  // ---- views ---------------------------------------------------------------
  // Each view has mount(el, arg), called on navigation, and optionally
  // update(el, arg), called when data changes. Forms are built in mount so a
  // live data update never wipes what someone is typing.

  var views = {};

  views.leaderboard = {
    mount: function (el) {
      el.innerHTML = '<div class="fb-head"><h2>Leaderboard</h2>' + filterToggle() + '</div><div class="fb-board"></div>';
    },
    update: function (el) {
      syncToggle(el);
      var box = el.querySelector(".fb-board");
      if (!Object.keys(state.players).length) {
        box.innerHTML = "<p>No players yet. Sign in to be the first.</p>";
        return;
      }
      var uids = ranked().filter(shown);
      if (!uids.length) {
        box.innerHTML = "<p>Nobody has played " + MIN_GAMES + " games yet.</p>" + hiddenNote();
        return;
      }
      box.innerHTML = '<table class="fb-table"><thead><tr><th>#</th><th></th><th>Player</th>' +
        '<th class="fb-num">Elo</th><th class="fb-num">W–L</th><th class="fb-num">Games</th></tr></thead><tbody>' +
        uids.map(function (u, i) {
          var r = record(u);
          return "<tr><td>" + (played(u) ? i + 1 : "—") + "</td><td>" + avatar(u, 32) + "</td><td>" + playerLink(u) + "</td>" +
            '<td class="fb-num">' + eloText(u) + '</td><td class="fb-num">' + r.wins + "–" + r.losses + "</td>" +
            '<td class="fb-num">' + (r.wins + r.losses) + "</td></tr>";
        }).join("") + "</tbody></table>" + hiddenNote();
    },
  };

  function gameRow(g) {
    var c = state.elo.changes[g.id];
    var loser = g.winner === g.playerA ? g.playerB : g.playerA;
    var score = g.winner === g.playerA ? fmtScore(g) : g.scoreA == null ? "" : g.scoreB + "–" + g.scoreA;
    return "<tr><td>" + esc(fmtDate(g.playedAt)) + "</td>" +
      "<td>" + playerLink(g.winner) + (c ? ' <span class="fb-up">' + fmtDelta(c.delta) + "</span>" : "") + "</td>" +
      "<td>" + playerLink(loser) + (c ? ' <span class="fb-down">' + fmtDelta(-c.delta) + "</span>" : "") + "</td>" +
      "<td>" + esc(score) + "</td><td>" + (g.byAdmin ? "admin" : "") + "</td></tr>";
  }

  views.games = {
    mount: function (el) {
      el.innerHTML = "<h2>Recent games</h2><div class=\"fb-games\"></div>";
    },
    update: function (el) {
      var games = state.confirmed.slice().sort(function (a, b) { return b.playedAt - a.playedAt; });
      el.querySelector(".fb-games").innerHTML = games.length
        ? '<table class="fb-table"><thead><tr><th>When</th><th>Winner</th><th>Loser</th><th>Score</th><th></th></tr></thead><tbody>' +
          games.map(gameRow).join("") + "</tbody></table>"
        : "<p>No confirmed games yet.</p>";
    },
  };

  // ---- Elo graph ----------------------------------------------------------
  // x is the game number (every confirmed game, in replay order), so a burst of
  // games played in one sitting doesn't squash into a vertical line.

  var SLOTS = 8; // categorical colours in foosball.css; everyone else is grey

  // Colour follows the player, not their rank: regulars (5+ games) get the
  // colours first in sign-up order, so flipping the toggle never repaints anyone.
  function colorOf() {
    var created = function (u) {
      var c = state.players[u] && state.players[u].createdAt;
      return c && c.toMillis ? c.toMillis() : 0;
    };
    var order = Object.keys(state.players).filter(played).sort(function (a, b) {
      var ra = gamesPlayed(a) >= MIN_GAMES;
      var rb = gamesPlayed(b) >= MIN_GAMES;
      if (ra !== rb) return ra ? -1 : 1;
      return created(a) - created(b) || (a < b ? -1 : 1);
    });
    var colors = {};
    order.forEach(function (u, i) { colors[u] = i < SLOTS ? "var(--fb-s" + (i + 1) + ")" : "var(--fb-s-other)"; });
    return colors;
  }

  function niceStep(range, target) {
    var steps = [5, 10, 20, 25, 50, 100, 200, 250, 500];
    for (var i = 0; i < steps.length; i++) if (range / steps[i] <= target) return steps[i];
    return 1000;
  }

  function shortName(uid) {
    var p = state.players[uid];
    return p ? p.nickname || p.displayName : "(deleted)";
  }

  function drawGraph(el) {
    var box = el.querySelector(".fb-graph");
    var legend = el.querySelector(".fb-legend");
    var games = state.elo.ordered || [];
    var colors = colorOf();
    // series[uid] = [[gameNumber, rating], ...], starting at 1000 just before their first game.
    var series = {};
    games.forEach(function (g, i) {
      var c = state.elo.changes[g.id];
      [[c.winner, c.winnerBefore, c.delta], [c.loser, c.loserBefore, -c.delta]].forEach(function (t) {
        if (!shown(t[0])) return;
        if (!series[t[0]]) series[t[0]] = [[i, t[1]]];
        series[t[0]].push([i + 1, t[1] + t[2]]);
      });
    });
    var uids = Object.keys(series).sort(function (a, b) { return rating(b) - rating(a); });
    if (!uids.length) {
      box.innerHTML = "<p>" + (games.length ? "Nobody has played " + MIN_GAMES + " games yet." : "No confirmed games yet.") + "</p>" + hiddenNote();
      legend.innerHTML = "";
      return;
    }

    var W = Math.max(300, box.clientWidth || 600);
    var H = Math.round(Math.min(420, Math.max(260, W * 0.5)));
    var m = { t: 12, r: uids.length <= 4 ? 90 : 14, b: 44, l: 44 };
    var lo = FoosElo.START, hi = FoosElo.START;
    uids.forEach(function (u) { series[u].forEach(function (pt) { lo = Math.min(lo, pt[1]); hi = Math.max(hi, pt[1]); }); });
    var step = niceStep(hi - lo || 1, 5);
    lo = Math.floor((lo - step * 0.25) / step) * step;
    hi = Math.ceil((hi + step * 0.25) / step) * step;
    var N = games.length;
    var x = function (i) { return m.l + (W - m.l - m.r) * (i / N); };
    var y = function (v) { return m.t + (H - m.t - m.b) * (1 - (v - lo) / (hi - lo)); };

    var svg = '<svg class="fb-chart" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Elo rating of each player after every confirmed game">';
    for (var v = lo; v <= hi; v += step) {
      svg += '<line class="fb-grid' + (v === FoosElo.START ? " fb-grid-start" : "") + '" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>' +
        '<text class="fb-axis" x="' + (m.l - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + "</text>";
    }
    // Date ticks, at most ~6, skipping repeats of the same day.
    var ticks = Math.min(N, Math.max(2, Math.floor((W - m.l - m.r) / 90)));
    var lastLabel = "";
    for (var k = 0; k <= ticks; k++) {
      var gi = Math.round((N - 1) * k / ticks);
      var label = new Date(games[gi].playedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      if (label === lastLabel) continue;
      lastLabel = label;
      svg += '<text class="fb-axis" x="' + x(gi + 1) + '" y="' + (H - m.b + 18) + '" text-anchor="middle">' + esc(label) + "</text>";
    }
    svg += '<text class="fb-axis" x="' + ((m.l + W - m.r) / 2) + '" y="' + (H - 6) + '" text-anchor="middle">Confirmed games, in order</text>';
    // Grey lines underneath, coloured ones on top.
    uids.slice().sort(function (a, b) {
      return (colors[a] === "var(--fb-s-other)" ? 0 : 1) - (colors[b] === "var(--fb-s-other)" ? 0 : 1);
    }).forEach(function (u) {
      var d = series[u].map(function (pt, j) { return (j ? "L" : "M") + x(pt[0]).toFixed(1) + " " + y(pt[1]).toFixed(1); }).join("");
      svg += '<path class="fb-line" data-uid="' + esc(u) + '" d="' + d + '" style="stroke:' + colors[u] + '"/>';
      // Dotted from their last game to the present, so every line ends at the right edge.
      var last = series[u][series[u].length - 1];
      if (last[0] < N) {
        svg += '<path class="fb-line fb-tail" data-uid="' + esc(u) + '" d="M' + x(last[0]).toFixed(1) + " " + y(last[1]).toFixed(1) +
          "H" + x(N).toFixed(1) + '" style="stroke:' + colors[u] + '"/>';
      }
    });
    // Direct labels at the line ends when there are few enough to read.
    if (uids.length <= 4) {
      var ends = uids.map(function (u) { var pts = series[u]; return { u: u, y: y(pts[pts.length - 1][1]) }; })
        .sort(function (a, b) { return a.y - b.y; });
      for (var e = 1; e < ends.length; e++) ends[e].y = Math.max(ends[e].y, ends[e - 1].y + 14);
      ends.forEach(function (o) {
        svg += '<text class="fb-endlabel" x="' + (W - m.r + 6) + '" y="' + (o.y + 4) + '">' + esc(shortName(o.u)) + "</text>";
      });
    }
    svg += '<line class="fb-cross" y1="' + m.t + '" y2="' + (H - m.b) + '" visibility="hidden"/><g class="fb-dots"></g>' +
      '<rect class="fb-hit" x="' + m.l + '" y="0" width="' + (W - m.l - m.r) + '" height="' + H + '"/></svg>';
    box.innerHTML = svg + '<div class="fb-tip" hidden></div>';

    legend.innerHTML = uids.map(function (u) {
      return '<li data-uid="' + esc(u) + '"><span class="fb-swatch" style="background:' + colors[u] + '"></span>' +
        '<a href="#/player/' + esc(u) + '">' + esc(nameOf(u)) + "</a> <span class=\"fb-muted\">" + rating(u) + "</span></li>";
    }).join("") + (hiddenNote() ? "<li>" + hiddenNote() + "</li>" : "");

    var chart = box.querySelector("svg");
    var tip = box.querySelector(".fb-tip");
    var cross = chart.querySelector(".fb-cross");
    var dots = chart.querySelector(".fb-dots");

    function highlight(uid) {
      chart.classList.toggle("fb-focus", !!uid);
      var lines = chart.querySelectorAll(".fb-line");
      for (var i = 0; i < lines.length; i++) lines[i].classList.toggle("fb-hi", lines[i].getAttribute("data-uid") === uid);
    }

    // Rating of uid after game number i (null before their first game).
    function at(uid, i) {
      var pts = series[uid], r = null;
      for (var j = 0; j < pts.length && pts[j][0] <= i; j++) r = pts[j][1];
      return r;
    }

    chart.querySelector(".fb-hit").addEventListener("pointermove", function (ev) {
      var rect = chart.getBoundingClientRect();
      var px = (ev.clientX - rect.left) * (W / rect.width);
      var i = Math.max(1, Math.min(N, Math.round((px - m.l) / (W - m.l - m.r) * N)));
      var g = games[i - 1];
      var c = state.elo.changes[g.id];
      cross.setAttribute("visibility", "visible");
      cross.setAttribute("x1", x(i));
      cross.setAttribute("x2", x(i));
      var rows = uids.map(function (u) { return { u: u, r: at(u, i) }; })
        .filter(function (o) { return o.r != null; })
        .sort(function (a, b) { return b.r - a.r; });
      dots.innerHTML = rows.filter(function (o) { return o.u === c.winner || o.u === c.loser; }).map(function (o) {
        return '<circle class="fb-dot" cx="' + x(i) + '" cy="' + y(o.r) + '" r="4.5" style="fill:' + colors[o.u] + '"/>';
      }).join("");
      var score = g.scoreA == null ? "" : " " + (g.winner === g.playerA ? g.scoreA + "–" + g.scoreB : g.scoreB + "–" + g.scoreA);
      tip.innerHTML = '<div class="fb-muted">Game ' + i + " · " + esc(fmtDate(g.playedAt)) + "</div>" +
        "<div><b>" + esc(shortName(c.winner)) + "</b> beat " + esc(shortName(c.loser)) + esc(score) +
        ' <span class="fb-muted">(±' + Math.round(c.delta) + ")</span></div>" +
        "<table>" + rows.slice(0, 10).map(function (o) {
          var involved = o.u === c.winner || o.u === c.loser;
          return "<tr" + (involved ? ' class="fb-tip-hi"' : "") + '><td><span class="fb-swatch" style="background:' + colors[o.u] + '"></span>' +
            esc(shortName(o.u)) + '</td><td class="fb-num">' + Math.round(o.r) + "</td></tr>";
        }).join("") + "</table>" + (rows.length > 10 ? '<div class="fb-muted">+' + (rows.length - 10) + " more</div>" : "");
      tip.hidden = false;
      var bx = box.getBoundingClientRect();
      var left = ev.clientX - bx.left + 14;
      if (left + tip.offsetWidth > bx.width) left = ev.clientX - bx.left - tip.offsetWidth - 14;
      tip.style.left = Math.max(0, left) + "px";
      tip.style.top = Math.max(0, Math.min(ev.clientY - bx.top - 20, bx.height - tip.offsetHeight)) + "px";
    });
    chart.querySelector(".fb-hit").addEventListener("pointerleave", function () {
      cross.setAttribute("visibility", "hidden");
      dots.innerHTML = "";
      tip.hidden = true;
    });
    legend.onmouseover = function (ev) {
      var li = ev.target.closest("li[data-uid]");
      highlight(li ? li.getAttribute("data-uid") : null);
    };
    legend.onmouseleave = function () { highlight(null); };
  }

  views.graph = {
    mount: function (el) {
      el.innerHTML = '<div class="fb-head"><h2>Elo over time</h2>' + filterToggle() + "</div>" +
        '<div class="fb-graph"></div><ul class="fb-legend"></ul>';
    },
    update: function (el) {
      syncToggle(el);
      drawGraph(el);
    },
  };

  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (current && current.name === "graph") refresh(); }, 150);
  });

  views.player = {
    mount: function (el, uid) {
      el.innerHTML = '<div class="fb-profile"></div><div class="fb-edit"></div><h3>Games</h3><div class="fb-history"></div>';
      var canEdit = state.user && (state.user.uid === uid || isAdmin());
      if (canEdit && state.players[uid]) mountProfileForm(el.querySelector(".fb-edit"), uid);
      tiltCard(el.querySelector(".fb-profile"));
    },
    update: function (el, uid) {
      var p = state.players[uid];
      var box = el.querySelector(".fb-profile");
      if (!p) {
        box.innerHTML = state.loaded.players ? "<p>No such player.</p>" : "<p>Loading…</p>";
        return;
      }
      // The edit form needs the player doc; mount it once the doc shows up.
      var editBox = el.querySelector(".fb-edit");
      if (!editBox.firstChild && state.user && (state.user.uid === uid || isAdmin())) mountProfileForm(editBox, uid);

      box.innerHTML = playerCard(uid);

      var hist = (state.elo.history[uid] || []).slice().reverse();
      el.querySelector(".fb-history").innerHTML = hist.length
        ? '<table class="fb-table"><thead><tr><th>When</th><th>Opponent</th><th>Result</th><th>Score</th><th class="fb-num">Elo</th></tr></thead><tbody>' +
          hist.map(function (h) {
            var g = h.game;
            var mineFirst = g.playerA === uid;
            var score = g.scoreA == null ? "" : mineFirst ? g.scoreA + "–" + g.scoreB : g.scoreB + "–" + g.scoreA;
            return "<tr><td>" + esc(fmtDate(g.playedAt)) + "</td><td>" + playerLink(h.opponent) + "</td>" +
              "<td>" + (h.won ? "W" : "L") + "</td><td>" + esc(score) + "</td>" +
              '<td class="fb-num">' + Math.round(h.after) + ' <span class="' + (h.won ? "fb-up" : "fb-down") + '">(' +
              fmtDelta(h.after - h.before) + ")</span></td></tr>";
          }).join("") + "</tbody></table>"
        : "<p>No confirmed games yet.</p>";
    },
  };

  // The profile as a trading card: photo, rating, record, peak, streak, nemesis.
  function playerCard(uid) {
    var p = state.players[uid];
    var r = record(uid);
    var s = FoosElo.stats(state.elo.history[uid]);
    var photo = p.photo && p.photo.indexOf("data:image/jpeg;base64,") === 0
      ? '<img src="' + p.photo + '" alt="">'
      : '<span class="fb-card-initials">' + esc(p.displayName.split(/\s+/).map(function (w) { return w.charAt(0); }).join("").slice(0, 2).toUpperCase()) + "</span>";
    var streak = s.streak ? (s.streak.won ? "W" : "L") + s.streak.count : "—";
    var nemesis = s.nemesis ? playerLink(s.nemesis.uid) + ' <span class="fb-muted">' + s.nemesis.wins + "–" + s.nemesis.losses + "</span>" : "—";
    function stat(label, value) {
      return "<div><dt>" + label + "</dt><dd>" + value + "</dd></div>";
    }
    function blurb(label, text) {
      return "<h4>" + label + '</h4><p class="fb-pre">' + (esc(text) || "—") + "</p>";
    }
    return '<div class="fb-card"><div class="fb-card-shine"></div><div class="fb-card-glare"></div>' +
      '<div class="fb-card-top"><span class="fb-card-name">' + esc(p.displayName) + "</span>" +
      '<span class="fb-card-elo">' + eloText(uid) + "<small>ELO</small></span></div>" +
      '<div class="fb-card-photo">' + photo + "</div>" +
      (p.nickname ? '<div class="fb-card-nick">&ldquo;' + esc(p.nickname) + "&rdquo;</div>" : "") +
      '<dl class="fb-card-stats">' +
      stat("Rank", played(uid)
        ? "#" + (ranked().indexOf(uid) + 1) + '<span class="fb-muted">/' + Object.keys(state.players).filter(played).length + "</span>"
        : "—") +
      stat("Record", r.wins + "–" + r.losses) +
      stat("Peak", played(uid) ? Math.round(s.peak) : "—") +
      stat("Streak", streak) +
      '<div class="fb-card-nemesis"><dt>Nemesis</dt><dd>' + nemesis + "</dd></div></dl>" +
      '<div class="fb-card-text">' + blurb("Strengths", p.strengths) + blurb("Weaknesses", p.weaknesses) + "</div></div>";
  }

  // Tilt and shine follow the pointer. The variables live on the container, so
  // they survive the card being re-rendered by a live data update.
  function tiltCard(box) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    box.addEventListener("pointermove", function (e) {
      var card = box.querySelector(".fb-card");
      if (!card || e.pointerType === "touch") return;
      var r = card.getBoundingClientRect();
      var x = (e.clientX - r.left) / r.width;
      var y = (e.clientY - r.top) / r.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return box.classList.remove("fb-tilting");
      box.classList.add("fb-tilting");
      box.style.setProperty("--mx", (x * 100).toFixed(1) + "%");
      box.style.setProperty("--my", (y * 100).toFixed(1) + "%");
      box.style.setProperty("--rx", ((0.5 - y) * 16).toFixed(2) + "deg");
      box.style.setProperty("--ry", ((x - 0.5) * 20).toFixed(2) + "deg");
    });
    box.addEventListener("pointerleave", function () { box.classList.remove("fb-tilting"); });
  }

  function mountProfileForm(box, uid) {
    var p = state.players[uid];
    box.innerHTML = '<details><summary>Edit profile</summary><form class="fb-form">' +
      '<label>Name <input name="displayName" maxlength="60" required></label>' +
      '<label>Nickname <input name="nickname" maxlength="40"></label>' +
      '<label>Photo <input name="photo" type="file" accept="image/*"></label>' +
      '<label><input name="removePhoto" type="checkbox"> remove photo</label>' +
      '<label>Strengths <textarea name="strengths" maxlength="1000" rows="3"></textarea></label>' +
      '<label>Weaknesses <textarea name="weaknesses" maxlength="1000" rows="3"></textarea></label>' +
      '<button type="submit">Save</button></form></details>';
    var f = box.querySelector("form");
    f.displayName.value = p.displayName;
    f.nickname.value = p.nickname || "";
    f.strengths.value = p.strengths || "";
    f.weaknesses.value = p.weaknesses || "";
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var file = f.photo.files[0];
      var photo = f.removePhoto.checked ? Promise.resolve("") : file ? imageToDataUrl(file) : Promise.resolve(null);
      photo.then(function (dataUrl) {
        var upd = {
          displayName: f.displayName.value.trim().slice(0, 60),
          nickname: f.nickname.value.trim().slice(0, 40),
          strengths: f.strengths.value.trim().slice(0, 1000),
          weaknesses: f.weaknesses.value.trim().slice(0, 1000),
        };
        if (!upd.displayName) throw new Error("Name can't be empty.");
        if (dataUrl !== null) upd.photo = dataUrl;
        return db.collection("players").doc(uid).update(upd);
      }).then(function () {
        f.photo.value = "";
        f.removePhoto.checked = false;
        showFlash("Profile saved.");
      }).catch(fail);
    });
  }

  function signInPrompt(el, what) {
    el.innerHTML = "<p>Sign in to " + what + ".</p>";
  }

  views.report = {
    mount: function (el) {
      if (!state.user) return signInPrompt(el, "report games");
      el.innerHTML = "<h2>Report a game</h2>" +
        "<p>Your opponent has to confirm it before it counts toward Elo.</p>" +
        '<form class="fb-form">' +
        '<label>Opponent <select name="opponent" required></select></label>' +
        '<fieldset><legend>Result</legend>' +
        '<label><input type="radio" name="result" value="won" required> I won</label> ' +
        '<label><input type="radio" name="result" value="lost"> I lost</label></fieldset>' +
        '<fieldset><legend>Score (optional)</legend>' +
        '<label>Me <input name="myScore" type="number" min="0" max="99"></label> ' +
        '<label>Them <input name="theirScore" type="number" min="0" max="99"></label></fieldset>' +
        '<button type="submit">Report game</button></form>' +
        "<h3>Waiting for you to confirm</h3><div class=\"fb-incoming\"></div>" +
        "<h3>Your reports</h3><div class=\"fb-outgoing\"></div>";
      var f = el.querySelector("form");
      f.addEventListener("submit", function (e) {
        e.preventDefault();
        var me = state.user.uid;
        var opp = f.opponent.value;
        try {
          if (!opp) throw new Error("Pick your opponent.");
          var won = f.result.value === "won";
          var score = readScore(f.myScore, f.theirScore);
          checkScoreMatchesWinner(score, won);
        } catch (err) {
          return fail(err);
        }
        db.collection("games").add({
          playerA: me,
          playerB: opp,
          winner: won ? me : opp,
          scoreA: score.a,
          scoreB: score.b,
          status: "pending",
          reportedBy: me,
          playedAt: FieldValue.serverTimestamp(),
          confirmedAt: null,
          byAdmin: false,
        }).then(function () {
          f.reset();
          showFlash("Reported. Waiting on " + nameOf(opp) + " to confirm.");
        }).catch(fail);
      });
    },
    update: function (el) {
      if (!state.user) return;
      var me = state.user.uid;
      fillPlayerSelect(el.querySelector("select[name=opponent]"), me);
      var mine = Object.keys(state.mine).map(function (k) { return state.mine[k]; })
        .filter(function (g) { return g.status !== "confirmed"; })
        .sort(function (a, b) { return b.playedAt - a.playedAt; });

      function describe(g) {
        var opp = g.playerA === me ? g.playerB : g.playerA;
        var score = g.scoreA == null ? "" : " " + (g.playerA === me ? g.scoreA + "–" + g.scoreB : g.scoreB + "–" + g.scoreA);
        return (g.winner === me ? "You beat " : "You lost to ") + playerLink(opp) + esc(score) +
          ' <span class="fb-muted">(' + esc(fmtDate(g.playedAt)) + ")</span>";
      }

      var incoming = mine.filter(function (g) { return g.status === "pending" && g.reportedBy !== me; });
      el.querySelector(".fb-incoming").innerHTML = incoming.length ? "<ul>" + incoming.map(function (g) {
        return "<li>" + describe(g) + ' <button data-act="confirm" data-id="' + esc(g.id) + '">Confirm</button>' +
          ' <button data-act="reject" data-id="' + esc(g.id) + '">Reject</button></li>';
      }).join("") + "</ul>" : "<p>Nothing to confirm.</p>";

      var outgoing = mine.filter(function (g) { return g.reportedBy === me; });
      el.querySelector(".fb-outgoing").innerHTML = outgoing.length ? "<ul>" + outgoing.map(function (g) {
        return "<li>" + describe(g) + " — " + esc(g.status) +
          ' <button data-act="withdraw" data-id="' + esc(g.id) + '">' + (g.status === "pending" ? "Cancel" : "Dismiss") + "</button></li>";
      }).join("") + "</ul>" : "<p>No unconfirmed reports.</p>";
    },
  };

  views.admin = {
    mount: function (el) {
      if (!isAdmin()) {
        el.innerHTML = "<p>Admins only.</p>";
        return;
      }
      el.innerHTML = "<h2>Admin: add a game</h2>" +
        "<p>Games added here count immediately.</p>" +
        '<form class="fb-form">' +
        '<label>Player A <select name="a" required></select></label>' +
        '<label>Player B <select name="b" required></select></label>' +
        '<fieldset><legend>Winner</legend>' +
        '<label><input type="radio" name="winner" value="a" required> A</label> ' +
        '<label><input type="radio" name="winner" value="b"> B</label></fieldset>' +
        '<fieldset><legend>Score (optional)</legend>' +
        '<label>A <input name="scoreA" type="number" min="0" max="99"></label> ' +
        '<label>B <input name="scoreB" type="number" min="0" max="99"></label></fieldset>' +
        '<label>Played at <input name="when" type="datetime-local"></label>' +
        '<button type="submit">Add game</button></form>' +
        "<h2>Players</h2><p>Deleting a player also deletes all their games.</p><div class=\"fb-admin-players\"></div>" +
        "<h2>All games</h2><div class=\"fb-all\"></div>";
      var f = el.querySelector("form");
      f.addEventListener("submit", function (e) {
        e.preventDefault();
        try {
          var a = f.a.value;
          var b = f.b.value;
          if (!a || !b) throw new Error("Pick both players.");
          if (a === b) throw new Error("A player can't play themselves.");
          var aWon = f.winner.value === "a";
          var score = readScore(f.scoreA, f.scoreB);
          checkScoreMatchesWinner(score, aWon);
          var when = f.when.value ? new Date(f.when.value) : new Date();
          if (isNaN(when.getTime())) throw new Error("Bad date.");
        } catch (err) {
          return fail(err);
        }
        db.collection("games").add({
          playerA: a,
          playerB: b,
          winner: aWon ? a : b,
          scoreA: score.a,
          scoreB: score.b,
          status: "confirmed",
          reportedBy: state.user.uid,
          playedAt: firebase.firestore.Timestamp.fromDate(when),
          confirmedAt: FieldValue.serverTimestamp(),
          byAdmin: true,
        }).then(function () {
          f.reset();
          showFlash("Game added.");
        }).catch(fail);
      });
    },
    update: function (el) {
      if (!isAdmin()) return;
      fillPlayerSelect(el.querySelector("select[name=a]"));
      fillPlayerSelect(el.querySelector("select[name=b]"));
      var uids = Object.keys(state.players).sort(function (a, b) { return nameOf(a).localeCompare(nameOf(b)); });
      el.querySelector(".fb-admin-players").innerHTML = uids.length
        ? '<table class="fb-table"><thead><tr><th></th><th>Player</th><th>Email</th><th class="fb-num">Games</th><th></th></tr></thead><tbody>' +
          uids.map(function (u) {
            return "<tr><td>" + avatar(u, 28) + "</td><td>" + playerLink(u) + "</td><td>" + esc(state.emails[u] || "") +
              '</td><td class="fb-num">' + gamesOf(u).length + "</td>" +
              '<td><button data-act="delete-player" data-id="' + esc(u) + '">Delete</button></td></tr>';
          }).join("") + "</tbody></table>"
        : "<p>No players yet.</p>";
      var games = state.all.slice().sort(function (a, b) { return b.playedAt - a.playedAt; });
      el.querySelector(".fb-all").innerHTML = games.length
        ? '<table class="fb-table"><thead><tr><th>When</th><th>A</th><th>B</th><th>Winner</th><th>Score</th><th>Status</th><th></th></tr></thead><tbody>' +
          games.map(function (g) {
            return "<tr><td>" + esc(fmtDate(g.playedAt)) + "</td><td>" + playerLink(g.playerA) + "</td><td>" + playerLink(g.playerB) +
              "</td><td>" + esc(nameOf(g.winner)) + "</td><td>" + esc(fmtScore(g)) + "</td><td>" + esc(g.status) + "</td><td>" +
              (g.status === "pending" ? '<button data-act="force" data-id="' + esc(g.id) + '">Confirm</button> ' : "") +
              '<button data-act="delete" data-id="' + esc(g.id) + '">Delete</button></td></tr>';
          }).join("") + "</tbody></table>"
        : "<p>No games yet.</p>";
    },
  };

  // Every game a player is in, whatever its status (admin only: needs state.all).
  function gamesOf(uid) {
    return state.all.filter(function (g) { return g.playerA === uid || g.playerB === uid; });
  }

  // A player's games go with them, so nothing they were in keeps counting.
  function deletePlayer(uid) {
    var games = gamesOf(uid);
    if (!window.confirm("Delete " + nameOf(uid) + " and their " + games.length + " game(s)? Everyone's Elo will be recomputed.")) {
      return null;
    }
    var batch = db.batch();
    games.forEach(function (g) { batch.delete(db.collection("games").doc(g.id)); });
    batch.delete(db.collection("players").doc(uid));
    batch.delete(db.collection("emails").doc(uid));
    return batch.commit().then(function () { showFlash("Player deleted."); });
  }

  // Buttons in the game and player lists, handled once for the whole view.
  view.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-act]");
    if (!btn) return;
    if (btn.getAttribute("data-act") === "delete-player") {
      var del = deletePlayer(btn.getAttribute("data-id"));
      if (del) {
        btn.disabled = true;
        del.catch(fail);
      }
      return;
    }
    var ref = db.collection("games").doc(btn.getAttribute("data-id"));
    var act = btn.getAttribute("data-act");
    var p;
    if (act === "confirm" || act === "force") {
      p = ref.update({ status: "confirmed", confirmedAt: FieldValue.serverTimestamp() });
    } else if (act === "reject") {
      if (!window.confirm("Reject this game? It won't count.")) return;
      p = ref.update({ status: "rejected" });
    } else if (act === "withdraw") {
      p = ref.delete();
    } else if (act === "delete") {
      if (!window.confirm("Delete this game for good? Everyone's Elo will be recomputed.")) return;
      p = ref.delete();
    }
    btn.disabled = true;
    p.then(function () { showFlash(""); }).catch(fail);
  });

  // ---- routing -------------------------------------------------------------

  var current = null;

  function parseRoute() {
    var parts = location.hash.replace(/^#\/?/, "").split("/");
    var name = parts[0] || "leaderboard";
    if (name === "me") return state.user ? { name: "player", arg: state.user.uid } : { name: "leaderboard" };
    if (!views[name]) name = "leaderboard";
    return { name: name, arg: parts[1] ? decodeURIComponent(parts[1]) : null };
  }

  // keepFlash: leave the current message up (auth changes re-render without a click).
  function navigate(keepFlash) {
    current = parseRoute();
    if (keepFlash !== true) showFlash("");
    view.innerHTML = "";
    views[current.name].mount(view, current.arg);
    renderNav();
    refresh();
  }

  function refresh() {
    if (current && views[current.name].update) views[current.name].update(view, current.arg);
  }

  function renderNav() {
    var links = [["#/", "Leaderboard"], ["#/graph", "Elo graph"], ["#/games", "Games"]];
    if (state.user) {
      var waiting = Object.keys(state.mine).filter(function (k) {
        var g = state.mine[k];
        return g.status === "pending" && g.reportedBy !== state.user.uid;
      }).length;
      links.push(["#/report", "Report a game" + (waiting ? " (" + waiting + " to confirm)" : "")]);
      links.push(["#/me", "My profile"]);
    }
    if (isAdmin()) links.push(["#/admin", "Admin"]);
    nav.innerHTML = links.map(function (l) { return '<a href="' + l[0] + '">' + esc(l[1]) + "</a>"; }).join(" · ");

    // Only redrawn when sign-in state changes, so live updates don't wipe a half-typed email.
    var me = state.user && state.players[state.user.uid];
    var who = state.user ? state.user.uid + ":" + (me && me.photo ? me.photo.length : 0) : "";
    if (authBox.getAttribute("data-who") === who && authBox.firstChild) return;
    authBox.setAttribute("data-who", who);
    authBox.innerHTML = state.user
      ? '<span class="fb-who">' + avatar(state.user.uid, 26) + '<span class="fb-who-email">' + esc(state.user.email) + "</span></span>" +
        '<button type="button" class="fb-btn fb-btn-ghost fb-signout">Sign out</button>'
      : '<button type="button" class="fb-btn fb-btn-google fb-signin">' + GOOGLE_G + "Sign in with Google</button>" +
        '<span class="fb-or">or</span>' +
        '<form class="fb-linkform"><input type="email" name="email" required placeholder="you@example.com" aria-label="Email address">' +
        '<button type="submit" class="fb-btn fb-btn-primary">Email me a link</button></form>';
  }

  var LINK_EMAIL_KEY = "foosLinkEmail";
  var GOOGLE_G = '<svg class="fb-g" viewBox="0 0 48 48" aria-hidden="true">' +
    '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
    '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
    '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
    '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

  authBox.addEventListener("click", function (e) {
    if (e.target.classList.contains("fb-signin")) {
      var provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      auth.signInWithPopup(provider).catch(fail);
    } else if (e.target.classList.contains("fb-signout")) {
      auth.signOut();
    }
  });

  authBox.addEventListener("submit", function (e) {
    e.preventDefault();
    var email = e.target.email.value.trim();
    auth.sendSignInLinkToEmail(email, { url: location.origin + location.pathname, handleCodeInApp: true }).then(function () {
      try { localStorage.setItem(LINK_EMAIL_KEY, email); } catch (err) { /* private mode: we'll ask again */ }
      e.target.reset();
      showFlash("Sign-in link sent to " + email + ". Open it on this device to finish signing in.");
    }).catch(fail);
  });

  // Landing here from an emailed sign-in link.
  if (auth.isSignInWithEmailLink(location.href)) {
    var linkEmail = null;
    try { linkEmail = localStorage.getItem(LINK_EMAIL_KEY); } catch (err) { /* ignore */ }
    if (!linkEmail) linkEmail = window.prompt("Confirm the email address you signed in with:");
    if (linkEmail) {
      auth.signInWithEmailLink(linkEmail, location.href).then(function () {
        try { localStorage.removeItem(LINK_EMAIL_KEY); } catch (err) { /* ignore */ }
        history.replaceState(null, "", location.pathname + location.hash);
      }).catch(fail);
    }
  }

  // ---- data ----------------------------------------------------------------

  function recompute() {
    state.elo = FoosElo.replay(state.confirmed);
    renderNav();
    refresh();
    // Faces for the table at the top of the page (table.js), best-ranked first.
    document.dispatchEvent(new CustomEvent("foos:players", {
      detail: ranked().map(function (uid) {
        var photo = state.players[uid].photo;
        return { uid: uid, photo: photo && photo.indexOf("data:image/jpeg;base64,") === 0 ? photo : "" };
      }),
    }));
  }

  db.collection("players").onSnapshot(function (snap) {
    var players = {};
    snap.forEach(function (doc) { players[doc.id] = doc.data(); });
    state.players = players;
    state.loaded.players = true;
    recompute();
  }, fail);

  db.collection("games").where("status", "==", "confirmed").onSnapshot(function (snap) {
    state.confirmed = snap.docs.map(gameFromDoc);
    state.loaded.games = true;
    recompute();
  }, fail);

  function watchMine(uid) {
    var parts = { A: {}, B: {} };
    function listen(field, key) {
      return db.collection("games").where(field, "==", uid).onSnapshot(function (snap) {
        parts[key] = {};
        snap.forEach(function (doc) { parts[key][doc.id] = gameFromDoc(doc); });
        state.mine = Object.assign({}, parts.A, parts.B);
        recompute();
      }, fail);
    }
    unsubMine = [listen("playerA", "A"), listen("playerB", "B")];
  }

  function watchAdmin() {
    unsubAdmin = [
      db.collection("games").onSnapshot(function (snap) {
        state.all = snap.docs.map(gameFromDoc);
        recompute();
      }, fail),
      db.collection("emails").onSnapshot(function (snap) {
        var emails = {};
        snap.forEach(function (doc) { emails[doc.id] = doc.data().email; });
        state.emails = emails;
        recompute();
      }, fail),
    ];
  }

  function stopWatching() {
    unsubMine.concat(unsubAdmin).forEach(function (u) { u(); });
    unsubMine = [];
    unsubAdmin = [];
    state.mine = {};
    state.all = [];
    state.emails = {};
  }

  // First sign-in creates the public player doc. The email goes in a separate
  // doc that only the player and the admin can read.
  function ensurePlayer(user) {
    var ref = db.collection("players").doc(user.uid);
    db.collection("emails").doc(user.uid).set({ email: user.email }).catch(fail);
    return ref.get().then(function (doc) {
      if (doc.exists) return;
      return ref.set({
        displayName: (user.displayName || user.email.split("@")[0]).slice(0, 60),
        nickname: "",
        photo: "",
        strengths: "",
        weaknesses: "",
        createdAt: FieldValue.serverTimestamp(),
      });
    });
  }

  auth.onAuthStateChanged(function (user) {
    stopWatching();
    state.user = user;
    if (user) {
      ensurePlayer(user).catch(fail);
      watchMine(user.uid);
      if (isAdmin()) watchAdmin();
    }
    navigate(true);
  });

  window.addEventListener("hashchange", function () { navigate(); });
})();
