/* Server logic of the Prolific video studies for the static (GitHub Pages) deployment: a line-by-line JS port of
   app.py's participant API (/api/<study>/start, /api/session/<token>/{instructions_done,task,submit,events}) and
   of assignment.py. The same file runs in two places:
     * Google Apps Script (static_site/Code.gs keeps `db` in a Google Sheet): the real, recorded study;
     * the browser (static_site/pvs_static.js keeps `db` in memory): the no-backend preview, nothing recorded.

   cfg  = the study data written by scripts/export_static_site.py (items, batch sizes, codes, labels).
   db   = {participants, sessions, assignments, attention_checks, responses, events: [row objects]}.
          Rows use the SQLite column names of db.py, JSON columns hold JSON strings (as in SQLite), so the importer
          (scripts/import_apps_script.py) copies them unchanged. A modified/new row gets `_dirty = true`.
   opts = {rnd: () => [0, 1), uid: () => opaque session token, now: () => Date}.
   Every API method returns {status: <HTTP status Flask would send>, data: <its JSON body>}. */
var PVSCore = (function () {
  "use strict";

  var EVENT_TYPES = ["play", "pause", "ended", "seeked", "replay", "loop", "waiting", "error", "loaded", "answer",
                     "instructions_open", "instructions_close", "visibility", "resize", "fit"];

  function ts(d) { return d.toISOString().replace("Z", "000Z"); }  // db.TS_FMT (%Y-%m-%dT%H:%M:%S.%fZ)
  function parseTs(s) { return new Date(String(s).replace(/(\.\d{3})\d*Z$/, "$1Z")); }
  function pyRound(x) {  // Python 3 round(): ties to even
    var f = Math.floor(x);
    if (Math.abs(x - f - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
    return Math.round(x);
  }
  function shuffle(a, rnd) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function num(v) { var x = Number(v); return v === null || v === undefined || v === "" || isNaN(x) ? null : x; }
  function int(v) { var x = num(v); return x === null ? null : Math.trunc(x); }
  function upd(row, fields) { Object.assign(row, fields); row._dirty = true; return row; }
  function reply(status, data) { return { status: status, data: data }; }

  // ------------------------------------------------------------------------------------- assignment.py ---
  function attentionSlots(nReal, nChecks, fractions) {
    var total = nReal + nChecks, lo = 0, hi = total - 1, slots = [];
    if (total >= 4) { lo = 1; hi = total - 2; }
    fractions.slice(0, nChecks).forEach(function (frac) {
      var p = Math.min(Math.max(pyRound(frac * (total - 1)), lo), hi);
      while (slots.indexOf(p) >= 0) p += 1;
      slots.push(Math.min(p, total - 1));
    });
    return slots.sort(function (a, b) { return a - b; });
  }

  function displayOrder(checklist, rnd, shuffleRest) {
    var pinned = checklist.filter(function (c) { return c.primary; }).map(function (c) { return c.id; });
    var rest = checklist.filter(function (c) { return !c.primary; }).map(function (c) { return c.id; });
    if (shuffleRest) shuffle(rest, rnd);
    return pinned.concat(rest);
  }

  function sideOrder(roles, rnd) {
    var pair = roles.filter(function (r) { return r === "video_a" || r === "video_b"; }).sort();
    return shuffle(pair.length ? pair : roles.slice().sort(), rnd);
  }

  function server(cfg, db, opts) {
    var rnd = opts.rnd, now = opts.now;
    var items = {};  // study -> item_id -> item
    Object.keys(cfg.studies).forEach(function (k) {
      items[k] = {};
      cfg.studies[k].items.forEach(function (it) { items[k][it.item_id] = it; });
    });
    var pidRe = new RegExp(cfg.pid_regex);
    ["participants", "sessions", "assignments", "attention_checks", "responses", "events"].forEach(function (t) {
      db[t] = db[t] || [];
    });
    var nextAid = db.assignments.reduce(function (m, a) { return Math.max(m, Number(a.assignment_id)); }, 0) + 1;

    function isTest(pid) { return !!cfg.test_pid_prefix && pid.indexOf(cfg.test_pid_prefix) === 0; }
    function sessionOf(token) {
      for (var i = 0; i < db.sessions.length; i++) if (db.sessions[i].session_uid === token) return db.sessions[i];
      return null;
    }
    function assignmentsOf(token) {
      return db.assignments.filter(function (a) { return a.session_uid === token; })
        .sort(function (a, b) { return a.position - b.position; });
    }
    function notOpen(study, pid) {  // placeholder items: only TEST_ previews may start the study
      return !!cfg.refuse_placeholder_items && !!cfg.studies[study].placeholder && !isTest(pid);
    }
    function excludedByOther(study, pid) {
      var others = (cfg.studies[study].exclude_participants_of || []).filter(function (o) { return o !== study; });
      if (!others.length || !pid || isTest(pid)) return false;
      if (db.sessions.some(function (s) { return s.prolific_pid === pid && s.study === study; })) return false;
      return db.sessions.some(function (s) { return s.prolific_pid === pid && others.indexOf(s.study) >= 0; });
    }

    function expireStale(t) {
      db.assignments.forEach(function (a) {
        if (a.status === "reserved" && a.expires_at < t) upd(a, { status: "expired" });
      });
    }
    function itemLoad(study, t) {  // item_id -> [completed, active reservations]
      var load = {};
      db.assignments.forEach(function (a) {
        if (a.study !== study || a.kind !== "real") return;
        var l = load[a.item_id] || (load[a.item_id] = [0, 0]);
        if (a.status === "completed") l[0]++;
        if (a.status === "reserved" && a.expires_at >= t) l[1]++;
      });
      return load;
    }

    function planSession(token, study, pid, d) {  // -> new assignment rows (not yet stored); [] = study full
      var sc = cfg.studies[study], raters = cfg.raters_per_item, t = ts(d);
      expireStale(t);
      var load = itemLoad(study, t);
      var seen = {};
      db.assignments.forEach(function (a) { if (a.study === study && a.prolific_pid === pid) seen[a.item_id] = 1; });
      var real = sc.items.filter(function (it) { return it.kind === "real"; });
      var used = {};
      real.forEach(function (it) { if (seen[it.item_id] && it.group != null) used[it.group] = 1; });
      var cands = [];
      real.forEach(function (it) {
        var l = load[it.item_id] || [0, 0];
        if (seen[it.item_id] || l[0] >= raters || l[0] + l[1] >= raters) return;
        cands.push([l[0] + l[1], it]);
      });
      shuffle(cands, rnd);                                         // random tie-break ...
      cands.sort(function (a, b) { return a[0] - b[0]; });         // ... stable sort keeps it per load level
      var chosen = [];
      if (sc.exclusive_groups) {  // least-loaded first, at most one item per group (none of a group seen before)
        for (var i = 0; i < cands.length && chosen.length < sc.batch_size; i++) {
          var it = cands[i][1];
          if (it.group == null || !used[it.group]) {
            chosen.push(it);
            if (it.group != null) used[it.group] = 1;
          }
        }
      } else {
        chosen = cands.slice(0, sc.batch_size).map(function (c) { return c[1]; });
      }
      if (!chosen.length) return [];
      shuffle(chosen, rnd);
      var checks = sc.items.filter(function (it) { return it.kind === "gold" || it.kind === "imc"; })
        .sort(function (a, b) { return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0; });
      shuffle(checks, rnd);
      var slots = attentionSlots(chosen.length, checks.length, cfg.attention_fractions);
      var ri = 0, ci = 0, seq = [];
      for (var pos = 0; pos < chosen.length + checks.length; pos++) {
        seq.push(slots.indexOf(pos) >= 0 ? checks[ci++] : chosen[ri++]);
      }
      var expires = ts(new Date(d.getTime() + cfg.reservation_timeout_minutes * 60000));
      return seq.map(function (it, p) {
        var order = displayOrder(it.checklist, rnd, !!sc.shuffle_checklist);
        var sides = sc.randomize_sides ? sideOrder(it.media.map(function (m) { return m.role; }), rnd) : null;
        return { assignment_id: nextAid++, session_uid: token, study: study, item_id: it.item_id,
                 prolific_pid: pid, kind: it.kind, position: p, status: "reserved",
                 display_order_json: JSON.stringify(order), media_order_json: sides ? JSON.stringify(sides) : null,
                 reserved_at: t, expires_at: expires, first_shown_at: null, submitted_at: null,
                 server_time_ms: null, client_time_ms: null, client_visible_ms: null, ended_roles: "[]",
                 _dirty: true };
      });
    }

    function touchSession(s, d) {  // slide the reservation deadline; re-reserve timed-out items if there is room
      var t = ts(d), expires = ts(new Date(d.getTime() + cfg.reservation_timeout_minutes * 60000));
      expireStale(t);
      var mine = assignmentsOf(s.session_uid);
      mine.forEach(function (a) { if (a.status === "reserved") upd(a, { expires_at: expires }); });
      var stale = mine.filter(function (a) { return a.status === "expired"; });
      if (!stale.length) return;
      var load = itemLoad(s.study, t);
      stale.forEach(function (a) {
        var l = load[a.item_id] || [0, 0];
        if (a.kind !== "real" || l[0] + l[1] < cfg.raters_per_item) {
          upd(a, { status: "reserved", expires_at: expires });
          if (a.kind === "real") load[a.item_id] = [l[0], l[1] + 1];
        }
      });
    }

    function finalizeAssignment(a) {  // 'completed', or 'surplus' when the item already has its raters
      var status = "completed";
      if (a.kind === "real") {
        var done = db.assignments.filter(function (b) {
          return b.study === a.study && b.item_id === a.item_id && b.status === "completed" &&
                 b.assignment_id !== a.assignment_id;
        }).length;
        if (done >= cfg.raters_per_item) status = "surplus";
      }
      upd(a, { status: status });
    }

    // ---------------------------------------------------------------------------------------- app.py ---
    function ingestEvents(s, events) {
      var t = ts(now()), mine = {};
      assignmentsOf(s.session_uid).forEach(function (a) { mine[a.assignment_id] = a; });
      (Array.isArray(events) ? events : []).slice(0, 500).forEach(function (e) {
        e = e || {};
        var et = String(e.type || "");
        if (EVENT_TYPES.indexOf(et) < 0) return;
        var aid = mine[e.assignment_id] ? Number(e.assignment_id) : null;
        var role = cfg.media_roles.indexOf(e.role) >= 0 ? e.role : null;
        if (et === "ended" && aid !== null && role) {  // app.py reads these back from its events table
          var a = mine[aid], ended = JSON.parse(a.ended_roles || "[]");
          if (ended.indexOf(role) < 0) { ended.push(role); upd(a, { ended_roles: JSON.stringify(ended) }); }
        }
        db.events.push({ session_uid: s.session_uid, assignment_id: aid, study: s.study,
                         prolific_pid: s.prolific_pid, event_type: et, video_role: role,
                         media_time: num(e.media_time), client_ts: int(e.client_ts), server_ts: t,
                         payload_json: e.payload !== undefined && e.payload !== null
                           ? JSON.stringify(e.payload).slice(0, 2000) : null, _dirty: true });
      });
    }

    function taskPayload(s, a) {
      var sc = cfg.studies[s.study], item = items[s.study][a.item_id];
      var media = item.media.map(function (m) {
        return { role: m.role, label: m.label, type: m.type, src: m.src };
      });
      if (a.media_order_json) {  // 2AFC: the stored random left/right order, labelled by side only
        var sides = JSON.parse(a.media_order_json), orderRoles, labels;
        if (item.layout === "quad") {  // edit_pair grid: the two "before" clips on top, the edited ones below
          orderRoles = sides.map(function (r) { return cfg.source_of[r]; }).concat(sides);
          labels = cfg.quad_labels;
        } else {
          orderRoles = sides; labels = cfg.side_labels;
        }
        media.sort(function (x, y) { return orderRoles.indexOf(x.role) - orderRoles.indexOf(y.role); });
        media.forEach(function (m, i) { if (i < labels.length) m.label = labels[i]; });
      }
      var byId = {};
      item.checklist.forEach(function (c) { byId[c.id] = c; });
      return {
        done: false, assignment_id: a.assignment_id, position: a.position, total: s.n_tasks,
        layout: item.layout, media: media,
        sync: (item.layout === "pair" || item.layout === "quad") &&
              media.every(function (m) { return m.type === "video"; }),
        checklist: JSON.parse(a.display_order_json).map(function (cid) {
          var c = byId[cid];
          return { id: cid, text: c.text, primary: !!c.primary, options: c.options };
        }),
        request: item.request || "", request_steps: item.request_steps || [],
        instruction_line: sc.instruction_line
      };
    }

    function finish(s) {
      var sc = cfg.studies[s.study];
      if (s.status !== "completed") {
        var checks = db.attention_checks.filter(function (c) { return c.session_uid === s.session_uid; });
        var passed = checks.reduce(function (n, c) { return n + Number(c.passed); }, 0);
        var failed = checks.length - passed;
        var failedBoth = checks.length >= 2 && failed >= 2 ? 1 : 0;
        var code = failedBoth && sc.failed_attention_code ? sc.failed_attention_code : sc.completion_code;
        upd(s, { status: "completed", completed_at: ts(now()), attention_passed: passed, attention_failed: failed,
                 failed_both: failedBoth, completion_code: code == null ? null : code });
      }
      var url = cfg.completion_url ? cfg.completion_url.split("{code}").join(s.completion_code) : "";
      return { done: true, redirect_url: url, code: s.completion_code };
    }

    function nextTask(s) {
      if (s.status !== "completed") touchSession(s, now());
      var a = assignmentsOf(s.session_uid).filter(function (x) { return !x.submitted_at; })[0];
      if (!a) return finish(s);
      if (!a.first_shown_at) upd(a, { first_shown_at: ts(now()) });
      return taskPayload(s, a);
    }

    function optionValues(c) { return c.options.map(function (o) { return o[0]; }); }

    return {
      start: function (study, body, meta) {
        var sc = cfg.studies[study];
        if (!sc) return reply(404, { error: "not_found" });
        body = body || {};
        var pid = String(body.prolific_pid || "").trim();
        if (pid && (cfg.preview_pids || []).indexOf(pid) >= 0) {  // Prolific's Preview: a fresh TEST_ session
          pid = cfg.test_pid_prefix + "prolific_preview_" + opts.uid().slice(0, 8);
        }
        if (!pid || !pidRe.test(pid)) return reply(400, { error: "missing_pid" });
        if (!body.consent) return reply(400, { error: "no_consent" });
        if (notOpen(study, pid)) return reply(503, { error: "study_full" });
        if (excludedByOther(study, pid)) return reply(409, { error: "not_eligible" });
        var d = now(), t = ts(d);
        var part = db.participants.filter(function (x) { return x.prolific_pid === pid; })[0];
        var touchPart = function () {
          if (part) upd(part, { last_seen_at: t });
          else db.participants.push({ prolific_pid: pid, first_seen_at: t, last_seen_at: t, _dirty: true });
        };
        var s = db.sessions.filter(function (x) { return x.prolific_pid === pid && x.study === study; })[0];
        if (s && s.status === "completed") { touchPart(); return reply(409, { error: "already_completed" }); }
        if (!s) {
          var token = opts.uid();
          var plan = planSession(token, study, pid, d);
          if (!plan.some(function (p) { return p.kind === "real"; })) return reply(503, { error: "study_full" });
          if (isTest(pid)) plan.forEach(function (p) { p.status = "test"; });  // previews never use the quota
          s = { session_uid: token, study: study, prolific_pid: pid,
                study_id: body.study_id == null ? null : String(body.study_id),
                prolific_session_id: body.session_id == null ? null : String(body.session_id),
                status: "in_progress", consented_at: t, started_at: t, instructions_done_at: null,
                last_active_at: t, completed_at: null, n_tasks: plan.length,
                n_real: plan.filter(function (p) { return p.kind === "real"; }).length,
                attention_passed: null, attention_failed: null, failed_both: null, completion_code: null,
                released_at: null, user_agent: String((meta && meta.user_agent) || "").slice(0, 400),
                screen_w: int(body.screen_w), screen_h: int(body.screen_h), viewport_w: int(body.viewport_w),
                viewport_h: int(body.viewport_h), _dirty: true };
          db.sessions.push(s);
          Array.prototype.push.apply(db.assignments, plan);
        }
        touchPart();
        var done = assignmentsOf(s.session_uid).filter(function (a) { return !!a.submitted_at; }).length;
        return reply(200, { token: s.session_uid, total: s.n_tasks, submitted: done,
                            show_instructions: !s.instructions_done_at });
      },

      instructionsDone: function (token) {
        var s = sessionOf(token);
        if (!s) return reply(404, { error: "not_found" });
        if (!s.instructions_done_at) upd(s, { instructions_done_at: ts(now()) });
        return reply(200, { ok: true });
      },

      task: function (token) {
        var s = sessionOf(token);
        if (!s) return reply(404, { error: "not_found" });
        return reply(200, nextTask(s));
      },

      events: function (token, events) {
        var s = sessionOf(token);
        if (!s) return reply(404, { error: "not_found" });
        ingestEvents(s, events);
        upd(s, { last_active_at: ts(now()) });
        return reply(200, { ok: true });
      },

      submit: function (token, body) {
        var s = sessionOf(token);
        if (!s) return reply(404, { error: "not_found" });
        if (s.status === "completed") return reply(200, nextTask(s));
        body = body || {};
        var d = now(), t = ts(d);
        var a = assignmentsOf(token).filter(function (x) { return !x.submitted_at; })[0];
        if (!a || a.assignment_id !== body.assignment_id) return reply(409, { error: "not_current_task" });
        var item = items[s.study][a.item_id];
        ingestEvents(s, body.events);
        var checklist = {};
        item.checklist.forEach(function (c) { checklist[c.id] = c; });
        var order = JSON.parse(a.display_order_json), answers = body.answers || {};
        var missing = order.filter(function (cid) {
          return optionValues(checklist[cid]).indexOf((answers[cid] || {}).answer) < 0;
        });
        if (missing.length) return reply(400, { error: "unanswered", items: missing });
        var ended = JSON.parse(a.ended_roles || "[]");
        var unwatched = item.media.filter(function (m) { return m.type === "video" && ended.indexOf(m.role) < 0; })
          .map(function (m) { return m.role; }).sort();
        if (unwatched.length) return reply(400, { error: "not_watched", roles: unwatched });
        var sides = a.media_order_json ? JSON.parse(a.media_order_json) : null;
        var chosen = {};  // 2AFC: checklist id -> media role of the picked video (none for tie / neither)
        order.forEach(function (cid, pos) {
          var c = checklist[cid], ans = answers[cid];
          var attn = item.kind !== "real" && c.expected !== undefined;
          if (sides && (ans.answer === "left" || ans.answer === "right")) {
            chosen[cid] = ans.answer === "left" ? sides[0] : sides[1];
          }
          db.responses.push({
            assignment_id: a.assignment_id, session_uid: token, study: s.study, item_id: item.item_id,
            item_kind: item.kind, model: item.model == null ? null : item.model, prolific_pid: s.prolific_pid,
            study_id: s.study_id, prolific_session_id: s.prolific_session_id, checklist_item_id: cid,
            checklist_text: c.text, category: c.category || item.category || null, display_position: pos,
            answer: ans.answer, expected: c.expected === undefined ? null : c.expected,
            is_attention_item: attn ? 1 : 0, n_changes: int(ans.n_changes), left_role: sides ? sides[0] : null,
            chosen_role: chosen[cid] === undefined ? null : chosen[cid], created_at: t, _dirty: true });
        });
        if (a.status !== "test") finalizeAssignment(a);
        var shown = a.first_shown_at ? parseTs(a.first_shown_at) : d;
        upd(a, { submitted_at: t, server_time_ms: Math.trunc(d.getTime() - shown.getTime()),
                 client_time_ms: int(body.client_time_ms), client_visible_ms: int(body.client_visible_ms) });
        if (item.kind === "gold" || item.kind === "imc") {
          var details = {}, passed = true;
          item.checklist.forEach(function (c) {
            if (c.expected === undefined) return;
            var dd = { expected: c.expected, answer: answers[c.id].answer };
            if (chosen[c.id] !== undefined) dd.chosen_role = chosen[c.id];
            details[c.id] = dd;
            // 2AFC: expected 'left'/'right' is positional (IMC); a media role means "pick that clip" (gold)
            var got = cfg.media_roles.indexOf(dd.expected) >= 0 ? dd.chosen_role : dd.answer;
            if (got !== dd.expected) passed = false;
          });
          db.attention_checks.push({
            session_uid: token, study: s.study, prolific_pid: s.prolific_pid, study_id: s.study_id,
            prolific_session_id: s.prolific_session_id, check_type: item.kind, item_id: item.item_id,
            assignment_id: a.assignment_id, position: a.position, passed: passed ? 1 : 0,
            details_json: JSON.stringify(details), created_at: t, _dirty: true });
        }
        upd(s, { last_active_at: t });
        return reply(200, nextTask(s));
      },

      // ---------------------------------------------------------------------------------- admin ---
      release: function (token) {  // app.py /admin/release: re-open a finished session's items
        var s = sessionOf(token);
        if (!s || s.status !== "completed") return reply(404, { error: "not_found" });
        var n = 0;
        assignmentsOf(token).forEach(function (a) {
          if (a.kind === "real" && a.status === "completed") { upd(a, { status: "excluded" }); n++; }
        });
        upd(s, { released_at: ts(now()) });
        return reply(200, { released: n });
      },

      stats: function () {  // the counting part of app.py admin_stats
        var t = ts(now()), out = {}, r = cfg.raters_per_item;
        Object.keys(cfg.studies).forEach(function (key) {
          var load = itemLoad(key, t);
          var ids = cfg.studies[key].items.filter(function (it) { return it.kind === "real"; })
            .map(function (it) { return it.item_id; });
          var hist = {}, completed = 0, active = 0;
          for (var n = 0; n <= r; n++) hist[n] = 0;
          ids.forEach(function (id) {
            var l = load[id] || [0, 0];
            hist[Math.min(l[0], r)]++; completed += Math.min(l[0], r); active += l[1];
          });
          var sess = {}, fb = 0, nDone = 0, att = {};
          db.sessions.forEach(function (s) {
            if (s.study !== key) return;
            sess[s.status] = (sess[s.status] || 0) + 1;
            if (s.status === "completed") { nDone++; fb += Number(s.failed_both) || 0; }
          });
          db.attention_checks.forEach(function (c) {
            if (c.study !== key) return;
            var x = att[c.check_type] || (att[c.check_type] = { n: 0, failed: 0 });
            x.n++; x.failed += 1 - Number(c.passed);
          });
          out[key] = { n_items: ids.length, ratings_needed: ids.length * r, ratings_completed: completed,
                       active_reservations: active, items_by_completed_ratings: hist, sessions: sess,
                       attention: att, failed_both: { n_completed_sessions: nDone, failed_both: fb } };
        });
        return reply(200, out);
      }
    };
  }

  return { server: server, attentionSlots: attentionSlots, displayOrder: displayOrder, sideOrder: sideOrder,
           ts: ts };
})();

if (typeof module !== "undefined" && module.exports) module.exports = PVSCore;
