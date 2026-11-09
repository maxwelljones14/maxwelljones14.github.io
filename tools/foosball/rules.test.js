// Security-rules tests. Run via `npm test` (starts the Firestore emulator).
const fs = require("fs");
const path = require("path");
const { initializeTestEnvironment, assertFails, assertSucceeds } = require("@firebase/rules-unit-testing");
const { doc, setDoc, updateDoc, deleteDoc, getDoc, addDoc, collection, serverTimestamp, Timestamp } = require("firebase/firestore");

const ADMIN = "admin";
const tokens = {
  alice: { email: "alice@andrew.cmu.edu", email_verified: true },
  bob: { email: "bob@andrew.cmu.edu", email_verified: true },
  carol: { email: "carol@andrew.cmu.edu", email_verified: true },
  [ADMIN]: { email: "mjones2@andrew.cmu.edu", email_verified: true },
  gmail: { email: "eve@gmail.com", email_verified: true },
};

const profile = (uid) => ({
  email: tokens[uid].email,
  displayName: uid,
  nickname: "",
  photo: "",
  strengths: "",
  weaknesses: "",
  createdAt: serverTimestamp(),
});

const game = (over) =>
  Object.assign(
    {
      playerA: "alice",
      playerB: "bob",
      winner: "alice",
      scoreA: 10,
      scoreB: 7,
      status: "pending",
      reportedBy: "alice",
      playedAt: serverTimestamp(),
      confirmedAt: null,
      byAdmin: false,
    },
    over
  );

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log("ok   " + name);
  } catch (e) {
    failures++;
    console.log("FAIL " + name + "\n     " + e.message);
  }
}

(async () => {
  const env = await initializeTestEnvironment({
    projectId: "demo-foosball",
    firestore: { rules: fs.readFileSync(path.join(__dirname, "firestore.rules"), "utf8") },
  });
  const as = (uid) => env.authenticatedContext(uid, tokens[uid]).firestore();
  const anon = env.unauthenticatedContext().firestore();

  // Players
  await check("non-CMU account can't create a player", () => assertFails(setDoc(doc(as("gmail"), "players/gmail"), profile("gmail"))));
  for (const u of ["alice", "bob", "carol", ADMIN]) {
    await check(u + " creates own player doc", () => assertSucceeds(setDoc(doc(as(u), "players/" + u), profile(u))));
  }
  await check("can't create someone else's player doc", () =>
    assertFails(setDoc(doc(as("alice"), "players/zed"), Object.assign(profile("alice")))));
  await check("anyone can read players", () => assertSucceeds(getDoc(doc(anon, "players/alice"))));
  await check("owner edits profile", () =>
    assertSucceeds(updateDoc(doc(as("alice"), "players/alice"), { nickname: "Ace", strengths: "spinning" })));
  await check("can't edit someone else's profile", () => assertFails(updateDoc(doc(as("bob"), "players/alice"), { nickname: "lol" })));
  await check("can't change own email", () => assertFails(updateDoc(doc(as("alice"), "players/alice"), { email: "x@andrew.cmu.edu" })));
  await check("photo must be a jpeg data URL", () =>
    assertFails(updateDoc(doc(as("alice"), "players/alice"), { photo: "javascript:alert(1)" })));
  await check("jpeg data URL photo ok", () =>
    assertSucceeds(updateDoc(doc(as("alice"), "players/alice"), { photo: "data:image/jpeg;base64,/9j/4AAQ" })));
  await check("admin edits any profile", () => assertSucceeds(updateDoc(doc(as(ADMIN), "players/bob"), { nickname: "B" })));

  // Reporting
  await check("signed-out can't report", () => assertFails(addDoc(collection(anon, "games"), game())));
  await check("can't report a game you weren't in", () =>
    assertFails(addDoc(collection(as("carol"), "games"), game({ reportedBy: "carol" }))));
  await check("can't report an already-confirmed game", () =>
    assertFails(addDoc(collection(as("alice"), "games"), game({ status: "confirmed", confirmedAt: serverTimestamp() }))));
  await check("can't backdate a report", () =>
    assertFails(addDoc(collection(as("alice"), "games"), game({ playedAt: Timestamp.fromMillis(0) }))));
  await check("score must agree with winner", () =>
    assertFails(addDoc(collection(as("alice"), "games"), game({ scoreA: 3, scoreB: 10 }))));
  await check("half a score is rejected", () => assertFails(addDoc(collection(as("alice"), "games"), game({ scoreB: null }))));
  await check("can't play yourself", () => assertFails(addDoc(collection(as("alice"), "games"), game({ playerB: "alice" }))));
  await check("opponent must have an account", () =>
    assertFails(addDoc(collection(as("alice"), "games"), game({ playerB: "ghost", scoreA: null, scoreB: null }))));

  let g1;
  await check("player reports a pending game", async () => {
    g1 = await assertSucceeds(addDoc(collection(as("alice"), "games"), game()));
  });
  const ref = (uid, id) => doc(as(uid), "games/" + id);
  await check("reporter can't confirm own game", () =>
    assertFails(updateDoc(ref("alice", g1.id), { status: "confirmed", confirmedAt: serverTimestamp() })));
  await check("third party can't confirm", () =>
    assertFails(updateDoc(ref("carol", g1.id), { status: "confirmed", confirmedAt: serverTimestamp() })));
  await check("opponent can't change the winner while confirming", () =>
    assertFails(updateDoc(ref("bob", g1.id), { status: "confirmed", confirmedAt: serverTimestamp(), winner: "bob" })));
  await check("opponent confirms", () =>
    assertSucceeds(updateDoc(ref("bob", g1.id), { status: "confirmed", confirmedAt: serverTimestamp() })));
  await check("confirmed game can't be flipped to rejected", () => assertFails(updateDoc(ref("bob", g1.id), { status: "rejected" })));
  await check("reporter can't delete a confirmed game", () => assertFails(deleteDoc(ref("alice", g1.id))));

  let g2;
  await check("second report", async () => {
    g2 = await assertSucceeds(addDoc(collection(as("bob"), "games"), game({ reportedBy: "bob", winner: "bob", scoreA: 2, scoreB: 10 })));
  });
  await check("opponent rejects", () => assertSucceeds(updateDoc(ref("alice", g2.id), { status: "rejected" })));
  await check("reporter dismisses a rejected game", () => assertSucceeds(deleteDoc(ref("bob", g2.id))));

  // Admin
  await check("non-admin can't add a backdated confirmed game", () =>
    assertFails(addDoc(collection(as("carol"), "games"),
      game({ playerA: "carol", reportedBy: "carol", winner: "carol", status: "confirmed", byAdmin: true, playedAt: Timestamp.fromMillis(1e12) }))));
  let g3;
  await check("admin adds a confirmed, backdated game between others", async () => {
    g3 = await assertSucceeds(addDoc(collection(as(ADMIN), "games"),
      game({ playerB: "carol", reportedBy: ADMIN, status: "confirmed", byAdmin: true,
             playedAt: Timestamp.fromMillis(1e12), confirmedAt: serverTimestamp(), scoreA: null, scoreB: null })));
  });
  await check("admin deletes any game", () => assertSucceeds(deleteDoc(ref(ADMIN, g1.id))));
  await check("non-admin can't delete a player", () => assertFails(deleteDoc(doc(as("alice"), "players/bob"))));

  await env.cleanup();
  console.log(failures ? failures + " rules test(s) failed" : "rules tests passed");
  process.exit(failures ? 1 : 0);
})();
