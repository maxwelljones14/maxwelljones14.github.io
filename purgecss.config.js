module.exports = {
  content: ["_site/**/*.html", "_site/**/*.js"],
  css: ["_site/assets/css/*.css"],
  output: "_site/assets/css/",
  skippedContentGlobs: ["_site/assets/**/*.html"],
  safelist: {
    // The hometown globe builds most of its DOM at runtime, so its classes
    // never appear in the generated HTML. Keep the whole sg- namespace, plus
    // the canvas element globe.gl injects.
    standard: ["canvas"],
    deep: [/^sg-/],
    greedy: [/^sg-/],
  },
};
