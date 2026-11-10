// The foosball table across the top of the ladder page. Your pointer drags the
// ball around; every rod slides to put its nearest player in line with the ball
// and kicks it toward the other goal when it gets close. Players' heads are the
// ladder's profile photos (app.js sends them in a `foos:players` event).
// Top-down 2D, so a kick is faked: the player stretches toward the goal for a
// moment and the ball gets an impulse. Keep this file ES2017.
(function () {
  "use strict";

  var wrap = document.querySelector(".fb-pitch");
  if (!wrap) return;
  var canvas = wrap.querySelector("canvas");
  var ctx = canvas.getContext("2d");
  var scoreEl = wrap.querySelector(".fb-pitch-score");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var TEAM = [
    { name: "RED", body: "#d64545", dark: "#8e2323", dir: 1 },
    { name: "BLUE", body: "#3a6fd8", dark: "#1f3f86", dir: -1 },
  ];
  // Rods left to right as on a real table: fraction of field length, team, players per rod.
  var LAYOUT = [
    [0.05, 0, 1], [0.17, 0, 2], [0.3, 1, 3], [0.43, 0, 5],
    [0.57, 1, 5], [0.7, 0, 3], [0.83, 1, 2], [0.95, 1, 1],
  ];
  var SPACING = { 1: 0, 2: 0.36, 3: 0.3, 5: 0.19 }; // gap between men, fraction of field height
  // Game clock relative to real time. The pointer's pull and the post-goal pause
  // are scaled to cancel it out, so only the table's own play slows down.
  var SPEED = 0.5;
  var KICK_TIME = 0.16;
  var STUN_TIME = 0.35; // after a kick the pointer briefly loses the ball

  var g = {}; // geometry, rebuilt on resize
  var rods = [];
  var ball = { x: 0, y: 0, vx: 0, vy: 0, stun: 0, idle: 0 };
  var pointer = { x: 0, y: 0, active: false };
  var score = [0, 0];
  var freeze = 0; // seconds left of the post-goal pause
  var heads = []; // [{uid, img}] in ladder order
  var running = false;
  var visible = true;
  var last = 0;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function layout() {
    var w = wrap.clientWidth;
    var h = Math.round(clamp(w * 0.36, 170, 280));
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var old = g.w ? { fx: (ball.x - g.left) / g.fw, fy: (ball.y - g.top) / g.fh } : null;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var pad = Math.max(10, w * 0.02);
    g = { w: w, h: h, left: pad, right: w - pad, top: 8, bottom: h - 8 };
    g.fw = g.right - g.left;
    g.fh = g.bottom - g.top;
    g.cx = (g.left + g.right) / 2;
    g.cy = (g.top + g.bottom) / 2;
    g.goal = g.fh * 0.17; // half-height of the goal mouth
    g.pr = clamp(h * 0.052, 7, 14); // player radius
    g.br = g.pr * 0.72; // ball radius
    g.reach = g.pr * 1.3;

    rods = LAYOUT.map(function (r, i) {
      var n = r[2];
      var s = SPACING[n] * g.fh;
      var prev = rods[i];
      var maxOff = n === 1 ? g.goal * 1.15 : g.fh / 2 - g.pr * 1.4 - ((n - 1) * s) / 2;
      return {
        x: g.left + r[0] * g.fw, team: r[1], n: n, s: s, maxOff: maxOff,
        off: prev ? clamp(prev.off, -maxOff, maxOff) : 0,
        kick: -1, cool: 0, men: [],
      };
    });
    assignHeads();

    if (old) {
      ball.x = g.left + old.fx * g.fw;
      ball.y = g.top + old.fy * g.fh;
    } else {
      kickoff();
    }
    draw();
  }

  // Hand out photos: goalies first, then outward from the middle of each team's
  // rods, alternating teams so both sides get faces.
  function assignHeads() {
    var slots = [];
    rods.forEach(function (rod, ri) {
      rod.men = [];
      for (var i = 0; i < rod.n; i++) {
        rod.men.push({ img: null });
        slots.push({ rod: ri, i: i, pri: (rod.n === 1 ? 0 : 1) * 10 + Math.abs(i - (rod.n - 1) / 2), team: rod.team });
      }
    });
    slots.sort(function (a, b) { return a.pri - b.pri || a.team - b.team || a.rod - b.rod; });
    var byTeam = [slots.filter(function (s) { return s.team === 0; }), slots.filter(function (s) { return s.team === 1; })];
    heads.forEach(function (h, k) {
      var s = byTeam[k % 2][Math.floor(k / 2)];
      if (s) rods[s.rod].men[s.i].img = h.img;
    });
  }

  function manY(rod, i) {
    return g.cy + rod.off + (i - (rod.n - 1) / 2) * rod.s;
  }

  function kickoff() {
    ball.x = g.cx;
    ball.y = g.cy;
    var a = (Math.random() - 0.5) * 1.2 + (Math.random() < 0.5 ? 0 : Math.PI);
    var sp = g.fw * 0.35;
    ball.vx = Math.cos(a) * sp;
    ball.vy = Math.sin(a) * sp;
    ball.stun = 0;
  }

  // ---- simulation ----------------------------------------------------------

  function step(dt) {
    if (freeze > 0) {
      freeze -= dt;
      if (freeze <= 0) kickoff();
      return;
    }

    // Pointer pulls the ball like a stiff spring, unless a kick just knocked it loose.
    ball.stun = Math.max(0, ball.stun - dt);
    if (pointer.active && ball.stun === 0) {
      var k = 90 / (SPEED * SPEED);
      var c = 12 / SPEED;
      ball.vx += ((pointer.x - ball.x) * k - ball.vx * c) * dt;
      ball.vy += ((pointer.y - ball.y) * k - ball.vy * c) * dt;
    }
    var fr = Math.exp(-0.7 * dt);
    ball.vx *= fr;
    ball.vy *= fr;
    var sp = Math.hypot(ball.vx, ball.vy);
    var maxSp = g.fw * 2.2;
    if (sp > maxSp) {
      ball.vx *= maxSp / sp;
      ball.vy *= maxSp / sp;
    }

    // A ball left dead between rods gets a nudge, as if someone bumped the table.
    ball.idle = sp < g.fw * 0.03 && !pointer.active ? ball.idle + dt : 0;
    if (ball.idle > 1.2) {
      ball.vx += (Math.random() - 0.5) * g.fw * 0.5;
      ball.vy += (Math.random() - 0.5) * g.fh * 1.5;
      ball.idle = 0;
    }

    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // Side walls; the end walls have a goal mouth in the middle.
    if (ball.y - g.br < g.top) { ball.y = g.top + g.br; ball.vy = Math.abs(ball.vy) * 0.85; }
    if (ball.y + g.br > g.bottom) { ball.y = g.bottom - g.br; ball.vy = -Math.abs(ball.vy) * 0.85; }
    var inMouth = Math.abs(ball.y - g.cy) < g.goal - g.br * 0.5;
    if (ball.x - g.br < g.left) {
      if (inMouth && ball.x < g.left - g.br * 0.5) return goal(1);
      if (!inMouth) { ball.x = g.left + g.br; ball.vx = Math.abs(ball.vx) * 0.85; }
    }
    if (ball.x + g.br > g.right) {
      if (inMouth && ball.x > g.right + g.br * 0.5) return goal(0);
      if (!inMouth) { ball.x = g.right - g.br; ball.vx = -Math.abs(ball.vx) * 0.85; }
    }

    rods.forEach(function (rod) { stepRod(rod, dt); });
  }

  function stepRod(rod, dt) {
    rod.cool = Math.max(0, rod.cool - dt);
    if (rod.kick >= 0) {
      rod.kick += dt;
      if (rod.kick > KICK_TIME) rod.kick = -1;
    }

    // Line up whichever man can get to the ball's (slightly anticipated) line soonest.
    var aimY = ball.y + ball.vy * 0.08;
    var best = null;
    for (var i = 0; i < rod.n; i++) {
      var base = g.cy + (i - (rod.n - 1) / 2) * rod.s;
      var want = clamp(aimY - base, -rod.maxOff, rod.maxOff);
      var miss = Math.abs(aimY - base - want);
      var travel = Math.abs(want - rod.off);
      if (!best || miss < best.miss - 0.5 || (Math.abs(miss - best.miss) <= 0.5 && travel < best.travel)) {
        best = { want: want, miss: miss, travel: travel };
      }
    }
    var maxMove = g.fh * 2.4 * dt; // rods are quick but beatable
    var prevOff = rod.off;
    rod.off += clamp(best.want - rod.off, -maxMove, maxMove);
    var rodVy = (rod.off - prevOff) / dt;

    var dir = TEAM[rod.team].dir;
    for (var j = 0; j < rod.n; j++) {
      var my = manY(rod, j);
      var dx = ball.x - rod.x;
      var dy = ball.y - my;

      // Kick when the ball is in reach in front of the man. Behind him it can
      // only bounce off, so you can sneak the ball past the goalie.
      if (rod.cool === 0 && Math.abs(dy) < g.pr + g.br && dx * dir > -g.pr * 0.5 && Math.abs(dx) < g.pr + g.br + g.reach) {
        rod.kick = 0;
        rod.cool = 0.45;
        var power = g.fw * (0.9 + Math.random() * 0.6);
        ball.vx = dir * power;
        ball.vy = (dy / (g.pr + g.br)) * power * 0.45 + (Math.random() - 0.5) * power * 0.3;
        ball.x = rod.x + dir * (g.pr + g.br + 1);
        ball.stun = STUN_TIME;
        continue;
      }

      // Otherwise the men are solid: bounce off them.
      var d = Math.hypot(dx, dy);
      var min = g.pr + g.br;
      if (d < min && d > 0.001) {
        var nx = dx / d;
        var ny = dy / d;
        ball.x = rod.x + nx * min;
        ball.y = my + ny * min;
        var rel = ball.vx * nx + (ball.vy - rodVy) * ny;
        if (rel < 0) {
          ball.vx -= 1.8 * rel * nx;
          ball.vy -= 1.8 * rel * ny;
        }
      }
    }
  }

  function goal(team) {
    score[team]++;
    freeze = 1.3 * SPEED; // in game time; 1.3s real, matching the banner
    ball.vx = ball.vy = 0;
    if (scoreEl) scoreEl.textContent = TEAM[0].name + " " + score[0] + " : " + score[1] + " " + TEAM[1].name;
    var banner = document.createElement("div");
    banner.className = "fb-goal-banner";
    banner.style.color = TEAM[team].body;
    banner.textContent = "GOAL!";
    wrap.appendChild(banner);
    wrap.classList.remove("fb-shake");
    void wrap.offsetWidth; // restart the shake animation
    wrap.classList.add("fb-shake");
    setTimeout(function () { banner.remove(); }, 1300);
  }

  // ---- drawing -------------------------------------------------------------

  function draw() {
    var w = g.w;
    var h = g.h;
    ctx.clearRect(0, 0, w, h);

    // Felt with mowing stripes.
    ctx.fillStyle = "#2f8a3c";
    roundRect(0, 0, w, h, 10);
    ctx.fill();
    ctx.save();
    roundRect(g.left, g.top, g.fw, g.fh, 4);
    ctx.clip();
    for (var i = 0; i < 12; i++) {
      ctx.fillStyle = i % 2 ? "#349a43" : "#2f8a3c";
      ctx.fillRect(g.left + (i * g.fw) / 12, g.top, g.fw / 12 + 1, g.fh);
    }
    ctx.restore();

    // Markings.
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 2;
    ctx.strokeRect(g.left, g.top, g.fw, g.fh);
    ctx.beginPath();
    ctx.moveTo(g.cx, g.top);
    ctx.lineTo(g.cx, g.bottom);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.fh * 0.17, 0, Math.PI * 2);
    ctx.stroke();
    var boxW = g.fw * 0.06;
    var boxH = g.goal * 2.6;
    ctx.strokeRect(g.left, g.cy - boxH / 2, boxW, boxH);
    ctx.strokeRect(g.right - boxW, g.cy - boxH / 2, boxW, boxH);

    // Goals.
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(g.left - 8, g.cy - g.goal, 8, g.goal * 2);
    ctx.fillRect(g.right, g.cy - g.goal, 8, g.goal * 2);

    // Ball shadow goes under the rods.
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath();
    ctx.ellipse(ball.x + 2, ball.y + 3, g.br, g.br * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();

    rods.forEach(drawRod);

    if (freeze <= 0) drawBall();
  }

  function drawRod(rod) {
    var grad = ctx.createLinearGradient(rod.x - 3, 0, rod.x + 3, 0);
    grad.addColorStop(0, "#8c939b");
    grad.addColorStop(0.5, "#e8ecef");
    grad.addColorStop(1, "#7a8188");
    ctx.fillStyle = grad;
    ctx.fillRect(rod.x - 2.5, 0, 5, g.h);

    var team = TEAM[rod.team];
    var t = rod.kick >= 0 ? Math.sin((Math.PI * rod.kick) / KICK_TIME) : 0;
    for (var i = 0; i < rod.n; i++) {
      var y = manY(rod, i);
      var pr = g.pr;

      // Kick: the foot swings out toward the goal and the body stretches with it.
      if (t > 0) {
        ctx.fillStyle = team.dark;
        var fx = rod.x + team.dir * pr * 0.4;
        var len = pr * 1.6 * t;
        ctx.fillRect(team.dir > 0 ? fx : fx - len, y - pr * 0.3, len, pr * 0.6);
      }
      ctx.save();
      ctx.translate(rod.x, y);
      ctx.scale(1 + 0.35 * t, 1);
      ctx.fillStyle = team.body;
      ctx.strokeStyle = team.dark;
      ctx.lineWidth = 1.5;
      roundRect(-pr * 0.7, -pr * 1.05, pr * 1.4, pr * 2.1, pr * 0.5);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      var img = rod.men[i] && rod.men[i].img;
      var hr = pr * 0.78;
      ctx.save();
      ctx.beginPath();
      ctx.arc(rod.x, y, hr, 0, Math.PI * 2);
      if (img && img.complete && img.naturalWidth) {
        ctx.clip();
        ctx.drawImage(img, rod.x - hr, y - hr, hr * 2, hr * 2);
      } else {
        ctx.fillStyle = "#f2c9a0";
        ctx.fill();
      }
      ctx.restore();
      ctx.beginPath();
      ctx.arc(rod.x, y, hr, 0, Math.PI * 2);
      ctx.strokeStyle = team.dark;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  function drawBall() {
    var r = g.br;
    var grad = ctx.createRadialGradient(ball.x - r * 0.35, ball.y - r * 0.35, r * 0.1, ball.x, ball.y, r);
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(1, "#d9d4c7");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---- loop and input ------------------------------------------------------

  function frame(now) {
    if (!running) return;
    var dt = Math.min((now - last) / 1000, 1 / 30) * SPEED;
    last = now;
    // Two substeps keep a fast ball from tunnelling through the men.
    step(dt / 2);
    step(dt / 2);
    draw();
    requestAnimationFrame(frame);
  }

  function updateRunning() {
    var should = visible && !document.hidden && !reduceMotion.matches;
    if (should && !running) {
      running = true;
      last = performance.now();
      requestAnimationFrame(frame);
    } else if (!should) {
      running = false;
      draw();
    }
  }

  function setPointer(e) {
    var r = canvas.getBoundingClientRect();
    // Past the end walls is allowed, so you can drag the ball into a goal yourself.
    pointer.x = clamp(e.clientX - r.left, 0, g.w);
    pointer.y = clamp(e.clientY - r.top, g.top, g.bottom);
    pointer.active = true;
  }

  canvas.addEventListener("pointermove", setPointer);
  canvas.addEventListener("pointerdown", setPointer);
  canvas.addEventListener("pointerleave", function () { pointer.active = false; });
  canvas.addEventListener("pointerup", function (e) { if (e.pointerType !== "mouse") pointer.active = false; });
  canvas.addEventListener("pointercancel", function () { pointer.active = false; });

  document.addEventListener("visibilitychange", updateRunning);
  if (reduceMotion.addEventListener) reduceMotion.addEventListener("change", updateRunning);
  if (window.IntersectionObserver) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      updateRunning();
    }).observe(wrap);
  }
  if (window.ResizeObserver) new ResizeObserver(function () { if (wrap.clientWidth !== g.w) layout(); }).observe(wrap);
  else window.addEventListener("resize", layout);

  // Profile photos from the ladder, best-ranked first.
  var imgCache = {};
  document.addEventListener("foos:players", function (e) {
    heads = e.detail.filter(function (p) { return p.photo; }).map(function (p) {
      var c = imgCache[p.uid];
      if (!c || c.src !== p.photo) {
        var img = new Image();
        img.onload = function () { if (!running) draw(); };
        img.src = p.photo;
        c = imgCache[p.uid] = { src: p.photo, img: img };
      }
      return { uid: p.uid, img: c.img };
    });
    assignHeads();
    if (!running) draw();
  });

  layout();
  updateRunning();
})();
