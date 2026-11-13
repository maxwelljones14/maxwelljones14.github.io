/* Transport of the static (GitHub Pages) study site; loaded after window.PAGE and config.js (window.PVS_STATIC),
   before study.js, which sends every /api/... call and event flush through window.PVS_TRANSPORT.

   * Recorded mode (PVS_STATIC.script_url set AND the URL carries PROLIFIC_PID): calls go to the Google Apps
     Script web app (Code.gs), one POST per call, body JSON as text/plain (no CORS preflight). Event flushes are
     buffered and ride along with the next call (Apps Script allows ~30 concurrent executions, so the 10 s
     heartbeat of the Flask app would be the main load); a tab switch keeps them buffered (the next submit needs
     the `ended` events), and only page unload sends them at once with sendBeacon. Every call is retried while
     the backend is busy, errors or hangs (see post()).
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

  // A busy lock (503 "busy"), an Apps Script error page (not JSON), a network error or a request that hangs
  // (aborted after request_timeout_ms) are all retried with the same body until retry_budget_ms has passed;
  // onRetry(attempt, reason) lets the page say so. A retried submit that did land answers not_current_task,
  // which study.js handles by loading the current task.
  var TIMEOUT_MS = C.request_timeout_ms || 45000, BUDGET_MS = C.retry_budget_ms || 600000;

  async function post(msg, onRetry) {
    var body = JSON.stringify(msg), t0 = Date.now(), last = null;
    for (var attempt = 0; ; attempt++) {
      var ctl = window.AbortController ? new AbortController() : null;
      var timer = ctl ? setTimeout(function () { ctl.abort(); }, TIMEOUT_MS) : null;
      try {
        var r = await fetch(C.script_url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
                                            body: body, redirect: "follow", signal: ctl ? ctl.signal : undefined });
        var res = await r.json();
        if (!(res && res.status === 503 && res.data && res.data.error === "busy")) return res;
        last = res;
      } catch (err) {
        last = err;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (Date.now() - t0 >= BUDGET_MS) {
        if (last instanceof Error) throw last;
        return last;
      }
      if (onRetry) { try { onRetry(attempt + 1, last instanceof Error ? "network" : "busy"); } catch (e) { /* UI only */ } }
      await sleep(Math.min(1000 + 1500 * attempt, 8000));
    }
  }

  function takePending() { var e = pending; pending = []; return e; }

  window.PVS_TRANSPORT = {
    mode: "remote",
    api: async function (path, body, method, opts) {
      var r = route(path);
      var msg = { action: r.action, study: r.study, token: r.token, body: body || {} };
      if (r.action === "start") msg.body = Object.assign({}, msg.body, { user_agent: navigator.userAgent });
      if (r.token) msg.events = takePending();
      var res;
      try { res = await post(msg, opts && opts.onRetry); }
      catch (err) { if (msg.events) pending = msg.events.concat(pending); throw err; }
      if (r.action === "start" && res.status === 200) {
        try { localStorage.setItem(resumeKey, res.data.token); } catch (e) { /* private mode: no resume */ }
      }
      return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data || {} };
    },
    // why: "hidden" (tab switch) keeps the batch for the next call, so a busy backend cannot drop the `ended`
    // events that the next submit needs; "unload" (pagehide) or the end screen sends at once with sendBeacon.
    events: function (token, events, useBeacon, why) {
      pending = pending.concat(events);
      if (why === "hidden" || (!useBeacon && pending.length < 300)) return;  // sent with the next call
      var batch = takePending(), msg = JSON.stringify({ action: "events", token: token, events: batch });
      if (useBeacon && navigator.sendBeacon && navigator.sendBeacon(C.script_url, new Blob([msg], { type: "text/plain" }))) return;
      fetch(C.script_url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: msg,
                            keepalive: true })
        .then(function (r) { return r.json(); })
        .then(function (res) { if (!res || res.status !== 200) throw new Error("events not stored"); })
        .catch(function () { pending = batch.concat(pending); });
    }
  };
})();
