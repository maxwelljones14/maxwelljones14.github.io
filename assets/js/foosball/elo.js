// Foosball Elo. Ratings are never stored: they are recomputed by replaying every
// confirmed game in play order, so the only thing that has to be trusted is the
// game list itself (guarded by the Firestore rules). Keep this file ES2017.
(function (root) {
  var START = 1000;
  var K = 32;

  function expected(ra, rb) {
    return 1 / (1 + Math.pow(10, (rb - ra) / 400));
  }

  // games: [{id, playerA, playerB, winner, playedAt (ms)}], confirmed only.
  // Returns ratings and W-L per uid, per-uid history, and the change each game made.
  function replay(games) {
    var ordered = games.slice().sort(function (a, b) {
      if (a.playedAt !== b.playedAt) return a.playedAt - b.playedAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    var ratings = {};
    var records = {};
    var history = {};
    var changes = {};

    function touch(uid) {
      if (!(uid in ratings)) {
        ratings[uid] = START;
        records[uid] = { wins: 0, losses: 0 };
        history[uid] = [];
      }
    }

    ordered.forEach(function (g) {
      var w = g.winner;
      var l = g.winner === g.playerA ? g.playerB : g.playerA;
      touch(w);
      touch(l);
      var rw = ratings[w];
      var rl = ratings[l];
      var delta = K * (1 - expected(rw, rl));
      ratings[w] = rw + delta;
      ratings[l] = rl - delta;
      records[w].wins++;
      records[l].losses++;
      history[w].push({ game: g, opponent: l, won: true, before: rw, after: ratings[w] });
      history[l].push({ game: g, opponent: w, won: false, before: rl, after: ratings[l] });
      changes[g.id] = { winner: w, loser: l, delta: delta, winnerBefore: rw, loserBefore: rl };
    });

    return { ratings: ratings, records: records, history: history, changes: changes };
  }

  // Card stats from one player's history (as returned by replay): peak rating,
  // current win/loss streak, and the opponent who has beaten them most.
  function stats(hist) {
    hist = hist || [];
    var peak = START;
    var vs = {};
    hist.forEach(function (h) {
      if (h.after > peak) peak = h.after;
      var o = vs[h.opponent] || (vs[h.opponent] = { uid: h.opponent, wins: 0, losses: 0, last: 0 });
      if (h.won) o.wins++;
      else o.losses++;
      o.last = h.game.playedAt;
    });

    var streak = null;
    for (var i = hist.length - 1; i >= 0; i--) {
      if (!streak) streak = { won: hist[i].won, count: 0 };
      if (hist[i].won !== streak.won) break;
      streak.count++;
    }

    // Most losses to them; then the more lopsided record; then the most recent.
    var nemesis = null;
    Object.keys(vs).forEach(function (uid) {
      var o = vs[uid];
      if (!o.losses) return;
      if (!nemesis
          || o.losses > nemesis.losses
          || (o.losses === nemesis.losses && o.wins < nemesis.wins)
          || (o.losses === nemesis.losses && o.wins === nemesis.wins && o.last > nemesis.last)) {
        nemesis = o;
      }
    });

    return { peak: peak, streak: streak, nemesis: nemesis };
  }

  var api = { START: START, K: K, expected: expected, replay: replay, stats: stats };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FoosElo = api;
})(this);
