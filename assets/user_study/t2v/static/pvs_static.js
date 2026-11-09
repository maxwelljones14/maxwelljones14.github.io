/* Transport of the static (GitHub Pages) study site; loaded after window.PAGE and config.js (window.PVS_STATIC),
   before study.js, which sends every /api/... call and event flush through window.PVS_TRANSPORT.

   * Recorded mode (PVS_STATIC.script_url set AND the URL carries PROLIFIC_PID): calls go to the Google Apps
     Script web app (Code.gs), one POST per call, body JSON as text/plain (no CORS preflight). Event flushes are
     buffered and ride along with the next call (Apps Script allows ~30 concurrent executions, so the 10 s
     heartbeat of the Flask app would be the main load); on page hide they are sent at once with sendBeacon.
   * Preview mode (otherwise): PVSCore runs in this tab over the public ../data/<study>.json (no completion codes,
     no gold answers), the participant ID is a TEST_ one, and nothing is sent anywhere. */
(function () {
  "use strict";
  var P = window.PAGE, C = window.PVS_STATIC || {};
  var q = new URLSearchParams(location.search);
  P.params = { prolific_pid: (q.get("PROLIFIC_PID") || "").trim(), study_id: (q.get("STUDY_ID") || "").trim(),
               session_id: (q.get("SESSION_ID") || "").trim() };
  var remote = !!C.script_url && !!P.params.prolific_pid;
  var resumeKey = "pvs:" + P.study + ":" + P.params.prolific_pid;

  function rid() {
    var a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // /api/<study>/start | /api/session/<token>/<action>  ->  {action, study?, token?}
  function route(path) {
    var m = path.match(/^\/api\/session\/([^/]+)\/([a-z_]+)$/);
    if (m) return { action: m[2], token: decodeURIComponent(m[1]) };
    m = path.match(/^\/api\/([^/]+)\/start$/);
    if (m) return { action: "start", study: decodeURIComponent(m[1]) };
    return { action: "unknown" };
  }

  if (!remote) {
    // ------------------------------------------------------------------------------- preview mode ---
    P.prolific = false;
    P.resume = false;
    P.params = { prolific_pid: (C.test_pid_prefix || "TEST_") + "preview_" + rid().slice(0, 8),
                 study_id: "preview", session_id: "preview" };
    P.finish_html = "<p>You have reached the end of the preview. Nothing was recorded. You can close this tab.</p>";
    var banner = document.createElement("div");
    banner.className = "pvs-preview-banner";
    banner.textContent = "Preview \u2014 answers are not saved.";
    banner.style.cssText = "position:fixed;left:0;bottom:0;z-index:9999;padding:4px 10px;font:12px/1.4 sans-serif;" +
                           "background:#fff3cd;color:#664d03;border-top-right-radius:6px;opacity:.9;pointer-events:none";
    document.addEventListener("DOMContentLoaded", function () { document.body.appendChild(banner); });
    if (document.body) document.body.appendChild(banner);

    var srv = null;
    var load = fetch(C.data_base + P.study + ".json").then(function (r) { return r.json(); }).then(function (cfg) {
      srv = PVSCore.server(cfg, {}, { rnd: Math.random, uid: rid, now: function () { return new Date(); } });
    });
    window.PVS_TRANSPORT = {
      mode: "preview",
      api: function (path, body) {
        return load.then(function () {
          var r = route(path), res;
          if (r.action === "start") res = srv.start(r.study, body, { user_agent: navigator.userAgent });
          else if (r.action === "instructions_done") res = srv.instructionsDone(r.token);
          else if (r.action === "task") res = srv.task(r.token);
          else if (r.action === "submit") res = srv.submit(r.token, JSON.parse(JSON.stringify(body || {})));
          else res = { status: 404, data: { error: "not_found" } };
          return { ok: res.status >= 200 && res.status < 300, status: res.status,
                   data: JSON.parse(JSON.stringify(res.data)) };
        });
      },
      events: function (token, events) { if (srv) srv.events(token, events); }
    };
    return;
  }

  // ---------------------------------------------------------------------------------- recorded mode ---
  P.prolific = true;
  try { P.resume = !!localStorage.getItem(resumeKey); } catch (e) { P.resume = false; }
  var pending = [];  // event batches not sent yet

  async function post(msg) {
    var body = JSON.stringify(msg);
    for (var attempt = 0; ; attempt++) {
      try {
        var r = await fetch(C.script_url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
                                            body: body, redirect: "follow" });
        var res = await r.json();
        if (res && res.status === 503 && res.data && res.data.error === "busy" && attempt < 6) {
          await sleep(1000 + 1500 * attempt);  // backend lock contended: retry the same request
          continue;
        }
        return res;
      } catch (err) {
        if (attempt >= 3) throw err;
        await sleep(1000 * (attempt + 1));
      }
    }
  }

  function takePending() { var e = pending; pending = []; return e; }

  window.PVS_TRANSPORT = {
    mode: "remote",
    api: async function (path, body) {
      var r = route(path);
      var msg = { action: r.action, study: r.study, token: r.token, body: body || {} };
      if (r.action === "start") msg.body = Object.assign({}, msg.body, { user_agent: navigator.userAgent });
      if (r.token) msg.events = takePending();
      var res;
      try { res = await post(msg); }
      catch (err) { if (msg.events) pending = msg.events.concat(pending); throw err; }
      if (r.action === "start" && res.status === 200) {
        try { localStorage.setItem(resumeKey, res.data.token); } catch (e) { /* private mode: no resume */ }
      }
      return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data || {} };
    },
    events: function (token, events, useBeacon) {
      pending = pending.concat(events);
      if (!useBeacon && pending.length < 300) return;  // sent with the next call
      var msg = JSON.stringify({ action: "events", token: token, events: takePending() });
      if (useBeacon && navigator.sendBeacon && navigator.sendBeacon(C.script_url, new Blob([msg], { type: "text/plain" }))) return;
      fetch(C.script_url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: msg,
                            keepalive: true }).catch(function () {});
    }
  };
})();
