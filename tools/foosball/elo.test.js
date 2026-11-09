// Run with: node tools/foosball/elo.test.js
const assert = require("assert");
const Elo = require("../../assets/js/foosball/elo.js");

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

// Equal ratings: winner gains exactly K/2.
let r = Elo.replay([{ id: "g1", playerA: "a", playerB: "b", winner: "a", playedAt: 1 }]);
close(r.ratings.a, 1016, "equal-rating win");
close(r.ratings.b, 984, "equal-rating loss");
assert.deepStrictEqual(r.records.a, { wins: 1, losses: 0 });
assert.deepStrictEqual(r.records.b, { wins: 0, losses: 1 });
close(r.changes.g1.delta, 16, "change recorded");

// Zero-sum, and replay order follows playedAt rather than array order.
const games = [
  { id: "g2", playerA: "a", playerB: "c", winner: "c", playedAt: 20 },
  { id: "g1", playerA: "a", playerB: "b", winner: "a", playedAt: 10 },
  { id: "g3", playerA: "b", playerB: "c", winner: "b", playedAt: 30 },
];
r = Elo.replay(games);
const total = Object.values(r.ratings).reduce((s, x) => s + x, 0);
close(total, 3000, "ratings are zero-sum");
assert.strictEqual(r.history.a[0].game.id, "g1", "sorted by playedAt");
const r2 = Elo.replay(games.slice().reverse());
assert.deepStrictEqual(r2.ratings, r.ratings, "input order does not matter");

// Ties on playedAt break by id, deterministically.
const tie = [
  { id: "y", playerA: "a", playerB: "b", winner: "b", playedAt: 5 },
  { id: "x", playerA: "a", playerB: "b", winner: "a", playedAt: 5 },
];
assert.strictEqual(Elo.replay(tie).history.a[0].game.id, "x");

// An upset moves more than an expected win.
close(Elo.expected(1200, 1000) + Elo.expected(1000, 1200), 1, "expectations sum to 1");
assert.ok(32 * (1 - Elo.expected(1000, 1200)) > 16);

// Card stats: peak, streak, nemesis.
let s = Elo.stats([]);
assert.deepStrictEqual(s, { peak: 1000, streak: null, nemesis: null }, "no games");
r = Elo.replay([
  { id: "1", playerA: "a", playerB: "b", winner: "a", playedAt: 1 },
  { id: "2", playerA: "a", playerB: "b", winner: "a", playedAt: 2 },
  { id: "3", playerA: "a", playerB: "c", winner: "c", playedAt: 3 },
  { id: "4", playerA: "a", playerB: "b", winner: "b", playedAt: 4 },
  { id: "5", playerA: "a", playerB: "c", winner: "c", playedAt: 5 },
  { id: "6", playerA: "a", playerB: "d", winner: "d", playedAt: 6 },
]);
s = Elo.stats(r.history.a);
close(s.peak, r.history.a[1].after, "peak is the high point, not the current rating");
assert.deepStrictEqual(s.streak, { won: false, count: 4 }, "four losses in a row");
assert.strictEqual(s.nemesis.uid, "c", "c beat a twice and lost never");
assert.deepStrictEqual([s.nemesis.wins, s.nemesis.losses], [0, 2]);
s = Elo.stats(r.history.b);
assert.deepStrictEqual(s.streak, { won: true, count: 1 });
assert.strictEqual(s.nemesis.uid, "a");
close(Elo.stats(r.history.d).peak, r.ratings.d, "winner's peak is current");

console.log("elo tests passed");
