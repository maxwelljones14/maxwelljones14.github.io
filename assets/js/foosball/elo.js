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

  var api = { START: START, K: K, expected: expected, replay: replay };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FoosElo = api;
})(this);
