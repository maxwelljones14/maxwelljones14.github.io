# Foosball ladder

The `/foosball/` page (`_pages/foosball.md`) is a static page backed by Firebase (free Spark plan):

- **Auth**: anyone with a verified email: Google sign-in, or a sign-in link emailed to any address.
- **Firestore**: `players/{uid}` (public profile; photo stored as a small JPEG data URL), `emails/{uid}` (readable only by that player and the admin) and `games/{id}`.
- **Elo** is never stored. `assets/js/foosball/elo.js` replays every confirmed game in `playedAt` order (start 1000, K=32). Deleting or fixing a game automatically recomputes everyone's rating.

A player's report creates a `pending` game. It only counts once the *other* player confirms it. The admin (`mjones2@andrew.cmu.edu`, set in both `firestore.rules` and `config.js`) can add games that are already confirmed, with any date, confirm or delete any game, and delete players (which deletes their games too). `firestore.rules` enforces all of this. The UI checks are only a convenience.

## One-time setup

1. Go to <https://console.firebase.google.com> → **Add project**. Google Analytics isn't needed.
2. **Build → Authentication → Get started → Sign-in method**, then enable two providers:
   - **Google**.
   - **Email/Password**, with the **Email link (passwordless sign-in)** toggle switched on.

   Under **Settings → Authorized domains**, add `maxwelljon.es` (`localhost` is there already).
3. **Build → Firestore Database → Create database**: production mode, any region (e.g. `nam5`).
4. **Project settings → Your apps → Web (`</>`)** → register an app, then copy the
   `apiKey`, `authDomain`, `projectId`, and `appId` into `assets/js/foosball/config.js`.
5. Publish the security rules, either way:
   - Paste `firestore.rules` into **Firestore → Rules → Publish**, or
   - `cd tools/foosball && npx firebase-tools deploy --only firestore:rules --project <projectId>`

No indexes are needed: every query is a single equality filter.

## Tests

```sh
node tools/foosball/elo.test.js                     # Elo replay
cd tools/foosball && npm install && npm test        # security rules, against the Firestore emulator (Node 18+, Java 21+)
```

## Limits

- Every page view reads all players and all confirmed games, which is fine at club scale. If it ever gets close to the free quota (50k reads/day), cache a snapshot doc.
- The score is recorded but doesn't affect Elo.
- Deleting a player doesn't ban them: they can sign in again and get a fresh profile.
