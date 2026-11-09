// Firebase web config for the foosball ladder. These values are not secrets --
// every Firebase web app ships them to the browser; access is controlled by
// tools/foosball/firestore.rules. Paste the config from
// Firebase console -> Project settings -> Your apps -> Web app.
window.FOOS_CONFIG = {
  firebase: {
    apiKey: "REPLACE_ME",
    authDomain: "REPLACE_ME.firebaseapp.com",
    projectId: "REPLACE_ME",
    appId: "REPLACE_ME",
  },
  // Must match isAdmin() in tools/foosball/firestore.rules.
  adminEmail: "mjones2@andrew.cmu.edu",
  emailDomain: "andrew.cmu.edu",
};
