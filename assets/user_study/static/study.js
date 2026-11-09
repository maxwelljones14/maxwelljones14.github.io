/* Prolific video study client: consent -> instructions + worked example -> tasks -> completion redirect.
   One task = one video (or a synced Original/Edited pair, or reference scene image + video) + yes/no questions,
   or (motion study) a synced Left/Right pair + forced-choice questions answered "Left video" / "Right video",
   or (edit_pair study) a synced 2x2 grid (top: the two "before" clips, bottom: the two edited clips) + questions
   with their own answer sets (e.g. Left / Right / Tie / Neither). Each question may carry `options`.
   Nothing autoplays: the participant clicks Play. Submit unlocks only when every item is answered AND every
   video has fired `ended` at least once. */
(() => {
  "use strict";
  const P = window.PAGE;
  const T = window.PVS_TRANSPORT;  // static (GitHub Pages) site only: static_site/pvs_static.js; unset under Flask
  const $ = (id) => document.getElementById(id);
  const S = { token: null, task: null, answers: {}, events: [], player: null, exPlayers: [], busy: false,
              t0: 0, visibleMs: 0, visibleSince: null, firstInstructions: false };

  // ------------------------------------------------------------------------------------------ logging ---
  function log(type, extra) {
    S.events.push(Object.assign({ type, client_ts: Date.now(),
                                  assignment_id: S.task ? S.task.assignment_id : null }, extra || {}));
  }
  function takeEvents() { const e = S.events; S.events = []; return e; }
  function flush(useBeacon) {
    if (!S.token || !S.events.length) return;
    if (T) return T.events(S.token, takeEvents(), useBeacon);
    const body = JSON.stringify({ events: takeEvents() });
    const url = `/api/session/${S.token}/events`;
    if (useBeacon && navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
    else fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  }
  setInterval(() => flush(false), 10000);
  document.addEventListener("visibilitychange", () => {
    const now = performance.now();
    if (document.hidden) {
      if (S.visibleSince !== null) { S.visibleMs += now - S.visibleSince; S.visibleSince = null; }
      log("visibility", { payload: { hidden: true } }); flush(true);
    } else {
      if (S.task) S.visibleSince = now;
      log("visibility", { payload: { hidden: false } });
    }
  });

  async function api(path, body, method) {
    if (T) return T.api(path, body, method);
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(path, { method: method || (body ? "POST" : "GET"),
                                      headers: { "Content-Type": "application/json" },
                                      body: body ? JSON.stringify(body) : undefined });
        const data = await r.json().catch(() => ({}));
        return { ok: r.ok, status: r.status, data };
      } catch (err) {
        if (attempt >= 2) throw err;
        await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
      }
    }
  }

  // ---------------------------------------------------------------------------------------- screens ---
  function show(id) {
    for (const s of ["screenConsent", "screenTask", "screenMessage"]) $(s).hidden = s !== id;
    $("topbar").hidden = id !== "screenTask";
  }
  function message(heading, html) {
    if (S.player) { S.player.destroy(); S.player = null; }
    $("msgHeading").textContent = heading;
    $("msgBody").innerHTML = html;
    show("screenMessage");
  }

  // ------------------------------------------------------------------------------------------ media ---
  const VIDEO_ATTRS = { muted: "", playsinline: "", preload: "auto", disablepictureinpicture: "",
                        disableremoteplayback: "", controlslist: "nodownload noplaybackrate noremoteplayback nofullscreen" };
  function makeVideo(src) {
    const v = document.createElement("video");
    for (const [k, val] of Object.entries(VIDEO_ATTRS)) v.setAttribute(k, val);
    v.muted = true; v.defaultMuted = true;
    v.addEventListener("contextmenu", (e) => e.preventDefault());
    v.src = src;
    return v;
  }
  const fmt = (t) => { t = Math.max(0, t || 0); return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`; };

  /* Plays 1 or 2 videos (+ optional still image) as one unit: shared play/pause/replay/slider, synced, looping.
     Never autoplays: a "Play" overlay waits for the participant's click. Videos of unequal length: the shorter
     shows a black screen once it ends, until the longer one ends and both restart together. With a still image
     (scene study) the controls sit under the video only, so the image never looks like a video. */
  const BTN_ICONS = { Play: "\u25B6\uFE0F", Pause: "\u23F8\uFE0F", Replay: "\uD83D\uDD01" };  // ▶️ ⏸️ 🔁
  class Player {
    constructor(container, media, opts) {
      this.opts = opts || {};
      this.videos = []; this.playing = false; this.maxReached = 0; this.destroyed = false;
      const row = document.createElement("div"); row.className = "media-row";
      let videoCell = null;
      for (const m of media) {
        const cell = document.createElement("div"); cell.className = "media-cell";
        if (media.length > 1 || this.opts.labelSingle) {
          const lab = document.createElement("div"); lab.className = "media-label"; lab.textContent = m.label;
          cell.appendChild(lab);
        }
        const box = document.createElement("div"); box.className = "media-box";
        if (m.type === "image") {
          box.classList.add("still"); cell.classList.add("still-cell"); this.imageCell = cell;
          const img = document.createElement("img"); img.src = m.src; img.alt = m.label; img.draggable = false;
          img.addEventListener("contextmenu", (e) => e.preventDefault());
          box.appendChild(img);
        } else {
          const el = makeVideo(m.src);
          videoCell = cell;
          const badge = document.createElement("div"); badge.className = "watched";
          badge.textContent = "not watched to the end yet";
          if (!this.opts.preview) box.appendChild(badge);
          box.appendChild(el);
          const v = { role: m.role, el, ended: false, watched: false, badge, ready: false };
          this.videos.push(v);
          el.addEventListener("loadedmetadata", () => { v.ready = true; this.onReady(); });
          el.addEventListener("ended", () => this.onEnded(v));
          el.addEventListener("error", () => { this.emit("error", v, { code: el.error && el.error.code });
                                               badge.textContent = "video failed to load - please reload the page"; });
          el.addEventListener("waiting", () => this.emit("waiting", v));
        }
        cell.appendChild(box); row.appendChild(cell);
      }
      container.appendChild(row);
      if (this.videos.length && !this.opts.preview) {
        const ctl = this.buildControls();
        // image + one video: the timeline belongs to the video alone
        if (this.videos.length === 1 && media.length > 1) {
          videoCell.appendChild(ctl);
          if (this.imageCell) this.imageCell.appendChild(Object.assign(document.createElement("div"),
            { className: "still-note", textContent: "Still image (does not play)" }));
        } else container.appendChild(ctl);
      }
      this.timer = setInterval(() => this.tick(), 200);
    }
    emit(type, v, payload) {
      if (this.opts.onEvent) this.opts.onEvent(type, v ? v.role : null, v ? v.el.currentTime : this.time(), payload);
    }
    buildControls() {
      const c = document.createElement("div"); c.className = "controls";
      this.btnPlay = Object.assign(document.createElement("button"), { className: "btn btn-secondary", type: "button" });
      this.btnReplay = Object.assign(document.createElement("button"), { className: "btn btn-secondary", type: "button" });
      this.setLabel(this.btnPlay, "Play");
      this.setLabel(this.btnReplay, "Replay");
      this.slider = Object.assign(document.createElement("input"), { type: "range", min: 0, max: 1, step: 0.01, value: 0 });
      this.slider.setAttribute("aria-label", "Video position");
      this.timeLabel = Object.assign(document.createElement("span"), { className: "time", textContent: "0:00 / 0:00" });
      this.btnPlay.addEventListener("click", () => { this.playing ? this.pause(true) : this.play(true); });
      this.btnReplay.addEventListener("click", () => { this.emit("replay"); this.seek(0); this.play(true); });
      this.slider.addEventListener("input", () => { this.dragging = true; this.seek(parseFloat(this.slider.value)); });
      this.slider.addEventListener("change", () => { this.dragging = false; this.emit("seeked", null, { to: this.time() }); });
      c.append(this.btnPlay, this.btnReplay, this.slider, this.timeLabel);
      return c;
    }
    get duration() { return Math.max(0, ...this.videos.map((v) => v.el.duration || 0)); }
    get master() { return this.videos.reduce((a, b) => ((b.el.duration || 0) > (a.el.duration || 0) ? b : a), this.videos[0]); }
    get allWatched() { return this.videos.every((v) => v.watched); }
    setEnded(v, ended) {  // a finished shorter video of a pair goes black (it never freezes on its last frame)
      v.ended = ended;
      const shorter = this.videos.length > 1 && (v.el.duration || 0) < this.duration - 0.05;
      v.el.parentElement.classList.toggle("blank", ended && shorter);
    }
    time() { const m = this.master; return m ? (m.ended ? m.el.duration : m.el.currentTime) : 0; }
    onReady() {
      if (!this.videos.every((v) => v.ready) || this.started) return;
      this.started = true;
      if (this.slider) this.slider.max = this.duration.toFixed(2);
      this.emit("loaded", null, { durations: Object.fromEntries(this.videos.map((v) => [v.role, v.el.duration])) });
      if (this.opts.onLayout) this.opts.onLayout();
      this.showOverlay();  // no autoplay: wait for the participant
    }
    showOverlay() {
      if (this.overlays || this.destroyed) return;
      this.overlays = this.videos.map((v) => {
        const b = Object.assign(document.createElement("button"), { className: "play-overlay", type: "button",
                                                                    textContent: "\u25B6 Play" });
        b.setAttribute("aria-label", "Play");
        b.addEventListener("click", () => this.play(true));
        v.el.parentElement.appendChild(b);
        return b;
      });
    }
    setLabel(btn, text) {  // word + an icon on its right (aria-hidden, so the button's name stays the word)
      if (!btn) return;
      const icon = Object.assign(document.createElement("span"), { className: "btn-icon", textContent: BTN_ICONS[text] || "" });
      icon.setAttribute("aria-hidden", "true");
      btn.replaceChildren(text, icon);
    }
    hideOverlay() { if (this.overlays) { for (const b of this.overlays) b.remove(); this.overlays = null; } }
    play(user) {
      this.playing = true;
      this.hideOverlay();
      this.setLabel(this.btnPlay, "Pause");
      for (const v of this.videos) if (!v.ended) v.el.play().catch(() => this.needClick());
      if (user) this.emit("play");
    }
    pause(user) {
      this.playing = false;
      this.setLabel(this.btnPlay, "Play");
      for (const v of this.videos) v.el.pause();
      if (this.opts.preview) this.showOverlay();  // the worked example has no controls: Play again via overlay
      if (user) this.emit("pause");
    }
    needClick() {  // the browser refused to play: ask for another click
      this.playing = false;
      this.setLabel(this.btnPlay, "Play");
      this.showOverlay();
    }
    seek(t) {
      if (!this.allWatched) t = Math.min(t, this.maxReached + 0.25);  // no skipping ahead before a full viewing
      for (const v of this.videos) {
        const d = v.el.duration || 0;
        this.setEnded(v, t >= d - 0.05);
        v.el.currentTime = Math.min(t, Math.max(0, d - 0.05));
        if (this.playing && !v.ended) v.el.play().catch(() => {});
      }
      if (this.slider) this.slider.value = t;
      if (this.timeLabel) this.timeLabel.textContent = `${fmt(this.time())} / ${fmt(this.duration)}`;
    }
    onEnded(v) {
      this.setEnded(v, true);
      if (!v.watched) {
        v.watched = true;
        v.badge.textContent = "\u2713 watched"; v.badge.classList.add("ok");
        if (this.opts.onWatched) this.opts.onWatched(v.role);
      }
      this.emit("ended", v);
      if (this.videos.every((x) => x.ended)) {  // loop the whole unit
        for (const x of this.videos) { this.setEnded(x, false); x.el.currentTime = 0; }
        if (this.playing) for (const x of this.videos) x.el.play().catch(() => {});
        this.emit("loop");
      }
    }
    tick() {
      if (!this.started) return;
      const t = this.time();
      if (!this.allWatched) this.maxReached = Math.max(this.maxReached, t);
      if (this.slider && !this.dragging) this.slider.value = t;
      if (this.timeLabel) this.timeLabel.textContent = `${fmt(t)} / ${fmt(this.duration)}`;
      // keep a synced pair together (drift > 0.15 s): followers snap to the master's clock
      const m = this.master;
      if (this.videos.length > 1 && this.playing && !m.el.paused) {
        for (const v of this.videos) {
          if (v === m || v.ended) continue;
          const target = Math.min(m.el.currentTime, (v.el.duration || 0) - 0.05);
          if (Math.abs(v.el.currentTime - target) > 0.15) v.el.currentTime = target;
          if (v.el.paused && m.el.currentTime < (v.el.duration || 0) - 0.05) v.el.play().catch(() => {});
        }
      }
    }
    destroy() {
      this.destroyed = true; clearInterval(this.timer);
      for (const v of this.videos) { v.el.pause(); v.el.removeAttribute("src"); v.el.load(); }
    }
  }

  // ------------------------------------------------------------------------------------------- fit ---
  // Guarantee the no-scroll layout: shrink checklist font, then the minimum video row height, until it fits.
  function overflowing() {
    const H = window.innerHeight, W = window.innerWidth, root = document.documentElement;
    if (root.scrollHeight > H + 1 || root.scrollWidth > W + 1) return true;
    const cl = $("checklist"), ca = $("checkArea"), btn = $("btnSubmit"), grid = $("taskGrid");
    if (cl.scrollHeight > cl.clientHeight + 1 || ca.scrollHeight > ca.clientHeight + 1) return true;
    if (grid.scrollHeight > grid.clientHeight + 1) return true;
    const b = btn.getBoundingClientRect();
    return b.bottom > H || b.right > W;
  }
  function fit() {
    if ($("screenTask").hidden) return;
    const root = document.documentElement.style;
    let fs = 1, mm = 34;
    root.setProperty("--fs", fs); root.setProperty("--media-min", mm + "vh");
    while (overflowing() && fs > 0.66) { fs = +(fs - 0.04).toFixed(2); root.setProperty("--fs", fs); }
    while (overflowing() && mm > 18) { mm -= 2; root.setProperty("--media-min", mm + "vh"); }
    if (fs < 1 || mm < 34) log("fit", { payload: { fs, media_min_vh: mm, w: innerWidth, h: innerHeight } });
  }
  function fitInstructions() {
    const box = document.querySelector(".modal-box");
    const over = () => [".instr-text", ".instr-example"].some((s) => { const e = box.querySelector(s); return e.scrollHeight > e.clientHeight + 1; });
    let f = 1; box.style.setProperty("--efs", f);
    while (over() && f > 0.62) { f = +(f - 0.04).toFixed(2); box.style.setProperty("--efs", f); }
  }
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { fit(); if (!$("instrModal").hidden) fitInstructions(); log("resize", { payload: { w: innerWidth, h: innerHeight } }); }, 150);
  });

  // --------------------------------------------------------------------------------- instructions ---
  const defaultChoices = () => P.choices || [["yes", "Yes"], ["no", "No"]];
  function toggleButtons(onPick, pressed, disabled, options) {
    const opts = options && options.length ? options : defaultChoices();
    const wrap = document.createElement("div"); wrap.className = "toggles" + (opts.length > 2 ? " many" : "");
    const btns = {};
    for (const [val, label] of opts) {
      const b = Object.assign(document.createElement("button"), { className: "toggle", type: "button", textContent: label });
      b.dataset.value = val;
      b.setAttribute("aria-pressed", pressed === val ? "true" : "false");
      b.disabled = !!disabled;
      if (onPick) b.addEventListener("click", () => onPick(val, btns));
      btns[val] = b; wrap.appendChild(b);
    }
    return wrap;
  }
  function requestBox(el, text, steps) {
    el.innerHTML = "";
    const lab = Object.assign(document.createElement("span"), { className: "request-label", textContent: P.request_label });
    let t;
    if (steps && steps.length) {  // numbered steps are easier to read than one long sentence
      t = Object.assign(document.createElement("ol"), { className: "request-text request-steps" });
      for (const s of steps) t.appendChild(Object.assign(document.createElement("li"), { textContent: s }));
    } else {
      t = Object.assign(document.createElement("span"), { className: "request-text", textContent: text });
    }
    el.append(lab, t);
    el.hidden = !text && !(steps && steps.length);
  }
  function buildInstructions() {
    $("instrCriteria").innerHTML = P.criteria;
    $("instrRules").innerHTML = P.rules.map((r) => `<li>${r}</li>`).join("");
    const ex = P.example || {};
    requestBox($("exRequest"), ex.request || "", ex.request_steps);
    $("exNote").innerHTML = ex.note || "";
    buildExampleChecklist(false);
    if (!(ex.media || []).length) $("exMedia").hidden = true;
  }
  const choiceLabel = (val, options) => (((options && options.length ? options : defaultChoices()))
                                          .find(([v]) => v === val) || [val, val])[1];
  /* practice = the first showing: the participant must press the marked answer of every example question
     before "Start the tasks" unlocks. Re-opened later, the example shows its answers read-only. */
  function buildExampleChecklist(practice) {
    const ex = P.example || {};
    const list = $("exChecklist"); list.innerHTML = "";
    S.exLeft = 0;
    for (const c of ex.checklist || []) {
      const li = document.createElement("li");
      const t = document.createElement("div"); t.className = "check-text"; t.textContent = c.text;
      const w = document.createElement("div"); w.className = "ex-why";
      if (!practice || !c.answer) {
        li.className = "check-item answered";
        li.append(t, toggleButtons(null, c.answer, true, c.options));
        w.innerHTML = c.why || "";
      } else {
        S.exLeft++;
        li.className = "check-item ex-practice";
        const label = choiceLabel(c.answer, c.options);
        const hint = `<span class="ex-press">Press <b>${label}</b>.</span> `;
        w.innerHTML = hint + (c.why || "");
        let done = false;
        const toggles = toggleButtons((val, btns) => {
          if (done) return;
          const correct = val === c.answer;
          log("example_answer", { payload: { text: c.text, answer: val, correct } });
          if (!correct) {
            li.classList.add("ex-wrong");
            w.innerHTML = `<span class="ex-press">Not quite: for this example the answer is <b>${label}</b>.</span> ` + (c.why || "");
            return;
          }
          done = true;
          li.classList.remove("ex-wrong", "ex-practice"); li.classList.add("answered", "ex-done");
          for (const [k, b] of Object.entries(btns)) { b.setAttribute("aria-pressed", k === val ? "true" : "false"); b.disabled = true; }
          w.innerHTML = c.why || "";
          S.exLeft--; updateExampleGate(); fitInstructions();
        }, null, false, c.options);
        const target = toggles.querySelector(`[data-value="${c.answer}"]`);
        if (target) target.classList.add("ex-target");
        li.append(t, toggles);
      }
      if (w.innerHTML) li.appendChild(w);
      list.appendChild(li);
    }
    updateExampleGate();
  }
  function updateExampleGate() {
    const left = S.firstInstructions ? S.exLeft : 0;
    $("btnCloseInstr").disabled = left > 0;
    $("exGateMsg").textContent = left > 0
      ? `Press the marked answer for ${left === 1 ? "the" : `all ${left}`} example question${left > 1 ? "s" : ""} to unlock \u201cStart the tasks\u201d.`
      : "";
  }
  function startExampleMedia() {
    const ex = P.example || {};
    if (S.exPlayers.length || !(ex.media || []).length) return;
    const holder = $("exMedia"); holder.innerHTML = "";
    const media = ex.media.map((m) => Object.assign({}, m));
    // the example loops like a task (synced, shorter one goes black) but never gates anything
    holder.classList.toggle("quad", media.length === 4);
    const p = new Player(holder, media, { preview: true });
    S.exPlayers.push(p);
    holder.querySelector(".media-row").style.flex = "1";
  }
  function openInstructions(first) {
    S.firstInstructions = !!first;
    S.resumeTask = !!(S.player && S.player.playing);
    if (S.player) S.player.pause(false);
    $("btnCloseInstr").textContent = first ? "Start the tasks" : "Back to the task";
    buildExampleChecklist(!!first);
    $("instrModal").hidden = false;
    startExampleMedia();
    fitInstructions();
    log("instructions_open", { payload: { first: !!first } });
  }
  async function closeInstructions() {
    if (S.firstInstructions && S.exLeft > 0) return;
    $("instrModal").hidden = true;
    for (const p of S.exPlayers) p.pause(false);
    log("instructions_close");
    if (S.firstInstructions) {
      S.firstInstructions = false;
      await api(`/api/session/${S.token}/instructions_done`, {});
      await loadTask();
    } else if (S.player && S.resumeTask) {
      S.player.play(false);
    }
  }

  // --------------------------------------------------------------------------------------- consent ---
  async function start() {
    $("btnAgree").disabled = true;
    const p = P.params;
    let r;
    try {
      r = await api(`/api/${P.study}/start`, {
        prolific_pid: p.prolific_pid, study_id: p.study_id, session_id: p.session_id, consent: true,
        screen_w: screen.width, screen_h: screen.height, viewport_w: innerWidth, viewport_h: innerHeight });
    } catch (e) {
      $("btnAgree").disabled = false;
      return message("Connection problem", "<p>We could not reach the server. Please check your connection and reload the page.</p>");
    }
    if (r.status === 409 && r.data.error === "not_eligible") return message("Not eligible", "<p>Our records show you have taken part in a closely related study, so you cannot take part in this one. Please <b>return</b> the study on Prolific; you will not be penalised.</p>");
    if (r.status === 409) return message("Already completed", "<p>Our records show you have already completed this study. You can only take part once. Thank you!</p>");
    if (r.status === 503) return message("No tasks available", "<p>Sorry - all tasks in this study are currently taken by other participants. Please <b>return</b> the study on Prolific; you will not be penalised.</p>");
    if (!r.ok) return message("Something went wrong", `<p>Please reopen the study from Prolific. (${r.data.error || r.status})</p>`);
    S.token = r.data.token;
    if (r.data.show_instructions) { show("screenTask"); openInstructions(true); }
    else await loadTask();
  }

  // ------------------------------------------------------------------------------------------ tasks ---
  async function loadTask() {
    const r = await api(`/api/session/${S.token}/task`);
    if (!r.ok) return message("Something went wrong", "<p>Please reload the page.</p>");
    render(r.data);
  }

  function render(task) {
    if (S.player) { S.player.destroy(); S.player = null; }
    if (task.done) return finish(task);
    S.task = task; S.answers = {};
    S.t0 = performance.now(); S.visibleMs = 0; S.visibleSince = document.hidden ? null : S.t0;
    show("screenTask");
    $("instrLine").textContent = task.instruction_line;
    $("progressText").textContent = `Task ${task.position + 1} of ${task.total}`;
    $("progressFill").style.width = `${(100 * task.position) / task.total}%`;
    const grid = $("taskGrid");
    grid.className = `task layout-${task.layout}`;
    const area = $("mediaArea"); area.innerHTML = "";
    if (task.request || (task.request_steps || []).length) {
      const rb = document.createElement("div"); rb.className = "request-box"; rb.id = "requestBox";
      requestBox(rb, task.request, task.request_steps);
      area.appendChild(rb);
    }
    const heading = $("checkHeading");
    heading.textContent = P.checklist_heading || "";
    heading.hidden = !P.checklist_heading;
    S.player = new Player(area, task.media, {
      onEvent: (type, role, t, payload) => { log(type, { role, media_time: t, payload }); if (type === "play") updateGate(); },
      onWatched: () => updateGate(),
      onLayout: () => fit(),
    });
    const list = $("checklist"); list.innerHTML = "";
    for (const c of task.checklist) {
      const li = document.createElement("li"); li.className = "check-item" + (c.primary ? " primary" : "");
      li.dataset.id = c.id;
      const t = document.createElement("div"); t.className = "check-text"; t.textContent = c.text;
      li.append(t, toggleButtons((val, btns) => {
        const prev = S.answers[c.id];
        S.answers[c.id] = { answer: val, n_changes: (prev ? prev.n_changes : 0) + 1 };
        for (const [k, b] of Object.entries(btns)) b.setAttribute("aria-pressed", k === val ? "true" : "false");
        li.classList.add("answered");
        log("answer", { payload: { id: c.id, answer: val } });
        updateGate();
      }, null, false, c.options));
      list.appendChild(li);
    }
    updateGate();
    fit();
  }

  function gateState() {
    const t = S.task;
    const left = t.checklist.filter((c) => !S.answers[c.id]).length;
    const unwatched = S.player ? S.player.videos.filter((v) => !v.watched).length : 0;
    return { left, unwatched };
  }
  function updateGate() {
    if (!S.task) return;
    const { left, unwatched } = gateState();
    const msgs = [];
    if (unwatched) msgs.push((S.player.started && !S.player.overlays ? "" : "click Play and ") +
                             (S.player.videos.length > 2 ? "watch all videos to the end"
                              : S.player.videos.length > 1 ? "watch both videos to the end" : "watch the video to the end"));
    if (left) msgs.push(`answer ${left} more item${left > 1 ? "s" : ""}`);
    let msg = msgs.join(" and ");
    if (msg) msg = msg[0].toUpperCase() + msg.slice(1) + " to unlock Submit.";
    $("gateMsg").textContent = msg;
    $("btnSubmit").disabled = !!(left || unwatched) || S.busy;
  }

  async function submit() {
    const { left, unwatched } = gateState();
    if (left || unwatched || S.busy) return;
    S.busy = true; $("btnSubmit").disabled = true;
    const now = performance.now();
    const visible = S.visibleMs + (S.visibleSince !== null ? now - S.visibleSince : 0);
    const payload = { assignment_id: S.task.assignment_id, answers: S.answers,
                      client_time_ms: Math.round(now - S.t0), client_visible_ms: Math.round(visible),
                      events: takeEvents() };
    let r;
    try { r = await api(`/api/session/${S.token}/submit`, payload); }
    catch (e) { r = { ok: false, data: { error: "network" } }; }
    S.busy = false;
    if (!r.ok) {
      if (r.data.error === "not_current_task") return loadTask();
      $("gateMsg").textContent = r.data.error === "network"
        ? "Connection problem - please press Submit again."
        : `Could not submit (${r.data.error}). Please make sure the videos played to the end and try again.`;
      setTimeout(updateGate, 500);
      return;
    }
    render(r.data);
  }

  function finish(task) {
    S.task = null;
    flush(true);
    const url = task.redirect_url;
    if (!url) return message("Thank you!", P.finish_html || "<p>You have finished all tasks. Your answers are saved; you can close this tab.</p>");
    message("Thank you!",
      `<p>You have finished all tasks. Redirecting you to Prolific to record your completion&hellip;</p>
       <p>If nothing happens within a few seconds, <a id="completionLink" href="${url}">click here</a>
       (completion code <b>${task.code}</b>).</p>`);
    setTimeout(() => { window.location.href = url; }, 1500);
  }

  // ------------------------------------------------------------------------------------------- init ---
  $("btnAgree").addEventListener("click", start);
  $("btnDecline").addEventListener("click", () => message("No problem", P.prolific === false
    ? "<p>You did not agree to take part, so no data was recorded. You can close this tab.</p>"
    : "<p>You did not agree to take part, so no data was recorded. Please <b>return</b> the study on Prolific " +
      "(\u201cStop without completing\u201d) so the place can go to someone else.</p>"));
  $("btnInstructions").addEventListener("click", () => openInstructions(false));
  $("btnCloseInstr").addEventListener("click", closeInstructions);
  $("btnSubmit").addEventListener("click", submit);
  buildInstructions();
  if (P.resume) start(); else show("screenConsent");
})();
