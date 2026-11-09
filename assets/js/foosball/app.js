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
    elo: FoosElo.replay([]),
    loaded: { players: false, games: false },
  };
  var unsubMine = [];
  var unsubAll = null;

  function isAdmin() {
    return !!state.user && state.user.email === cfg.adminEmail;
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

  function andrewId(uid) {
    var p = state.players[uid];
    return p && p.email ? p.email.split("@")[0] : "";
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

  // Players ranked by rating; ties go to whoever has played more.
  function ranked() {
    return Object.keys(state.players).sort(function (a, b) {
      var d = rating(b) - rating(a);
      if (d) return d;
      var ga = record(a).wins + record(a).losses;
      var gb = record(b).wins + record(b).losses;
      return gb - ga || nameOf(a).localeCompare(nameOf(b));
    });
  }

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
  function fillPlayerSelect(sel, excludeUid) {
    var keep = sel.value;
    var uids = Object.keys(state.players)
      .filter(function (u) { return u !== excludeUid; })
      .sort(function (a, b) { return nameOf(a).localeCompare(nameOf(b)); });
    sel.innerHTML = '<option value="">— pick a player —</option>' + uids.map(function (u) {
      return '<option value="' + esc(u) + '">' + esc(nameOf(u)) + " (" + esc(andrewId(u)) + ")</option>";
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
      el.innerHTML = "<h2>Leaderboard</h2><div class=\"fb-board\"></div>";
    },
    update: function (el) {
      var box = el.querySelector(".fb-board");
      var uids = ranked();
      if (!uids.length) {
        box.innerHTML = "<p>No players yet. Sign in with your Andrew account to be the first.</p>";
        return;
      }
      box.innerHTML = '<table class="fb-table"><thead><tr><th>#</th><th></th><th>Player</th>' +
        '<th class="fb-num">Elo</th><th class="fb-num">W–L</th><th class="fb-num">Games</th></tr></thead><tbody>' +
        uids.map(function (u, i) {
          var r = record(u);
          return "<tr><td>" + (i + 1) + "</td><td>" + avatar(u, 32) + "</td><td>" + playerLink(u) + "</td>" +
            '<td class="fb-num">' + rating(u) + '</td><td class="fb-num">' + r.wins + "–" + r.losses + "</td>" +
            '<td class="fb-num">' + (r.wins + r.losses) + "</td></tr>";
        }).join("") + "</tbody></table>";
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
      '<span class="fb-card-elo">' + rating(uid) + "<small>ELO</small></span></div>" +
      '<div class="fb-card-photo">' + photo + "</div>" +
      (p.nickname ? '<div class="fb-card-nick">&ldquo;' + esc(p.nickname) + "&rdquo;</div>" : "") +
      '<dl class="fb-card-stats">' +
      stat("Rank", "#" + (ranked().indexOf(uid) + 1) + '<span class="fb-muted">/' + Object.keys(state.players).length + "</span>") +
      stat("Record", r.wins + "–" + r.losses) +
      stat("Peak", Math.round(s.peak)) +
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
    el.innerHTML = "<p>Sign in with your Andrew account to " + what + ".</p>";
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

  // Buttons in the game lists, handled once for the whole view.
  view.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-act]");
    if (!btn) return;
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
    var links = [["#/", "Leaderboard"], ["#/games", "Games"]];
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

    authBox.innerHTML = state.user
      ? "Signed in as " + esc(state.user.email) + ' <button type="button" class="fb-signout">Sign out</button>'
      : '<button type="button" class="fb-signin">Sign in with Andrew account</button>';
  }

  authBox.addEventListener("click", function (e) {
    if (e.target.classList.contains("fb-signin")) {
      var provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ hd: cfg.emailDomain, prompt: "select_account" });
      auth.signInWithPopup(provider).catch(fail);
    } else if (e.target.classList.contains("fb-signout")) {
      auth.signOut();
    }
  });

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

  function watchAll() {
    unsubAll = db.collection("games").onSnapshot(function (snap) {
      state.all = snap.docs.map(gameFromDoc);
      recompute();
    }, fail);
  }

  function stopWatching() {
    unsubMine.forEach(function (u) { u(); });
    unsubMine = [];
    if (unsubAll) unsubAll();
    unsubAll = null;
    state.mine = {};
    state.all = [];
  }

  // First sign-in creates the player doc from the Google profile.
  function ensurePlayer(user) {
    var ref = db.collection("players").doc(user.uid);
    return ref.get().then(function (doc) {
      if (doc.exists) return;
      return ref.set({
        email: user.email,
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
    if (user && !(user.email || "").toLowerCase().endsWith("@" + cfg.emailDomain)) {
      auth.signOut();
      showFlash("Please sign in with your @" + cfg.emailDomain + " account.", true);
      user = null;
    }
    state.user = user;
    if (user) {
      ensurePlayer(user).catch(fail);
      watchMine(user.uid);
      if (isAdmin()) watchAll();
    }
    navigate(true);
  });

  window.addEventListener("hashchange", function () { navigate(); });
})();
