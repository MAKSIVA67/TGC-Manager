// TCG Manager -- live 3D match arena.
//
// Replaces the old "watch four zone comparisons resolve on a timer" match with
// a real, playable game: you control one outfield player, everyone else is AI,
// and the scoreline comes from goals you actually score.
//
// Architecture notes (these matter if you touch this file):
//
// 1. The arena mounts into its OWN fixed-position overlay appended to
//    document.body -- deliberately NOT inside #stage. index.html's render()
//    does `stage.innerHTML = appHTML()` on every state change, which would
//    destroy a WebGL canvas and its GL context. Living outside #stage means
//    the scene survives arbitrary re-renders, and the engine owns its own
//    HUD DOM imperatively instead of going through appHTML().
// 2. Everything is procedural -- pitch lines are drawn into a CanvasTexture at
//    boot, players are capsules+spheres, "shadows" are flat dark ellipses.
//    The repo has zero 3D assets and no build step, so nothing here may
//    depend on an external file beyond the three.js CDN script itself.
// 3. Card `power` (the only stat cards actually have) is expanded into real
//    gameplay attributes in deriveAttrs() -- speed, shot, passing, tackling,
//    keeper reflex -- so a stronger squad genuinely plays better instead of
//    just winning a dice roll.
// 4. If three.js or WebGL is unavailable, available() returns false and
//    index.html silently falls back to the legacy timed zone reveal. The old
//    path is kept intact for exactly this reason -- never assume the 3D mode
//    can run.
"use strict";

(function () {

  // ---------------------------------------------------------------- constants

  // Real pitch proportions (metres). Using true dimensions keeps camera
  // framing, run distances and shot power all in sane human units.
  const PITCH_W = 68, PITCH_L = 105;
  const GOAL_W = 7.32, GOAL_H = 2.44, GOAL_DEPTH = 2.0;
  const BALL_R = 0.36;

  // My team defends -Z and attacks +Z. Opponent is the mirror.
  const MY_GOAL_Z = -PITCH_L / 2, OPP_GOAL_Z = PITCH_L / 2;

  const GRAVITY = -22;            // exaggerated so lofted balls come down fast
  const GROUND_FRICTION = 1.9;    // m/s^2 bleed on a rolling ball
  const AIR_DRAG = 0.06;
  const BOUNCE = 0.55;

  const POSSESS_R = 1.5;          // how close to take a loose ball
  const DRIBBLE_AHEAD = 0.95;     // ball sits this far in front of the carrier
  const TACKLE_R = 1.9;

  const TEAM_MY = "my", TEAM_OPP = "opp";

  // Per-position tuning applied on top of the power-derived baseline.
  const ROLE_MOD = {
    GK:  { speed: -0.12, shot: -0.25, pass: 0.00, tackle: 0.00, reflex: 0.35 },
    DEF: { speed: -0.04, shot: -0.12, pass: 0.02, tackle: 0.22, reflex: 0.00 },
    MID: { speed:  0.02, shot:  0.00, pass: 0.18, tackle: 0.06, reflex: 0.00 },
    FWD: { speed:  0.10, shot:  0.20, pass: 0.00, tackle: -0.06, reflex: 0.00 },
  };

  // ------------------------------------------------------------------- module

  const M = {};
  let THREE = null;
  // Sibling modules (own <script> tags, loaded before this one). Bound in
  // begin() rather than at parse time so script order can't bite us.
  let VIS = null, HUD = null;

  // Live match instance. Null between matches.
  let A = null;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }
  function dist(ax, az, bx, bz) { return Math.sqrt(dist2(ax, az, bx, bz)); }
  function lastName(n) { const p = String(n || "").trim().split(/\s+/); return p[p.length - 1] || "Player"; }

  // Turn a card's single `power` number into the spread of attributes a
  // real-time game needs. 60 power is "just about playable", 100 is elite --
  // the gap is deliberately meaningful but not so wide that a weak squad
  // can't win with good play.
  function deriveAttrs(card, position) {
    const power = (card && card.power) || 70;
    const n = clamp((power - 58) / 42, 0, 1);
    const mod = ROLE_MOD[position] || ROLE_MOD.MID;
    return {
      power: power,
      topSpeed: (6.4 + n * 3.0) * (1 + mod.speed),
      accel: 17 + n * 13,
      shotPower: (17 + n * 13) * (1 + mod.shot),
      shotAccuracy: clamp(0.42 + n * 0.46 + mod.shot * 0.3, 0.15, 0.96),
      passAccuracy: clamp(0.5 + n * 0.42 + mod.pass, 0.2, 0.98),
      control: 0.45 + n * 0.45,          // resists being tackled
      tackle: clamp(0.35 + n * 0.45 + mod.tackle, 0.1, 0.95),
      reflex: clamp(0.4 + n * 0.45 + mod.reflex, 0.2, 0.98),
      vision: 12 + n * 16,               // how far the AI looks for a pass
    };
  }

  // ---------------------------------------------------------------- available

  let webglOk = null;
  function hasWebGL() {
    if (webglOk !== null) return webglOk;
    try {
      const c = document.createElement("canvas");
      webglOk = !!(window.WebGLRenderingContext &&
        (c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl")));
    } catch (e) { webglOk = false; }
    return webglOk;
  }

  M.available = function () {
    if (!window.THREE) return false;
    if (!window.Match3DVisuals || !window.Match3DHud) return false;
    if (!hasWebGL()) return false;
    return true;
  };

  M.isRunning = function () { return !!A; };

  // Thin pass-throughs to the HUD module so the many call sites below stay
  // readable. HUD owns the DOM; this file only decides when to show things.
  function toast(a, msg, ms) { HUD.toast(a, msg, ms); }
  function banner(a, text, color, ms) { HUD.banner(a, text, color, ms); }
  function titleCard(a, title, sub, ms) { HUD.titleCard(a, title, sub, ms); }

  // ------------------------------------------------------------------- roster

  // Maps the {slotId: card} lineup shape (and buildSlots' percentage layout)
  // into world-space players. Reuses window.buildSlots so formation data has
  // exactly one definition in the codebase.
  function buildTeam(team, lineup, formationKey, colorHex, shared, scene) {
    const slots = (window.buildSlots ? window.buildSlots(formationKey, team) : []) || [];
    const out = [];
    slots.forEach((slot) => {
      const card = lineup ? lineup[slot.id] : null;
      // x% -> width axis, y% -> length axis (matches the 2D pitch overlay the
      // rest of the app draws, so formations "look" the same in 3D).
      const hx = (slot.x / 100 - 0.5) * PITCH_W;
      const hz = -((slot.y / 100) - 0.5) * PITCH_L;
      const attrs = deriveAttrs(card, slot.position);
      const rig = VIS.createPlayer(THREE, shared, colorHex, slot.position === "GK", out.length + 1);
      const mesh = rig.group;
      rig.phase = out.length * 1.7;   // desync the run cycles across the team
      mesh.position.set(hx, 0, hz);
      scene.add(mesh);
      out.push({
        team, slotId: slot.id, position: slot.position,
        card: card || { name: "Reserve", power: 62, rarity: "Common" },
        name: card ? card.name : "Reserve",
        attrs, mesh, rig,
        homeX: hx, homeZ: hz,
        x: hx, z: hz, vx: 0, vz: 0,
        facing: team === TEAM_MY ? 0 : Math.PI,
        isGK: slot.position === "GK",
        cooldown: 0,      // blocks instant re-tackle / re-shoot
        stun: 0,
      });
    });
    return out;
  }

  // ----------------------------------------------------------------- controls

  function bindControls(a) {
    const stick = { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0 };
    a.input = { mx: 0, mz: 0, sprint: false, shootHeld: 0, wantPass: false, wantShoot: 0 };

    const R = 56; // joystick travel in px

    function setKnob(dx, dy) {
      a.el.stickKnob.style.transform = "translate(" + dx + "px," + dy + "px)";
    }

    // Touch/mouse: the whole left 55% of the screen acts as a floating stick so
    // the thumb never has to find a fixed target mid-match.
    function isStickZone(x) { return x < window.innerWidth * 0.55; }

    function onDown(e) {
      const t = e.changedTouches ? e.changedTouches[0] : e;
      if (a.paused) return;
      if (isStickZone(t.clientX) && !stick.active) {
        stick.active = true; stick.id = t.identifier != null ? t.identifier : "mouse";
        stick.ox = t.clientX; stick.oy = t.clientY;
        // Re-centre the visible base under the thumb.
        a.el.stickBase.style.left = (t.clientX - 62) + "px";
        a.el.stickBase.style.bottom = "auto";
        a.el.stickBase.style.top = (t.clientY - 62) + "px";
      }
    }
    function onMove(e) {
      const list = e.changedTouches ? e.changedTouches : [e];
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        const id = t.identifier != null ? t.identifier : "mouse";
        if (stick.active && id === stick.id) {
          let dx = t.clientX - stick.ox, dy = t.clientY - stick.oy;
          const len = Math.hypot(dx, dy);
          if (len > R) { dx = dx / len * R; dy = dy / len * R; }
          stick.dx = dx; stick.dy = dy;
          setKnob(dx, dy);
          const nx = dx / R, ny = dy / R;
          const mag = Math.min(1, Math.hypot(nx, ny));
          if (mag > 0.14) {
            const ang = Math.atan2(ny, nx);
            a.input.mx = Math.cos(ang) * mag;
            a.input.mz = Math.sin(ang) * mag;
          } else { a.input.mx = 0; a.input.mz = 0; }
        }
      }
    }
    function onUp(e) {
      const list = e.changedTouches ? e.changedTouches : [e];
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        const id = t.identifier != null ? t.identifier : "mouse";
        if (stick.active && id === stick.id) {
          stick.active = false; stick.dx = stick.dy = 0;
          a.input.mx = 0; a.input.mz = 0;
          setKnob(0, 0);
        }
      }
    }

    a.handlers = { onDown, onMove, onUp };
    const root = a.root;
    root.addEventListener("touchstart", onDown, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: true });
    root.addEventListener("touchend", onUp, { passive: true });
    root.addEventListener("touchcancel", onUp, { passive: true });
    root.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    // Buttons. Shoot charges while held; releasing fires with that power.
    const press = (el, down, up) => {
      const d = (e) => { e.preventDefault(); e.stopPropagation(); down(); };
      const u = (e) => { e.preventDefault(); e.stopPropagation(); if (up) up(); };
      el.addEventListener("touchstart", d, { passive: false });
      el.addEventListener("touchend", u, { passive: false });
      el.addEventListener("mousedown", d);
      el.addEventListener("mouseup", u);
    };
    press(a.el.btnPass, () => { a.input.wantPass = true; });
    press(a.el.btnSprint, () => { a.input.sprint = true; }, () => { a.input.sprint = false; });
    press(a.el.btnShoot,
      () => { a.input.shootHeld = 0.0001; a.el.powerRing.style.opacity = "1"; },
      () => {
        a.input.wantShoot = clamp(a.input.shootHeld / 0.62, 0.35, 1);
        a.input.shootHeld = 0;
        a.el.powerRing.style.opacity = "0";
      });

    // Keyboard for desktop play/testing.
    const keys = a.keys = {};
    a.onKeyDown = (e) => {
      if (!A) return;
      const k = e.key.toLowerCase();
      keys[k] = true;
      if (k === " " && !a.spaceDown) { a.spaceDown = true; a.input.shootHeld = 0.0001; a.el.powerRing.style.opacity = "1"; }
      if (k === "x" || k === "e") a.input.wantPass = true;
      if (k === "escape" || k === "p") togglePause(a);
      if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].indexOf(k) >= 0) e.preventDefault();
    };
    a.onKeyUp = (e) => {
      if (!A) return;
      const k = e.key.toLowerCase();
      keys[k] = false;
      if (k === " ") {
        a.spaceDown = false;
        a.input.wantShoot = clamp(a.input.shootHeld / 0.62, 0.35, 1);
        a.input.shootHeld = 0;
        a.el.powerRing.style.opacity = "0";
      }
    };
    window.addEventListener("keydown", a.onKeyDown);
    window.addEventListener("keyup", a.onKeyUp);

    a.el.pause.addEventListener("click", (e) => { e.stopPropagation(); togglePause(a); });
    a.el.resumeBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePause(a, false); });
    a.el.quitBtn.addEventListener("click", (e) => { e.stopPropagation(); forfeit(a); });

    a.onResize = () => {
      if (!A) return;
      const w = window.innerWidth, hh = window.innerHeight;
      a.renderer.setSize(w, hh, false);
      a.camera.aspect = w / hh;
      a.camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", a.onResize);
    window.addEventListener("orientationchange", a.onResize);
  }

  // Merge keyboard into the same movement vector the stick writes.
  function readKeyboard(a) {
    const k = a.keys;
    if (!k) return;
    let kx = 0, kz = 0;
    if (k["a"] || k["arrowleft"]) kx -= 1;
    if (k["d"] || k["arrowright"]) kx += 1;
    if (k["w"] || k["arrowup"]) kz -= 1;
    if (k["s"] || k["arrowdown"]) kz += 1;
    if (kx || kz) {
      const l = Math.hypot(kx, kz);
      a.input.mx = kx / l; a.input.mz = kz / l;
    }
    a.input.sprint = a.input.sprint || !!(k["shift"] || k["shiftkey"]);
  }

  function togglePause(a, force) {
    const want = force === undefined ? !a.paused : force;
    a.paused = want;
    a.el.pauseSheet.style.display = want ? "flex" : "none";
    if (!want) a.last = performance.now();
  }

  function forfeit(a) {
    // Treated as a normal full-time with whatever the score is -- the result
    // still commits, so quitting can't be used to dodge a loss.
    a.forfeited = true;
    endMatch(a);
  }

  // -------------------------------------------------------------- ball & play

  function resetKickoff(a, towardTeam) {
    a.ball.x = 0; a.ball.y = BALL_R; a.ball.z = 0;
    a.ball.vx = 0; a.ball.vy = 0; a.ball.vz = 0;
    a.ball.owner = null;
    a.players.forEach((p) => {
      p.x = p.homeX; p.z = p.homeZ; p.vx = 0; p.vz = 0; p.stun = 0; p.cooldown = 0;
    });
    // The conceding side restarts, so nudge one of their midfielders onto it.
    const starters = a.players.filter((p) => p.team === towardTeam && p.position === "MID");
    if (starters.length) {
      const s = starters[0];
      s.x = -0.6; s.z = towardTeam === TEAM_MY ? -1.2 : 1.2;
      a.ball.owner = s;
    }
    a.kickoffFreeze = 0.9;
  }

  function possessionChange(a, p) {
    a.ball.owner = p;
    a.ball.vx = a.ball.vy = a.ball.vz = 0;
    p.cooldown = 0.25;
  }

  function attackDirZ(team) { return team === TEAM_MY ? 1 : -1; }
  function goalZFor(team) { return team === TEAM_MY ? OPP_GOAL_Z : MY_GOAL_Z; }

  // Shot: aim at the goal mouth, with spray scaled by accuracy, distance and
  // whether the shooter was under pressure.
  function shoot(a, p, powerFrac, pressure) {
    const gz = goalZFor(p.team);
    const d = dist(p.x, p.z, 0, gz);
    const acc = p.attrs.shotAccuracy * (1 - clamp(pressure, 0, 0.55)) * clamp(1.25 - d / 46, 0.35, 1.1);
    // Pick a target inside the goal, biased away from the keeper.
    const gk = a.players.find((q) => q.team !== p.team && q.isGK);
    let aimX = rand(-GOAL_W / 2 + 0.5, GOAL_W / 2 - 0.5);
    if (gk) aimX = gk.x > 0 ? rand(-GOAL_W / 2 + 0.4, -0.3) : rand(0.3, GOAL_W / 2 - 0.4);
    const spray = (1 - acc) * 7.5;
    aimX += rand(-spray, spray);
    const aimY = clamp(rand(0.35, GOAL_H - 0.35) + rand(-spray, spray) * 0.35, 0.15, GOAL_H + 1.6);

    const dx = aimX - p.x, dz = gz - p.z;
    const flat = Math.hypot(dx, dz) || 1;
    const speed = p.attrs.shotPower * (0.55 + powerFrac * 0.6);
    a.ball.owner = null;
    a.ball.x = p.x + (dx / flat) * 0.7;
    a.ball.z = p.z + (dz / flat) * 0.7;
    a.ball.y = BALL_R + 0.15;
    a.ball.vx = (dx / flat) * speed;
    a.ball.vz = (dz / flat) * speed;
    // Loft proportional to distance so long-range efforts arc.
    a.ball.vy = clamp(aimY / Math.max(1, d) * speed * 0.55 + d * 0.045, 0.4, 9);
    p.cooldown = 0.5;
    a.lastTouch = p;
    a.stat[p.team].shots++;
    if (window.playKick) window.playKick();
  }

  // Pass: choose the best forward option in vision range, weight by openness.
  function bestPassTarget(a, p) {
    const mates = a.players.filter((q) => q !== p && q.team === p.team && !q.isGK);
    const dir = attackDirZ(p.team);
    let best = null, bestScore = -1e9;
    mates.forEach((q) => {
      const d = dist(p.x, p.z, q.x, q.z);
      if (d < 3 || d > p.attrs.vision + 8) return;
      // Nearest opponent to the receiver -- don't pass into trouble.
      let press = 99;
      a.players.forEach((o) => {
        if (o.team === p.team) return;
        press = Math.min(press, dist(o.x, o.z, q.x, q.z));
      });
      const forward = (q.z - p.z) * dir;
      const score = forward * 1.5 + press * 1.2 - d * 0.35 + q.attrs.power * 0.04;
      if (score > bestScore) { bestScore = score; best = q; }
    });
    return best;
  }

  function pass(a, p, target) {
    if (!target) return false;
    const acc = p.attrs.passAccuracy;
    const d = dist(p.x, p.z, target.x, target.z);
    // Lead the receiver slightly; misplace it by an accuracy-scaled offset.
    const leadX = target.x + target.vx * 0.28 + rand(-1, 1) * (1 - acc) * d * 0.3;
    const leadZ = target.z + target.vz * 0.28 + rand(-1, 1) * (1 - acc) * d * 0.3;
    const dx = leadX - p.x, dz = leadZ - p.z;
    const flat = Math.hypot(dx, dz) || 1;
    const speed = clamp(d * 1.5 + 7, 9, 26);
    a.ball.owner = null;
    a.ball.x = p.x + (dx / flat) * 0.7;
    a.ball.z = p.z + (dz / flat) * 0.7;
    a.ball.y = BALL_R + 0.1;
    a.ball.vx = (dx / flat) * speed;
    a.ball.vz = (dz / flat) * speed;
    a.ball.vy = d > 18 ? 3.4 : 0.5;
    p.cooldown = 0.32;
    a.lastTouch = p;
    a.stat[p.team].passes++;
    if (window.playTap) window.playTap();
    return true;
  }

  // ------------------------------------------------------------------ AI step

  function aiControlled(a, p, dt) {
    // The AI carrying the ball: shoot if it's on, otherwise pass or drive.
    const gz = goalZFor(p.team);
    const dGoal = dist(p.x, p.z, 0, gz);
    let press = 99;
    a.players.forEach((o) => { if (o.team !== p.team) press = Math.min(press, dist(o.x, o.z, p.x, p.z)); });

    if (p.cooldown <= 0) {
      const shootRange = 15 + p.attrs.shotPower * 0.6;
      if (dGoal < shootRange && Math.random() < 0.035 + (1 - dGoal / shootRange) * 0.09) {
        shoot(a, p, rand(0.6, 1), clamp((3.5 - press) / 3.5, 0, 1));
        return;
      }
      // Under pressure, or occasionally by choice, move it on.
      const wantsOut = press < 3.2 ? 0.14 : 0.022;
      if (Math.random() < wantsOut) {
        const t = bestPassTarget(a, p);
        if (t && pass(a, p, t)) return;
      }
    }
    // Drive at goal, veering away from the closest defender.
    const dir = attackDirZ(p.team);
    let tx = clamp(p.x * 0.7, -PITCH_W / 2 + 4, PITCH_W / 2 - 4);
    let tz = p.z + dir * 14;
    let near = null, nd = 99;
    a.players.forEach((o) => {
      if (o.team === p.team) return;
      const d = dist(o.x, o.z, p.x, p.z);
      if (d < nd) { nd = d; near = o; }
    });
    if (near && nd < 5) tx += (p.x - near.x) > 0 ? 5 : -5;
    steer(p, tx, tz, dt, 1);
  }

  function aiOffBall(a, p, dt) {
    const b = a.ball;
    const owner = b.owner;
    const myTeamHasIt = owner && owner.team === p.team;
    const dir = attackDirZ(p.team);

    if (p.isGK) {
      // Keeper hugs the line, shading toward the ball's side; comes a little
      // off the line when the ball is close.
      const gz = p.team === TEAM_MY ? MY_GOAL_Z : OPP_GOAL_Z;
      const ballSide = clamp(b.x * 0.55, -GOAL_W / 2 - 1.2, GOAL_W / 2 + 1.2);
      const dBall = dist(b.x, b.z, p.x, gz);
      const off = dBall < 18 ? clamp((18 - dBall) * 0.22, 0, 4.5) : 0;
      steer(p, ballSide, gz - (p.team === TEAM_MY ? -off : off), dt, 1.05);
      return;
    }

    // Formation anchor slides with the ball so shape stays coherent.
    const shift = clamp((b.z - 0) * 0.32, -14, 14);
    const push = myTeamHasIt ? dir * 7 : -dir * 3;
    let tx = lerp(p.homeX, clamp(b.x * 0.55, -PITCH_W / 2 + 3, PITCH_W / 2 - 3), 0.35);
    let tz = clamp(p.homeZ + shift + push, -PITCH_L / 2 + 3, PITCH_L / 2 - 3);

    const dBall = dist(p.x, p.z, b.x, b.z);
    if (!myTeamHasIt) {
      // Closest one or two defenders actually attack the ball.
      const mates = a.players.filter((q) => q.team === p.team && !q.isGK);
      const sorted = mates.slice().sort((q, r) => dist2(q.x, q.z, b.x, b.z) - dist2(r.x, r.z, b.x, b.z));
      const rank = sorted.indexOf(p);
      if (rank === 0) { tx = b.x; tz = b.z; }
      else if (rank === 1 && dBall < 24) { tx = lerp(tx, b.x, 0.6); tz = lerp(tz, b.z, 0.6); }
    } else if (dBall < 9) {
      // Give the carrier room rather than clustering on top of them.
      const ax = p.x - b.x, az = p.z - b.z;
      const l = Math.hypot(ax, az) || 1;
      tx = b.x + (ax / l) * 9; tz = b.z + (az / l) * 9 + dir * 3;
    }
    steer(p, tx, tz, dt, myTeamHasIt ? 0.86 : 0.97);
  }

  function steer(p, tx, tz, dt, speedScale) {
    const dx = tx - p.x, dz = tz - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) { p.vx *= 0.82; p.vz *= 0.82; return; }
    const want = p.attrs.topSpeed * (speedScale == null ? 1 : speedScale);
    const ux = dx / d, uz = dz / d;
    // Ease off as we arrive so players don't jitter around their anchor.
    const target = Math.min(want, d > 1.4 ? want : want * 0.35);
    p.vx += (ux * target - p.vx) * Math.min(1, p.attrs.accel * dt / Math.max(1, want));
    p.vz += (uz * target - p.vz) * Math.min(1, p.attrs.accel * dt / Math.max(1, want));
  }

  // ------------------------------------------------------------- physics step

  function stepPlayers(a, dt) {
    a.players.forEach((p) => {
      p.cooldown = Math.max(0, p.cooldown - dt);
      p.stun = Math.max(0, p.stun - dt);

      if (p === a.controlled && !a.kickoffFreeze) {
        // Human input. Screen-space stick maps into camera-relative movement
        // so "up" is always "toward the goal you're attacking".
        const inp = a.input;
        const sprint = inp.sprint ? 1.16 : 1;
        const want = p.attrs.topSpeed * sprint;
        const mag = Math.hypot(inp.mx, inp.mz);
        if (mag > 0.05 && p.stun <= 0) {
          // Camera looks down +Z for my team, so stick-up (-y) = +Z.
          const fx = inp.mx, fz = inp.mz;
          const l = Math.hypot(fx, fz) || 1;
          const tvx = (fx / l) * want * Math.min(1, mag);
          const tvz = (fz / l) * want * Math.min(1, mag);
          p.vx += (tvx - p.vx) * Math.min(1, p.attrs.accel * 1.25 * dt / Math.max(1, want));
          p.vz += (tvz - p.vz) * Math.min(1, p.attrs.accel * 1.25 * dt / Math.max(1, want));
        } else {
          p.vx *= Math.max(0, 1 - 7 * dt); p.vz *= Math.max(0, 1 - 7 * dt);
        }
      } else if (p.stun > 0) {
        p.vx *= Math.max(0, 1 - 6 * dt); p.vz *= Math.max(0, 1 - 6 * dt);
      } else if (a.kickoffFreeze > 0) {
        p.vx *= 0.9; p.vz *= 0.9;
      } else if (a.ball.owner === p) {
        aiControlled(a, p, dt);
      } else {
        aiOffBall(a, p, dt);
      }

      p.x += p.vx * dt; p.z += p.vz * dt;
      // Keep everyone on (or just off) the field of play.
      p.x = clamp(p.x, -PITCH_W / 2 - 1.5, PITCH_W / 2 + 1.5);
      p.z = clamp(p.z, -PITCH_L / 2 - 3, PITCH_L / 2 + 3);

      const sp = Math.hypot(p.vx, p.vz);
      if (sp > 0.4) p.facing = Math.atan2(p.vx, p.vz);

      // Position/orientation are the sim's business; the pose belongs to the
      // visuals module, which owns whatever rig it decided to build.
      p.mesh.position.x = p.x; p.mesh.position.z = p.z;
      p.mesh.rotation.y = p.facing;
      VIS.animatePlayer(p.rig, {
        speed: sp, facing: p.facing, t: a.t,
        kicking: p.cooldown > 0.28,
        stunned: p.stun > 0,
        hasBall: a.ball.owner === p,
        controlled: p === a.controlled,
      });
    });
  }

  function stepBall(a, dt) {
    const b = a.ball;

    if (b.owner) {
      const o = b.owner;
      // Dribble: ball rides just ahead of the carrier's facing.
      const tx = o.x + Math.sin(o.facing) * DRIBBLE_AHEAD;
      const tz = o.z + Math.cos(o.facing) * DRIBBLE_AHEAD;
      b.x = lerp(b.x, tx, Math.min(1, 16 * dt));
      b.z = lerp(b.z, tz, Math.min(1, 16 * dt));
      b.y = BALL_R + Math.abs(Math.sin(a.t * 9)) * 0.07;
      b.vx = o.vx; b.vz = o.vz; b.vy = 0;
    } else {
      b.vy += GRAVITY * dt;
      const sp = Math.hypot(b.vx, b.vz);
      if (b.y <= BALL_R + 0.001 && sp > 0.01) {
        const f = Math.min(sp, GROUND_FRICTION * dt);
        b.vx -= (b.vx / sp) * f; b.vz -= (b.vz / sp) * f;
      }
      b.vx *= (1 - AIR_DRAG * dt); b.vz *= (1 - AIR_DRAG * dt);
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
      if (b.y < BALL_R) {
        b.y = BALL_R;
        if (b.vy < -1.2) { b.vy = -b.vy * BOUNCE; } else { b.vy = 0; }
      }
    }

    // Rolling spin, purely visual.
    a.ballMesh.position.set(b.x, b.y, b.z);
    a.ballMesh.rotation.x -= b.vz * dt / BALL_R;
    a.ballMesh.rotation.z += b.vx * dt / BALL_R;
    a.ballShadow.position.set(b.x, 0.03, b.z);
    const shScale = clamp(1 - (b.y - BALL_R) * 0.08, 0.45, 1);
    a.ballShadow.scale.setScalar(shScale);
  }

  function stepPossession(a, dt) {
    const b = a.ball;
    if (a.kickoffFreeze > 0) return;

    if (b.owner) {
      // Tackling: any nearby opponent can win it, weighted control vs tackle.
      a.players.forEach((o) => {
        if (o.team === b.owner.team || o.cooldown > 0 || o.stun > 0) return;
        const d = dist(o.x, o.z, b.owner.x, b.owner.z);
        if (d > TACKLE_R) return;
        const odds = (o.attrs.tackle * 1.15) / (o.attrs.tackle * 1.15 + b.owner.attrs.control);
        // Human-controlled players get a small break so it doesn't feel unfair.
        const bias = b.owner === a.controlled ? 0.78 : 1;
        if (Math.random() < odds * bias * dt * 3.2) {
          const beaten = b.owner;
          beaten.stun = 0.28; beaten.cooldown = 0.4;
          possessionChange(a, o);
          a.lastTouch = o;
          if (o.team === TEAM_MY) toast(a, "🦶 " + lastName(o.name) + " wins it back!");
          if (window.playZoneWin && o.team === TEAM_MY) window.playZoneWin();
        }
      });
      return;
    }

    // Loose ball: closest eligible player inside the pickup radius takes it,
    // keepers get a bigger reach (that's their whole job).
    let best = null, bd = 1e9;
    a.players.forEach((p) => {
      if (p.cooldown > 0 || p.stun > 0) return;
      const r = p.isGK ? POSSESS_R + 1.5 * p.attrs.reflex : POSSESS_R;
      if (b.y > 2.2 && !p.isGK) return;            // can't collect a high ball
      const d = dist(p.x, p.z, b.x, b.z);
      if (d < r && d < bd) { bd = d; best = p; }
    });
    if (best) {
      const wasShot = Math.hypot(b.vx, b.vz) > 12;
      if (best.isGK && wasShot) {
        // Save: strong keepers hold it, weaker ones parry.
        if (Math.random() < best.attrs.reflex) {
          possessionChange(a, best);
          toast(a, "🧤 Save by " + lastName(best.name) + "!");
          a.stat[best.team].saved++;   // credited to the keeper's own team
        } else {
          b.vx *= -0.35; b.vz *= -0.35; b.vy = 3.2;
          best.cooldown = 0.4;
          toast(a, "🧤 Parried!");
        }
        return;
      }
      possessionChange(a, best);
    }
  }

  function stepBounds(a) {
    const b = a.ball;
    if (b.owner) return;

    // Goal check first -- crossing the line inside the frame beats any
    // out-of-play handling.
    const inMouth = Math.abs(b.x) < GOAL_W / 2 && b.y < GOAL_H + 0.15;
    if (b.z > OPP_GOAL_Z && b.z < OPP_GOAL_Z + GOAL_DEPTH + 1 && inMouth) { onGoal(a, TEAM_MY); return; }
    if (b.z < MY_GOAL_Z && b.z > MY_GOAL_Z - GOAL_DEPTH - 1 && inMouth) { onGoal(a, TEAM_OPP); return; }

    // Out of play. Kept deliberately simple/arcade: hand it to the team that
    // didn't touch it last, near where it left, and play on. No throw-in
    // animation, no stoppage -- a phone match can't afford dead time.
    const outSide = Math.abs(b.x) > PITCH_W / 2 + 0.4;
    const outEnd = Math.abs(b.z) > PITCH_L / 2 + 0.4;
    if (!outSide && !outEnd) return;

    const lastTeam = a.lastTouch ? a.lastTouch.team : TEAM_OPP;
    const giveTo = lastTeam === TEAM_MY ? TEAM_OPP : TEAM_MY;
    let rx = clamp(b.x, -PITCH_W / 2 + 1.5, PITCH_W / 2 - 1.5);
    let rz = clamp(b.z, -PITCH_L / 2 + 3, PITCH_L / 2 - 3);
    if (outEnd) {
      // Goal kick for the defending side / corner-ish restart otherwise.
      const conceding = b.z > 0 ? TEAM_OPP : TEAM_MY;
      if (giveTo === conceding) { rx = 0; rz = (b.z > 0 ? PITCH_L / 2 - 8 : -PITCH_L / 2 + 8); }
      else { rx = b.x > 0 ? PITCH_W / 2 - 2 : -PITCH_W / 2 + 2; }
    }
    b.x = rx; b.z = rz; b.y = BALL_R;
    b.vx = b.vy = b.vz = 0;
    // Nearest player from the receiving side picks it up.
    let cand = null, cd = 1e9;
    a.players.forEach((p) => {
      if (p.team !== giveTo || p.isGK) return;
      const d = dist(p.x, p.z, rx, rz);
      if (d < cd) { cd = d; cand = p; }
    });
    if (cand) { cand.x = rx - 0.8; cand.z = rz; possessionChange(a, cand); }
    toast(a, giveTo === TEAM_MY ? "Ball to you" : "Their throw", 1100);
  }

  function onGoal(a, team) {
    a.score[team]++;
    HUD.setScore(a, a.score.my, a.score.opp);
    const scorer = a.lastTouch && a.lastTouch.team === team ? lastName(a.lastTouch.name) : null;
    if (team === TEAM_MY) {
      banner(a, "GOAL!", "#2FD180", 1700);
      toast(a, scorer ? "⚽ " + scorer + " scores!" : "⚽ GOAL!", 2200);
      if (window.playWin) window.playWin();
    } else {
      banner(a, "CONCEDED", "#FB5A5A", 1500);
      toast(a, scorer ? "😖 " + scorer + " scores for them." : "😖 They score.", 2200);
      if (window.playLose) window.playLose();
    }
    resetKickoff(a, team === TEAM_MY ? TEAM_OPP : TEAM_MY);
  }

  // -------------------------------------------------------------- camera step

  function stepCamera(a, dt) {
    const b = a.ball;
    // Broadcast-ish chase cam: sits behind the action relative to the direction
    // my team attacks, rising and pulling back as the ball speeds up.
    //
    // The tilt is deliberately steep (~40 degrees down rather than a flat
    // touchline angle). Phones are tall and narrow, so a shallow camera spends
    // the top half of the frame on empty sky and shrinks the players to specks;
    // looking down harder fills the screen with pitch and keeps the ball and
    // the nearby run of play readable at thumb distance.
    const speed = Math.hypot(b.vx, b.vz);
    const back = 24 + clamp(speed * 0.45, 0, 8);
    const high = 14.5 + clamp(speed * 0.3, 0, 6);
    const lookAhead = clamp(b.vz * 0.3, -7, 7);

    const tx = clamp(b.x * 0.62, -PITCH_W / 2 + 8, PITCH_W / 2 - 8);
    const tz = b.z - back;
    a.camPos.x = lerp(a.camPos.x, tx, Math.min(1, 3.4 * dt));
    a.camPos.y = lerp(a.camPos.y, high, Math.min(1, 2.6 * dt));
    a.camPos.z = lerp(a.camPos.z, tz, Math.min(1, 3.4 * dt));
    a.camera.position.set(a.camPos.x, a.camPos.y, a.camPos.z);

    a.camLook.x = lerp(a.camLook.x, b.x * 0.75, Math.min(1, 5 * dt));
    a.camLook.y = lerp(a.camLook.y, Math.max(0.4, b.y * 0.5), Math.min(1, 5 * dt));
    a.camLook.z = lerp(a.camLook.z, b.z + lookAhead + 2.5, Math.min(1, 5 * dt));
    a.camera.lookAt(a.camLook.x, a.camLook.y, a.camLook.z);
  }

  // ---------------------------------------------------------- control switch

  // You always drive whoever is best placed: nearest my-team outfielder to the
  // ball, or the carrier if we have it. Switching is sticky (a small hysteresis
  // margin) so control doesn't flicker between two equidistant players.
  function updateControlled(a) {
    const b = a.ball;
    if (b.owner && b.owner.team === TEAM_MY) {
      setControlled(a, b.owner);
      return;
    }
    let best = null, bd = 1e9;
    a.players.forEach((p) => {
      if (p.team !== TEAM_MY || p.isGK) return;
      const d = dist2(p.x, p.z, b.x, b.z);
      if (d < bd) { bd = d; best = p; }
    });
    if (!best) return;
    if (a.controlled && a.controlled !== best) {
      const cd = dist2(a.controlled.x, a.controlled.z, b.x, b.z);
      if (cd < bd * 1.55) return;   // keep current unless clearly worse
    }
    setControlled(a, best);
  }

  function setControlled(a, p) {
    if (a.controlled === p) return;
    if (a.marker && a.controlled) a.controlled.mesh.remove(a.marker);
    a.controlled = p;
    if (a.marker) p.mesh.add(a.marker);
    a.el.nameplate.innerHTML =
      '<span style="color:' + a.myColor + '">●</span> ' + p.name +
      ' <span style="opacity:.6">' + p.position + " " + p.attrs.power + "</span>";
  }

  // ------------------------------------------------------------- clock / loop

  function frame(now) {
    if (!A) return;
    const a = A;
    a.raf = requestAnimationFrame(frame);

    let dt = (now - a.last) / 1000;
    a.last = now;
    if (a.paused) { a.renderer.render(a.scene, a.camera); return; }
    // Clamp so a backgrounded tab or a GC hitch can't teleport the sim.
    dt = Math.min(dt, 1 / 20);
    if (dt <= 0) return;
    a.t += dt;

    readKeyboard(a);
    if (a.input.shootHeld > 0) {
      a.input.shootHeld = Math.min(0.62, a.input.shootHeld + dt);
      const f = a.input.shootHeld / 0.62;
      a.el.powerRing.style.borderColor =
        f > 0.85 ? "#FB5A5A" : f > 0.5 ? "#FFB020" : "#2FD18066";
      a.el.powerRing.style.transform = "scale(" + (0.9 + f * 0.14) + ")";
    }

    if (a.kickoffFreeze > 0) {
      a.kickoffFreeze -= dt;
      if (a.kickoffFreeze <= 0) a.el.card.style.display = "none";
    }

    // Human actions are consumed once, on the frame after the button fires.
    const c = a.controlled;
    if (c && a.ball.owner === c && c.cooldown <= 0 && a.kickoffFreeze <= 0) {
      if (a.input.wantShoot > 0) {
        let press = 99;
        a.players.forEach((o) => { if (o.team !== c.team) press = Math.min(press, dist(o.x, o.z, c.x, c.z)); });
        shoot(a, c, a.input.wantShoot, clamp((3.5 - press) / 3.5, 0, 1));
        toast(a, "Shot!", 700);
      } else if (a.input.wantPass) {
        const t = bestPassTarget(a, c);
        if (t) { pass(a, c, t); toast(a, "→ " + lastName(t.name), 800); }
      }
    }
    a.input.wantShoot = 0; a.input.wantPass = false;

    stepPlayers(a, dt);
    stepBall(a, dt);
    stepPossession(a, dt);
    stepBounds(a);
    updateControlled(a);
    stepCamera(a, dt);

    // Match clock: each half runs halfSeconds of real time mapped to 45'.
    a.elapsed += dt;
    const minute = Math.min(45, Math.floor((a.elapsed / a.halfSeconds) * 45));
    const shown = (a.half === 1 ? 0 : 45) + minute;
    if (shown !== a.shownMinute) {
      a.shownMinute = shown;
      HUD.setClock(a, a.half, shown);
    }
    if (a.elapsed >= a.halfSeconds) { endHalf(a); return; }

    a.renderer.render(a.scene, a.camera);
  }

  function endHalf(a) {
    if (window.playWhistle) window.playWhistle();
    if (a.half === 1) {
      a.half = 2;
      a.running = false;
      cancelAnimationFrame(a.raf); a.raf = 0;
      titleCard(a, "HALF TIME", a.score.my + " - " + a.score.opp);
      hide(a);
      const cb = a.onHalfEnd;
      if (cb) cb(1, { my: a.score.my, opp: a.score.opp });
    } else {
      endMatch(a);
    }
  }

  function endMatch(a) {
    a.running = false;
    cancelAnimationFrame(a.raf); a.raf = 0;
    // Snapshot everything the caller needs BEFORE teardown() -- it nulls the
    // instance, so getScore()/getStats() are unavailable by the time the
    // callback runs.
    const score = {
      my: a.score.my, opp: a.score.opp,
      forfeited: a.forfeited,
      stat: { my: Object.assign({}, a.stat.my), opp: Object.assign({}, a.stat.opp) },
    };
    hide(a);
    const cb = a.onFullTime;
    teardown();
    if (cb) cb(score);
  }

  function hide(a) { if (a.root) a.root.style.display = "none"; }
  function show(a) { if (a.root) a.root.style.display = "block"; }

  // ------------------------------------------------------------------ public

  // Starts a fresh match and plays the first half. cfg:
  //   myLineup, oppLineup   {slotId: card}
  //   formationKey, oppFormationKey
  //   myName, myColor, oppName, oppColor
  //   halfSeconds           real seconds per half (default 75)
  //   onHalfEnd(half, score), onFullTime(score)
  M.begin = function (cfg) {
    if (!M.available()) return false;
    THREE = window.THREE;
    VIS = window.Match3DVisuals;
    HUD = window.Match3DHud;
    teardown();

    const myColor = cfg.myColor || "#52D68A";
    const oppColor = cfg.oppColor || "#FF6B6B";

    const a = {
      t: 0, elapsed: 0, half: 1, shownMinute: -1,
      halfSeconds: cfg.halfSeconds || 75,
      score: { my: 0, opp: 0 },
      stat: { my: { shots: 0, passes: 0, saved: 0 }, opp: { shots: 0, passes: 0, saved: 0 } },
      myName: cfg.myName || "My Team", oppName: cfg.oppName || "Opponent",
      myColor: myColor, oppColor: oppColor,
      onHalfEnd: cfg.onHalfEnd, onFullTime: cfg.onFullTime,
      formationKey: cfg.formationKey, oppFormationKey: cfg.oppFormationKey,
      el: {}, paused: false, running: true, forfeited: false,
      camPos: { x: 0, y: 16, z: -30 }, camLook: { x: 0, y: 0, z: 0 },
      kickoffFreeze: 1.4, lastTouch: null, controlled: null,
    };

    a.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    a.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    a.renderer.setSize(window.innerWidth, window.innerHeight, false);
    if (THREE.SRGBColorSpace) a.renderer.outputColorSpace = THREE.SRGBColorSpace;

    a.world = VIS.buildStadium(THREE, { shadows: a.quality !== "low" });
    a.scene = a.world.scene;
    // 46 degrees VERTICAL fov. three.js measures fov vertically, and phones are
    // tall -- the usual ~58 spans so much height that half the frame is sky and
    // the players shrink to specks. Narrower keeps them legible without having
    // to flatten the camera into a top-down view.
    a.camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.5, 400);

    a.shared = VIS.makeKitSet(THREE, myColor, oppColor);
    a.players = []
      .concat(buildTeam(TEAM_MY, cfg.myLineup, cfg.formationKey || "balanced", myColor, a.shared, a.scene))
      .concat(buildTeam(TEAM_OPP, cfg.oppLineup, cfg.oppFormationKey || "balanced", oppColor, a.shared, a.scene));

    // Ball + its shadow.
    a.ball = { x: 0, y: BALL_R, z: 0, vx: 0, vy: 0, vz: 0, owner: null };
    const ballParts = VIS.createBall(THREE);
    a.ballMesh = ballParts.mesh;
    a.ballShadow = ballParts.shadow;
    a.scene.add(a.ballMesh);
    a.scene.add(a.ballShadow);

    // Ring under the player you're driving.
    a.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.62, 0.82, 18),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(myColor), transparent: true, opacity: 0.9, side: THREE.DoubleSide })
    );
    a.marker.rotation.x = -Math.PI / 2;
    a.marker.position.y = 0.05;

    A = a;
    const built = HUD.build({
      canvas: a.renderer.domElement,
      myName: a.myName, myColor: a.myColor,
      oppName: a.oppName, oppColor: a.oppColor,
    });
    a.root = built.root; a.el = built.el;
    document.body.appendChild(a.root);
    bindControls(a);

    resetKickoff(a, TEAM_MY);
    a.kickoffFreeze = 1.4;
    updateControlled(a);
    titleCard(a, "KICK OFF", a.myName + "  vs  " + a.oppName, 1400);
    if (window.ensureAudio) window.ensureAudio();
    if (window.playWhistle) window.playWhistle();

    a.last = performance.now();
    a.raf = requestAnimationFrame(frame);
    return true;
  };

  // Resumes into the second half, optionally with a substituted lineup.
  M.resumeSecondHalf = function (newMyLineup) {
    const a = A;
    if (!a) return false;
    if (newMyLineup) {
      // Re-point existing my-team players at whatever card now occupies their
      // slot, so a halftime sub is reflected without rebuilding the scene.
      a.players.forEach((p) => {
        if (p.team !== TEAM_MY) return;
        const card = newMyLineup[p.slotId];
        if (!card) return;
        if (p.card && card.id === p.card.id) return;
        p.card = card; p.name = card.name;
        p.attrs = deriveAttrs(card, p.position);
      });
    }
    a.elapsed = 0; a.half = 2; a.shownMinute = -1;
    a.paused = false;
    a.el.pauseSheet.style.display = "none";
    show(a);
    resetKickoff(a, TEAM_OPP);
    a.kickoffFreeze = 1.4;
    updateControlled(a);
    titleCard(a, "2ND HALF", a.score.my + " - " + a.score.opp, 1400);
    if (window.playWhistle) window.playWhistle();
    a.last = performance.now();
    a.running = true;
    a.raf = requestAnimationFrame(frame);
    return true;
  };

  M.getScore = function () { return A ? { my: A.score.my, opp: A.score.opp } : null; };
  M.getStats = function () { return A ? JSON.parse(JSON.stringify(A.stat)) : null; };

  // Full teardown -- disposes GL resources and removes every listener. Called
  // on full time, on abort, and defensively at the start of every begin().
  function teardown() {
    const a = A;
    if (!a) return;
    A = null;
    if (a.raf) cancelAnimationFrame(a.raf);
    clearTimeout(a.toastTimer); clearTimeout(a.bannerTimer); clearTimeout(a.cardTimer);
    try {
      window.removeEventListener("keydown", a.onKeyDown);
      window.removeEventListener("keyup", a.onKeyUp);
      window.removeEventListener("resize", a.onResize);
      window.removeEventListener("orientationchange", a.onResize);
      if (a.handlers) {
        window.removeEventListener("mousemove", a.handlers.onMove);
        window.removeEventListener("mouseup", a.handlers.onUp);
      }
    } catch (e) {}
    try {
      a.scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
        }
      });
      a.renderer.dispose();
      if (a.renderer.forceContextLoss) a.renderer.forceContextLoss();
    } catch (e) {}
    if (VIS && VIS.disposeShared) VIS.disposeShared(a.shared);
    if (a.root && a.root.parentNode) a.root.parentNode.removeChild(a.root);
  }

  M.stop = teardown;

  window.Match3D = M;
})();
