// Firebase web config for the foosball ladder. These values are not secrets --
// every Firebase web app ships them to the browser; access is controlled by
// tools/foosball/firestore.rules. Paste the config from
// Firebase console -> Project settings -> Your apps -> Web app.
window.FOOS_CONFIG = {
  firebase: {
    apiKey: "AIzaSyBDZkAm4aMtKTTKmgMzByXdpwOKnbo0rII",
    authDomain: "foosball-standings.firebaseapp.com",
    projectId: "foosball-standings",
    storageBucket: "foosball-standings.firebasestorage.app",
    messagingSenderId: "258418869616",
    appId: "1:258418869616:web:6a8d00467873ca48fcfbb5",
  },
  // Must match isAdmin() in tools/foosball/firestore.rules.
  adminEmail: "mjones2@andrew.cmu.edu",
};
